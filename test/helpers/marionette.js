// Test-only driver for a disposable Firefox/Zen profile. Never connects to a user's browser.
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function launchFirefox(executable, prefs = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "mcp-zen-firefox-"));
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const settings = { "marionette.port": port, "browser.shell.checkDefaultBrowser": false, "browser.startup.homepage": "about:blank", "browser.startup.page": 0, "datareporting.policy.dataSubmissionEnabled": false, "toolkit.telemetry.reportingpolicy.firstRun": false, ...prefs };
  await writeFile(path.join(profile, "user.js"), Object.entries(settings).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
  const child = spawn(executable, ["--headless", "--no-remote", "--profile", profile, "--marionette", "--remote-allow-system-access"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" } });
  let logs = "";
  child.stderr.on("data", (bytes) => { logs += bytes; });
  let socket;
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Firefox exited: ${logs}`);
      socket = await new Promise((resolve) => {
        const candidate = net.connect(port, "127.0.0.1");
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", () => { candidate.destroy(); resolve(null); });
      });
      if (socket) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!socket) throw new Error(`Marionette did not start: ${logs}`);
  } catch (error) { child.kill(); await rm(profile, { recursive: true, force: true }); throw error; }
  let buffer = Buffer.alloc(0);
  let next = 0;
  const pending = new Map();
  socket.on("data", (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    for (;;) {
      const colon = buffer.indexOf(58);
      if (colon === -1) return;
      const size = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + size) return;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size).toString());
      buffer = buffer.subarray(colon + 1 + size);
      if (!Array.isArray(message)) continue; // initial protocol handshake
      const entry = pending.get(message[1]);
      if (!entry) continue;
      pending.delete(message[1]); clearTimeout(entry.timer);
      message[2] ? entry.reject(new Error(JSON.stringify(message[2]))) : entry.resolve(message[3]?.value ?? message[3]);
    }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Marionette timeout: ${method}; ${logs}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    const message = JSON.stringify([0, id, method, params]);
    socket.write(`${Buffer.byteLength(message)}:${message}`);
  });
  const close = async () => {
    socket.destroy();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Firefox closed")); }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    await command("WebDriver:NewSession", { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    return { command, close };
  } catch (error) { await close(); throw error; }
}
