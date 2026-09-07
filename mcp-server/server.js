#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BrowserAPI } from "./browser-api.js";
import { AgentBrowserAdapter } from "./adapter.js";
import { createMcpServer } from "./mcp.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.basename(dir) === "dist" ? path.dirname(dir) : dir;
try { process.loadEnvFile(path.join(packageDir, ".env")); } catch {}
const lockPath = process.env.MCP_ZEN_LOCK || `${process.env.XDG_RUNTIME_DIR || "/tmp"}/mcp-zen.lock`;
try {
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  if (pid && pid !== process.pid) {
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
    if (alive) { console.error(`mcp-zen: already running (pid ${pid}, lock: ${lockPath})`); process.exit(1); }
  }
} catch {}
writeFileSync(lockPath, `${process.pid}\n`);
process.on("exit", () => {
  try { if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) unlinkSync(lockPath); } catch {}
});

const browserApi = new BrowserAPI();
await browserApi.init();
const adapter = new AgentBrowserAdapter(browserApi, { screenshotDir: process.env.MCP_SCREENSHOT_DIR || path.join(packageDir, "screenshots") });
const transports = new Map();
const app = express();
const port = Number(process.env.MCP_HTTP_PORT || 8791);
const hosts = process.env.CONTAINERIZED ? ["0.0.0.0"] : ["127.0.0.1", "::1"];
app.use((req, res, next) => {
  // No browser website may turn this unauthenticated local endpoint into a control API.
  if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`].includes(req.headers.origin)) {
    res.status(403).send("Origin not allowed");
    return;
  }
  if (!process.env.CONTAINERIZED && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(req.hostname)) {
    res.status(403).send("Host not allowed");
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));
app.post("/mcp", async (req, res, next) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = transports.get(sessionId);
    if (!transport && !sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => transports.set(sid, transport),
      });
      transport.onclose = () => transports.delete(transport.sessionId);
      await createMcpServer(adapter).connect(transport);
    }
    if (!transport) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid MCP session ID" }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) { next(error); }
});
const handleSession = async (req, res, next) => {
  const transport = transports.get(req.headers["mcp-session-id"]);
  if (!transport) { res.status(400).send("Invalid or missing MCP session ID"); return; }
  try { await transport.handleRequest(req, res); } catch (error) { next(error); }
};
app.get("/mcp", handleSession);
app.delete("/mcp", handleSession);
app.use((error, req, res, next) => {
  console.error("mcp-zen:", error.message);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  else next(error);
});
const httpServers = [];
for (const listenHost of hosts) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, listenHost, () => {
      const printed = listenHost === "::1" ? "[::1]" : listenHost;
      console.error(`mcp-zen: MCP HTTP server listening on http://${printed}:${server.address().port}/mcp`);
      resolve();
    });
  });
  httpServers.push(server);
}
function shutdown() {
  browserApi.close();
  for (const server of httpServers) server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
