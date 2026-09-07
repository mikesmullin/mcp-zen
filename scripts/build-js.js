// Keep legacy dist entry points available without a compiler.
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";

const workspace = process.argv[2];
if (!["common", "mcp-server"].includes(workspace)) {
  throw new Error("Expected workspace: common or mcp-server");
}
const source = new URL(`../${workspace}/`, import.meta.url);
const dist = new URL("dist/", source);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
if (workspace === "common") {
  await cp(new URL("agent-browser/", source), new URL("agent-browser/", dist), { recursive: true });
}
for (const name of await readdir(source)) {
  if (name.endsWith(".js")) {
    await copyFile(new URL(name, source), new URL(name, dist));
  }
}
