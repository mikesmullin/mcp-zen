import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { coreTools, extraTools, enabledTools, upstream } from "@mcp-zen/common";
import { normalizeUrl, readContent, urlsMatch } from "./read.js";

export class CapabilityError extends Error {
  code = "UNSUPPORTED_CAPABILITY";
}
const unsupportedCommon = ["restore", "restoreSave", "restoreCheckUrl", "restoreCheckText", "restoreCheckFn", "allowedDomains", "caCert", "clearCaCert", "idleTimeout", "extraArgs"];
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
});

export function toolResult(data, error, images = []) {
  const response = error ? { success: false, error: error.message || String(error), data: { code: error.code || "BROWSER_ERROR" } } : { success: true, data };
  const stdout = JSON.stringify(response);
  const textKey = ["snapshot", "text", "html", "report", "value", "content", "title", "url", "path"].find((key) => typeof data?.[key] === "string");
  const text = error ? response.error : textKey ? data[textKey] : data && "result" in data ? JSON.stringify(data.result, null, 2) : JSON.stringify(response, null, 2);
  return {
    content: [{ type: "text", text }, ...images],
    structuredContent: { exitCode: error ? 1 : 0, stdout, stderr: "", response },
    isError: Boolean(error),
  };
}

export class AgentBrowserAdapter {
  constructor(browserApi, { screenshotDir = path.resolve("screenshots") } = {}) {
    this.api = browserApi;
    this.screenshotDir = screenshotDir;
    this.sessions = new Map();
    this.queues = new Map();
    this.barrier = Promise.resolve();
  }

  key(args) { return JSON.stringify([args.namespace || "default", args.session || "default"]); }
  session(args) {
    const key = this.key(args);
    if (!this.sessions.has(key)) this.sessions.set(key, {
      key, id: randomUUID(), name: args.session || "default", namespace: args.namespace || "default",
      isolated: (args.session || "default") !== "default" || (args.namespace || "default") !== "default",
      cookieStoreId: null, tabId: null, frameId: 0, tabs: new Map(), nextTab: 1, nextRef: 1, refs: new Map(), owned: new Set(),
    });
    return this.sessions.get(key);
  }

  async call(name, args, { signal: externalSignal } = {}) {
    const cmd = name.replace(/^agent_browser_/, "");
    const controller = new AbortController();
    const timeout = Math.min(args.timeoutMs ?? 120000, 2147483647);
    const deadline = Date.now() + timeout;
    const timer = setTimeout(() => controller.abort(Object.assign(new Error("Tool deadline exceeded"), { code: "TIMEOUT" })), timeout);
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    const context = { signal, deadline };
    let work;
    try {
      for (const key of unsupportedCommon) if (args[key] !== undefined) throw new CapabilityError(`${key} is not supported by the attached Firefox backend; it has not been applied`);
      for (const key of ["session", "namespace"]) if (args[key] !== undefined && !args[key].trim()) throw new Error(`${key} must not be empty`);
      if (cmd === "open") for (const key of ["headed", "webgpu", "webmcp"]) if (args[key] !== undefined) throw new CapabilityError(`${key} is a browser-launch option and cannot be changed on your running Zen browser`);
      if (cmd === "wait_for_load" && args.state === "networkidle") throw new CapabilityError("networkidle is not supported without network instrumentation; use load or domcontentloaded");
      if (cmd === "tools_profiles") return toolResult({
        activeProfiles: ["core", "checkout"],
        profiles: [
          { name: "core", enabled: true, tools: coreTools.map((tool) => tool.name), description: "Agent-browser core API on attached Firefox. DOM-derived snapshots and synthetic input; see docs/parity.md." },
          { name: "checkout", enabled: true, tools: extraTools.map((tool) => tool.name), description: "Frames, find/hover, dialogs, URL waits, element queries, new windows, tap/swipe, console." },
        ],
        tools: enabledTools.map((tool) => tool.name),
        upstream: { revision: upstream.revision, version: upstream.version },
      });
      if (cmd === "close" && args.all) {
        const previous = [this.barrier, ...this.queues.values()];
        work = Promise.all(previous).then(async () => {
          signal.throwIfAborted();
          for (const session of [...this.sessions.values()]) await this.closeSession(session, context);
          return toolResult({ closed: true, scope: "mcp-zen-owned tabs and containers only; personal browser remains open" });
        });
        this.barrier = work.catch(() => {});
      } else {
        const key = this.key(args);
        const barrier = this.barrier;
        work = Promise.all([this.queues.get(key), barrier]).then(async () => {
          signal.throwIfAborted();
          return this.execute(cmd, args, this.session(args), context);
        });
        const tail = work.catch(() => {});
        this.queues.set(key, tail);
        tail.finally(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
      }
      // Queue time counts toward timeout. Timed-out queued work checks signal before starting.
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    } catch (error) { return toolResult(null, error); }
    finally { clearTimeout(timer); }
  }

  request(cmd, args, context) { context.signal.throwIfAborted(); return this.api.request(cmd, args, context); }

  async list(session, context) {
    if (session.isolated && !session.cookieStoreId) {
      const created = await this.request("session_create", { name: `${session.namespace}/${session.name}` }, context);
      session.cookieStoreId = created.cookieStoreId;
    }
    const all = await this.request("tab_list", { cookieStoreId: session.cookieStoreId || undefined }, context);
    const tabs = all.filter((tab) => session.cookieStoreId ? tab.cookieStoreId === session.cookieStoreId : !tab.cookieStoreId || tab.cookieStoreId === "firefox-default");
    const live = new Set(tabs.map((tab) => tab.id));
    for (const [id] of session.tabs) if (!live.has(id)) session.tabs.delete(id);
    for (const tab of tabs) {
      let info = session.tabs.get(tab.id);
      if (!info) { info = { publicId: `t${session.nextTab++}` }; session.tabs.set(tab.id, info); }
      Object.assign(info, tab);
    }
    return tabs;
  }

  publicTab(session, id) {
    const tab = session.tabs.get(id);
    return { id: tab.publicId, targetId: `firefox:${id}`, label: tab.label || null, url: tab.url || "", title: tab.title || "", active: session.tabId === id };
  }

  async current(session, context) {
    const tabs = await this.list(session, context);
    if (session.tabId !== null) {
      if (!session.tabs.has(session.tabId)) throw Object.assign(new Error("Session tab was closed; use agent_browser_tab_switch or agent_browser_tab_new"), { code: "TAB_GONE" });
      return session.tabId;
    }
    if (tabs.length) session.tabId = (tabs.find((tab) => tab.active) || tabs[0]).id;
    else await this.newTab({}, session, context);
    return session.tabId;
  }

  async newTab(args, session, context) {
    await this.list(session, context);
    if (args.label !== undefined) {
      if (!args.label.trim() || /^t\d+$/.test(args.label) || args.label.startsWith("firefox:")) throw new Error("Tab label is empty or reserved");
      if ([...session.tabs.values()].some((tab) => tab.label === args.label)) throw new Error(`Tab label already exists: ${args.label}`);
    }
    // Validate before creating a tab. Register ownership before navigation can fail.
    const url = args.url ? normalizeUrl(args.url) : "about:blank";
    const created = await this.request("tab_new", { cookieStoreId: session.cookieStoreId || undefined }, context);
    session.owned.add(created.id);
    session.tabId = created.id;
    session.frameId = 0;
    session.tabs.set(created.id, { ...created, publicId: `t${session.nextTab++}`, label: args.label });
    session.refs.clear();
    if (url !== "about:blank") {
      const result = await this.request("open", { tabId: created.id, url }, context);
      Object.assign(session.tabs.get(created.id), result);
    }
    return this.publicTab(session, created.id);
  }

  resolveTab(session, value) {
    const matches = [...session.tabs.entries()].filter(([id, tab]) => tab.publicId === value || tab.label === value || `firefox:${id}` === value);
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous tab: ${value}`);
    return matches[0][0];
  }

  remember(session, tabId, data) {
    if (!data?.documentId || !data.refs) return;
    // Keep refs bounded and tied to the exact document, tab, and session.
    if (session.refs.size > 10000) session.refs.clear();
    const frameId = data.frameId ?? session.frameId ?? 0;
    for (const ref of Object.keys(data.refs)) session.refs.set(ref, { tabId, documentId: data.documentId, frameId });
    session.nextRef = Math.max(session.nextRef, data.nextRef || 1);
  }

  async page(cmd, args, session, context, tabId) {
    tabId ??= await this.current(session, context);
    let documentId;
    let frameId = session.frameId ?? 0;
    const target = args.selector || args.frame;
    if (target?.startsWith("@")) {
      const ref = session.refs.get(target.slice(1));
      if (!ref || ref.tabId !== tabId) throw Object.assign(new Error(`Stale or unknown ref ${target}; take a snapshot in this session/tab`), { code: "STALE_REF" });
      documentId = ref.documentId;
      frameId = ref.frameId ?? frameId;
    }
    const data = await this.request(cmd, { ...args, tabId, frameId, sessionId: session.id, documentId, nextRef: session.nextRef }, context);
    this.remember(session, tabId, data);
    return data;
  }

  async closeSession(session, context) {
    // Never claim ownership of a user's pre-existing tabs or close their browser.
    const tabs = await this.request("tab_list", {}, context);
    for (const id of [...session.owned]) {
      if (tabs.some((tab) => tab.id === id)) await this.request("tab_close", { tabId: id }, context);
      session.owned.delete(id);
    }
    if (session.cookieStoreId) await this.request("session_remove", { cookieStoreId: session.cookieStoreId }, context);
    this.sessions.delete(session.key);
  }

  async execute(cmd, args, session, context) {
    if (cmd === "wait_ms") { await sleep(args.ms, context.signal); return toolResult({ waited: args.ms }); }
    if (cmd === "close") { await this.closeSession(session, context); return toolResult({ closed: true, scope: "mcp-zen-owned tabs and containers only; personal browser remains open" }); }
    if (cmd === "tab_new") return toolResult(await this.newTab(args, session, context));
    if (cmd === "tab_list") {
      await this.list(session, context);
      return toolResult({ tabs: [...session.tabs.keys()].map((id) => this.publicTab(session, id)) });
    }
    if (cmd === "tab_switch" || cmd === "tab_close") {
      await this.list(session, context);
      const tabId = args.tab ? this.resolveTab(session, args.tab) : await this.current(session, context);
      await this.request(cmd, { tabId }, context);
      session.refs.clear();
      session.frameId = 0;
      if (cmd === "tab_switch") { session.tabId = tabId; return toolResult(this.publicTab(session, tabId)); }
      session.tabs.delete(tabId);
      session.owned.delete(tabId);
      if (session.tabId === tabId) session.tabId = null;
      return toolResult({ closed: true });
    }
    if (cmd === "read") {
      const tabId = await this.current(session, context);
      if (args.url && !args.llms) {
        const target = normalizeUrl(args.url);
        const current = await this.request("get_url", { tabId }, context);
        if (!urlsMatch(current.url, target)) {
          session.refs.clear();
          session.frameId = 0;
          const navigated = await this.request("open", { tabId, url: target }, context);
          Object.assign(session.tabs.get(tabId), navigated);
        }
      }
      return toolResult(await readContent(args, { ...context, activePage: () => this.page("read_page", {}, session, context, tabId) }));
    }
    if (cmd === "window_new") {
      await this.list(session, context);
      const created = await this.request("window_new", { cookieStoreId: session.cookieStoreId || undefined }, context);
      session.owned.add(created.id);
      session.tabId = created.id;
      session.frameId = 0;
      session.tabs.set(created.id, { ...created, publicId: `t${session.nextTab++}` });
      session.refs.clear();
      return toolResult(this.publicTab(session, created.id));
    }
    if (cmd === "frame_main") {
      await this.current(session, context);
      session.frameId = 0;
      return toolResult({ frameId: 0 });
    }
    const tabId = await this.current(session, context);
    if (cmd === "frame_switch") {
      const data = await this.page("frame_switch", args, session, context, tabId);
      session.frameId = data.frameId;
      return toolResult(data);
    }
    if (cmd === "wait_for_url") {
      return toolResult(await this.request("wait_for_url", { tabId, url: args.url, waitTimeoutMs: args.waitTimeoutMs, deadline: context.deadline }, context));
    }
    if (["open", "back", "forward", "reload"].includes(cmd)) {
      const url = cmd === "open" ? normalizeUrl(args.url ?? "about:blank") : undefined;
      session.refs.clear();
      session.frameId = 0;
      const data = await this.request(cmd, { tabId, url }, context);
      Object.assign(session.tabs.get(tabId), data);
      return toolResult(data);
    }
    if (cmd === "screenshot") {
      if (args.selector && args.fullPage) throw new Error("selector and fullPage cannot be combined");
      const format = args.format || (/\.jpe?g$/i.test(args.path || "") ? "jpeg" : "png");
      if (args.quality !== undefined && format !== "jpeg") throw new Error("quality is only valid for JPEG screenshots");
      const data = await this.page(cmd, { ...args, format }, session, context, tabId);
      const match = /^data:(image\/(?:png|jpeg));base64,([\s\S]+)$/.exec(data.dataUrl || "");
      if (!match) throw new Error("Extension returned invalid screenshot data");
      const bytes = Buffer.from(match[2], "base64");
      const filename = args.path ? path.resolve(args.path) : path.join(path.resolve(args.screenshotDir || this.screenshotDir), `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.${format === "jpeg" ? "jpg" : "png"}`);
      if (!filename.toLowerCase().endsWith(format === "png" ? ".png" : ".jpg") && !(format === "jpeg" && filename.toLowerCase().endsWith(".jpeg"))) throw new Error("Screenshot file extension does not match format");
      context.signal.throwIfAborted();
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes, { signal: context.signal });
      const images = bytes.length <= 10 * 1024 * 1024 ? [{ type: "image", data: match[2], mimeType: match[1] }] : [];
      return toolResult({ path: filename, ...(data.refs ? { refs: data.refs } : {}) }, null, images);
    }
    const data = await this.page(cmd, args, session, context, tabId);
    if (cmd === "click" && data.newTabUrl) return toolResult(await this.newTab({ url: data.newTabUrl }, session, context));
    const { documentId, nextRef, ...publicData } = data;
    return toolResult(publicData);
  }
}
