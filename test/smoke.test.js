import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { coreTools, allTools, enabledTools, extraTools, upstream } from "@mcp-zen/common";
import { MockBrowser } from "./helpers/mock-browser.js";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const entry of ["mcp-server/server.js", "mcp-server/dist/server.js"]) {
  test(`${entry}: exact schemas and HTTP → WebSocket integration`, { timeout: 20000 }, async (t) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "mcp-zen-test-"));
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, CONTAINERIZED: "1", MCP_HTTP_PORT: "0", EXTENSION_PORT: "0", MCP_ZEN_LOCK: path.join(temp, "lock"), MCP_SCREENSHOT_DIR: temp },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let socket;
    const client = new Client({ name: "smoke", version: "1" });
    t.after(async () => {
      await client.close(); socket?.terminate();
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
      await rm(temp, { recursive: true, force: true });
    });
    const ports = await new Promise((resolve, reject) => {
      let logs = "";
      const timer = setTimeout(() => reject(new Error(logs)), 10000);
      child.once("error", reject);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
      child.stderr.on("data", (data) => {
        logs += data;
        const http = /MCP HTTP server listening on http:\/\/[^:]+:(\d+)/.exec(logs);
        const ws = /WebSocket server listening on [^:]+:(\d+)/.exec(logs);
        if (http && ws) { clearTimeout(timer); resolve({ http: http[1], ws: ws[1] }); }
      });
    });
    const mock = new MockBrowser();
    socket = new WebSocket(`ws://127.0.0.1:${ports.ws}`);
    socket.on("message", async (bytes) => {
      const req = JSON.parse(bytes);
      try { socket.send(JSON.stringify({ correlationId: req.correlationId, data: await mock.request(req.cmd, req.args) })); }
      catch (error) { socket.send(JSON.stringify({ correlationId: req.correlationId, error: { message: error.message, code: error.code } })); }
    });
    await once(socket, "open");
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ports.http}/mcp`)));
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed, enabledTools);
    assert.equal(coreTools.length, 29);
    assert.equal(extraTools.length, 18);
    assert.equal(allTools.length, 156);
    assert.deepEqual(coreTools.map((tool) => tool.name), upstream.profiles.core);
    assert.ok(extraTools.every((tool) => listed.some((item) => item.name === tool.name)));
    const call = (name, args = {}) => client.callTool({ name: `agent_browser_${name}`, arguments: args });
    const data = (result) => { assert.equal(result.isError, false, result.content[0].text); assert.equal(result.structuredContent.exitCode, 0); return result.structuredContent.response.data; };
    assert.equal(data(await call("tab_list")).tabs[0].id, "t1");
    assert.equal(data(await call("open", { url: "example.org" })).url, "https://example.org/");
    data(await call("snapshot"));
    data(await call("click", { selector: "@e1" }));
    data(await call("fill", { selector: "#input", text: "test" }));
    data(await call("type", { selector: "#input", text: "!" }));
    data(await call("press", { key: "Control+a" }));
    data(await call("check", { selector: "#checkbox" }));
    data(await call("uncheck", { selector: "#checkbox" }));
    data(await call("select", { selector: "#select", values: ["one", "two"] }));
    data(await call("scroll"));
    assert.equal(mock.calls.at(-1).args.amount, 300);
    data(await call("wait_ms", { ms: 0 }));
    data(await call("wait_for_selector", { selector: "#input", waitTimeoutMs: 10 }));
    data(await call("wait_for_text", { text: "hello" }));
    data(await call("wait_for_load", { state: "load" }));
    const screenshot = await call("screenshot");
    assert.ok(data(screenshot).path.endsWith(".png"));
    assert.equal(screenshot.content[1].type, "image");
    data(await call("get_text", { selector: "body" }));
    data(await call("get_url")); data(await call("get_title"));
    data(await call("eval", { script: "({answer:42})" }));
    data(await call("read"));
    data(await call("back")); data(await call("forward")); data(await call("reload"));
    const newTab = data(await call("tab_new", { label: "work" }));
    data(await call("tab_switch", { tab: newTab.id }));
    data(await call("tab_close"));
    data(await call("find", { locator: "text", value: "Save", action: "click" }));
    data(await call("hover", { selector: "#save" }));
    data(await call("scroll_into_view", { selector: "#save" }));
    data(await call("get_value", { selector: "#name" }));
    data(await call("get_attr", { selector: "#link", name: "href" }));
    data(await call("is_visible", { selector: "#save" }));
    data(await call("is_enabled", { selector: "#save" }));
    data(await call("is_checked", { selector: "#check" }));
    data(await call("wait_for_url", { url: "example.org" }));
    data(await call("frame_main"));
    data(await call("frame_switch", { frame: "0" }));
    data(await call("window_new"));
    data(await call("tap", { selector: "#save" }));
    data(await call("swipe", { direction: "up" }));
    data(await call("dialog_status"));
    data(await call("console"));
    data(await call("console", { clear: true }));
    data(await call("tools_profiles"));
    data(await call("close"));
    assert.equal(mock.tabs[0].id, 10, "close preserves personal tabs");
    await assert.rejects(() => client.callTool({ name: "zen_list_tabs", arguments: {} }), /Unknown tool/);
    for (const [name, args] of [["fill", { selector: "#x", value: "old" }], ["wait_ms", {}], ["wait_ms", { ms: -1 }], ["wait_ms", { ms: 0.5 }], ["select", { selector: "#x", values: [] }], ["get_url", { tabId: 10 }]]) {
      await assert.rejects(() => call(name, args));
    }
    assert.equal((await call("open", { url: "example.com", allowedDomains: ["example.com"] })).isError, true);
  });
}
