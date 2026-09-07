// Capture the real, paginated MCP API without launching or controlling a browser.
// Usage: node scripts/capture-agent-browser.js [path/to/agent-browser/checkout]
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const checkout = path.resolve(process.argv[2] || "tmp/agent-browser");
const binary = process.env.AGENT_BROWSER_BIN || path.join(checkout, "cli/target/debug/agent-browser");
const output = new URL("../common/agent-browser/", import.meta.url);
await mkdir(output, { recursive: true });

async function capture(profile) {
  const child = spawn(binary, ["mcp", "--tools", profile], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let next = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(JSON.stringify(response.error)));
    else entry.resolve(response.result);
  });
  const fail = (error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Upstream MCP process exited")));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "schema-capture", version: "1" } });
    const tools = [];
    let cursor;
    do {
      const page = await request("tools/list", cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
  }
}

const profiles = {};
for (const profile of ["core", "network", "state", "debug", "tabs", "react", "mobile", "webmcp", "all"]) {
  const tools = await capture(profile);
  profiles[profile] = tools.map((tool) => tool.name);
  if (["core", "all"].includes(profile)) {
    await writeFile(new URL(`${profile}.json`, output), JSON.stringify(tools, null, 2) + "\n");
  }
  console.log(`${profile}: ${tools.length} tools`);
}
const source = await readFile(path.join(checkout, "cli/src/mcp.rs"));
const pkg = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
await writeFile(new URL("upstream.json", output), JSON.stringify({
  repository: "https://github.com/vercel-labs/agent-browser",
  revision: execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  version: pkg.version,
  source: "cli/src/mcp.rs",
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  capture: "Actual MCP initialize + paginated tools/list, one process per profile",
  profiles,
}, null, 2) + "\n");
await copyFile(path.join(checkout, "LICENSE"), new URL("LICENSE", output));
