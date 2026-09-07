// Browser operations are separate from public tool schemas and session bookkeeping.
export class MessageHandler {
  constructor(api = browser, allowed = new Set()) {
    this.browser = api;
    this.allowed = allowed;
    this.captureQueue = Promise.resolve();
  }

  async permission() {
    if (!await this.browser.permissions.contains({ origins: ["<all_urls>"] })) {
      throw new Error("Browser automation permission is missing. Open extension options and enable browser automation.");
    }
  }

  async page(cmd, args, context) {
    await this.permission();
    if (!Number.isInteger(args.tabId)) throw new Error("An explicit tabId is required");
    const frameId = Number.isInteger(args.frameId) ? args.frameId : 0;
    await this.browser.tabs.executeScript(args.tabId, { file: "dist/page-runtime.js", frameId });
    const code = `(async () => {
      try {
        return { ok: true, data: await window.__mcpZenRuntime.run(${JSON.stringify(cmd)}, ${JSON.stringify(args)}, ${JSON.stringify(context)}) };
      } catch (error) {
        return { ok: false, error: { code: error.code || "PAGE_ERROR", message: String(error.message || error) } };
      }
    })()`;
    const [result] = await this.browser.tabs.executeScript(args.tabId, { code, frameId });
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "Page returned no result"), { code: result?.error?.code || "PAGE_ERROR" });
    return result.data;
  }

  async navigation(cmd, args, deadline) {
    const tabs = this.browser.tabs;
    const navigation = this.browser.webNavigation;
    // Subscribe before initiating navigation. tabs.update/get can still report
    // the OLD complete document immediately after accepting a navigation.
    let finish;
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Navigation timed out")), Math.min(Math.max(deadline - Date.now(), 1), 2147483647));
      let started = false;
      let navigationUrl;
      const relevant = (event) => event.tabId === args.tabId && event.frameId === 0;
      const before = (event) => {
        if (relevant(event) && (started || cmd !== "open" || event.url === args.url)) {
          started = true;
          navigationUrl = event.url;
        }
      };
      const complete = (event) => {
        if (!relevant(event) || !started || (event.url === "about:blank" && navigationUrl !== "about:blank")) return;
        tabs.get(args.tabId).then((tab) => finish(null, { ...tab, url: event.url }), finish);
      };
      const sameDocument = (event) => {
        if (!relevant(event) || (cmd === "open" && event.url !== args.url)) return;
        tabs.get(args.tabId).then((tab) => finish(null, { ...tab, url: event.url }), finish);
      };
      const failed = (event) => {
        // Firefox emits NS_BINDING_ABORTED during normal process switches. Wait
        // for the replacement document; a genuine abandoned navigation times out.
        if (/NS_BINDING_ABORTED|2152398850/.test(event.error)) return;
        if (relevant(event) && started && event.url === navigationUrl) finish(new Error(`Navigation failed: ${event.error} (${event.url})`));
      };
      const removed = (id) => { if (id === args.tabId) finish(new Error("Tab was closed during navigation")); };
      finish = (error, tab) => {
        clearTimeout(timer);
        navigation.onBeforeNavigate.removeListener(before);
        navigation.onCompleted.removeListener(complete);
        navigation.onHistoryStateUpdated.removeListener(sameDocument);
        navigation.onReferenceFragmentUpdated.removeListener(sameDocument);
        navigation.onErrorOccurred.removeListener(failed);
        tabs.onRemoved.removeListener(removed);
        error ? reject(error) : resolve(tab);
      };
      navigation.onBeforeNavigate.addListener(before);
      navigation.onCompleted.addListener(complete);
      navigation.onHistoryStateUpdated.addListener(sameDocument);
      navigation.onReferenceFragmentUpdated.addListener(sameDocument);
      navigation.onErrorOccurred.addListener(failed);
      tabs.onRemoved.addListener(removed);
    });
    // Attach rejection handling immediately, including when the action itself fails.
    loaded.catch(() => {});
    try {
      if (cmd === "open") await tabs.update(args.tabId, { url: args.url });
      else if (cmd === "back") await tabs.goBack(args.tabId);
      else if (cmd === "forward") await tabs.goForward(args.tabId);
      else await tabs.reload(args.tabId);
      const result = await loaded;
      return { url: result.url, title: result.title || "" };
    } catch (error) {
      finish(error);
      throw error;
    }
  }

  async capture(args, context) {
    const task = this.captureQueue.catch(() => {}).then(async () => {
      if (Date.now() >= context.deadline) throw new Error("Screenshot deadline exceeded");
      await this.permission();
      let prepared;
      try {
        prepared = await this.page("screenshot_prepare", args, context);
        // Firefox captureTab can capture background tabs and document-coordinate rects.
        // Unlike captureVisibleTab, it doesn't switch the user's foreground tab.
        if (!this.browser.tabs.captureTab) throw Object.assign(new Error("This Firefox version does not support tabs.captureTab"), { code: "UNSUPPORTED_CAPABILITY" });
        const options = { format: args.format || "png" };
        if (args.quality !== undefined) options.quality = args.quality;
        if (prepared.rect) options.rect = prepared.rect;
        const dataUrl = await this.browser.tabs.captureTab(args.tabId, options);
        return { ...prepared, dataUrl };
      } finally {
        if (args.annotate) {
          await this.page("screenshot_cleanup", args, { ...context, deadline: Date.now() + 2000 }).catch(() => {});
        }
      }
    });
    this.captureQueue = task.catch(() => {});
    return task;
  }

  async console(args, context) {
    await this.permission();
    if (!Number.isInteger(args.tabId)) throw new Error("An explicit tabId is required");
    await this.browser.tabs.executeScript(args.tabId, { file: "dist/page-runtime.js", allFrames: true });
    const code = `(async () => {
      try {
        return { ok: true, data: await window.__mcpZenRuntime.run("console", ${JSON.stringify(args)}, ${JSON.stringify(context)}) };
      } catch (error) {
        return { ok: false, error: { code: error.code || "PAGE_ERROR", message: String(error.message || error) } };
      }
    })()`;
    const results = await this.browser.tabs.executeScript(args.tabId, { code, allFrames: true });
    if (args.clear) return { cleared: true };
    const messages = [];
    for (const result of results || []) {
      if (result?.ok && Array.isArray(result.data?.messages)) messages.push(...result.data.messages);
    }
    return { messages };
  }

  async switchFrame(args, context) {
    if (!this.browser.webNavigation?.getAllFrames) throw Object.assign(new Error("webNavigation.getAllFrames is unavailable"), { code: "UNSUPPORTED_CAPABILITY" });
    const frames = await this.browser.webNavigation.getAllFrames({ tabId: args.tabId });
    const current = Number.isInteger(args.frameId) ? args.frameId : 0;
    if (!args.frame || args.frame === "main" || args.frame === "0") return { frameId: 0, url: frames.find((frame) => frame.frameId === 0)?.url };
    if (/^\d+$/.test(args.frame)) {
      const frameId = Number(args.frame);
      const match = frames.find((frame) => frame.frameId === frameId);
      if (!match) throw new Error(`Unknown frame id: ${args.frame}`);
      return { frameId, url: match.url };
    }
    const info = await this.page("frame_info", { ...args, selector: args.frame }, context);
    const children = frames.filter((frame) => frame.parentFrameId === current);
    const byUrl = children.filter((frame) => frame.url === info.src || frame.url === info.href || stripHash(frame.url) === stripHash(info.src));
    const match = byUrl.length === 1 ? byUrl[0] : children[info.index];
    if (!match) throw new Error(`Could not resolve iframe ${args.frame} to a browser frame`);
    return { frameId: match.frameId, url: match.url };
  }

  async execute(req) {
    const { cmd, args = {}, deadline } = req;
    if (!this.allowed.has(cmd)) throw new Error(`Command '${cmd}' is disabled (see allowed-tools.yaml)`);
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("Tool deadline exceeded");
    const context = { sessionId: args.sessionId, documentId: args.documentId, deadline };
    const tabs = this.browser.tabs;
    switch (cmd) {
      case "tab_list": {
        const result = await tabs.query(args.cookieStoreId ? { cookieStoreId: args.cookieStoreId } : {});
        return result.map(({ id, url, title, active, windowId, cookieStoreId }) => ({ id, url, title, active, windowId, cookieStoreId }));
      }
      case "tab_new": {
        const options = { url: args.url || "about:blank", active: false };
        if (args.cookieStoreId) options.cookieStoreId = args.cookieStoreId;
        const tab = await tabs.create(options);
        return { id: tab.id, url: tab.url, title: tab.title, cookieStoreId: tab.cookieStoreId };
      }
      case "tab_switch": {
        const tab = await tabs.update(args.tabId, { active: true });
        return { id: tab.id, url: tab.url, title: tab.title };
      }
      case "tab_close": await tabs.remove(args.tabId); return { closed: true };
      case "session_create": {
        if (!await this.browser.permissions.contains({ permissions: ["cookies"] })) {
          throw Object.assign(new Error("Named isolated sessions require the cookies permission. Enable isolated sessions in extension options."), { code: "MISSING_PERMISSION" });
        }
        const container = await this.browser.contextualIdentities.create({ name: `mcp-zen: ${args.name}`, color: "blue", icon: "fingerprint" });
        return { cookieStoreId: container.cookieStoreId };
      }
      case "session_remove": await this.browser.contextualIdentities.remove(args.cookieStoreId); return { closed: true };
      case "open": case "back": case "forward": case "reload": return this.navigation(cmd, args, deadline);
      case "get_url": { const tab = await tabs.get(args.tabId); return { url: tab.url }; }
      case "get_title": { const tab = await tabs.get(args.tabId); return { title: tab.title || "" }; }
      case "window_new": {
        const options = { focused: false };
        if (args.cookieStoreId) options.cookieStoreId = args.cookieStoreId;
        const created = await this.browser.windows.create(options);
        const tab = created.tabs?.[0];
        if (!tab?.id) throw new Error("New window did not contain a tab");
        return { id: tab.id, url: tab.url, title: tab.title, windowId: created.id, cookieStoreId: tab.cookieStoreId };
      }
      case "wait_for_url": {
        const waitDeadline = Math.min(deadline, Date.now() + (args.waitTimeoutMs ?? 25000));
        while (Date.now() < waitDeadline) {
          const tab = await tabs.get(args.tabId);
          if (urlMatches(tab.url || "", args.url)) return { url: tab.url, waited: true };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw Object.assign(new Error(`Wait timed out after ${args.waitTimeoutMs ?? 25000}ms`), { code: "TIMEOUT" });
      }
      case "frame_switch": return this.switchFrame(args, context);
      case "screenshot": return this.capture(args, context);
      case "console": return this.console(args, context);
      default: return this.page(cmd, args, context);
    }
  }
}

function stripHash(url) {
  return String(url || "").replace(/#.*$/, "");
}

export function urlMatches(url, pattern) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return url.includes(pattern);
  let collapsed = "";
  let star = false;
  for (const ch of pattern) {
    if (ch === "*") { if (!star) collapsed += ch; star = true; }
    else { collapsed += ch; star = false; }
  }
  const parts = collapsed.split("*").filter(Boolean);
  if (!parts.length) return true;
  const anchoredStart = !collapsed.startsWith("*");
  const anchoredEnd = !collapsed.endsWith("*");
  let pos = 0;
  let idx = 0;
  if (anchoredStart) {
    if (!url.startsWith(parts[0])) return false;
    pos = parts[0].length;
    idx = 1;
  }
  while (idx < parts.length) {
    const found = url.slice(pos).indexOf(parts[idx]);
    if (found < 0) return false;
    pos += found + parts[idx].length;
    idx++;
  }
  return !anchoredEnd || url.endsWith(parts.at(-1));
}
