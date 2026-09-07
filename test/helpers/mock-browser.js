export class MockBrowser {
  calls = [];
  tabs = [{ id: 10, url: "https://example.com/", title: "Personal", active: true, cookieStoreId: "firefox-default" }];
  nextId = 11;
  nextContainer = 1;
  documentId = "document-1";
  hook = null;

  async request(cmd, args, context) {
    this.calls.push({ cmd, args: structuredClone(args) });
    if (this.hook) await this.hook(cmd, args, context);
    context?.signal?.throwIfAborted();
    const tab = this.tabs.find((item) => item.id === args.tabId);
    switch (cmd) {
      case "session_create": return { cookieStoreId: `firefox-container-${this.nextContainer++}` };
      case "session_remove": this.tabs = this.tabs.filter((item) => item.cookieStoreId !== args.cookieStoreId); return {};
      case "tab_list": return this.tabs.filter((item) => !args.cookieStoreId || item.cookieStoreId === args.cookieStoreId).map((item) => ({ ...item }));
      case "tab_new": {
        const created = { id: this.nextId++, url: "about:blank", title: "", active: false, cookieStoreId: args.cookieStoreId || "firefox-default" };
        this.tabs.push(created);
        return { ...created };
      }
      case "tab_close": this.tabs = this.tabs.filter((item) => item.id !== args.tabId); return {};
      case "tab_switch": for (const item of this.tabs) item.active = item.id === args.tabId; return { ...tab };
      case "open": tab.url = args.url; return { url: args.url, title: tab.title };
      case "back": case "forward": case "reload": return { url: tab.url, title: tab.title };
      case "get_url": return { url: tab.url };
      case "get_title": return { title: tab.title };
      case "get_text": return { text: "Hello fixture" };
      case "read_page": return { url: tab.url, title: tab.title, html: "<html><title>Fixture</title><body><h1>Hello</h1><p>Readable fixture content.</p></body></html>" };
      case "eval": return { result: { answer: 42 } };
      case "snapshot": return { snapshot: `- button "Save" [ref=e${args.nextRef}]`, refs: { [`e${args.nextRef}`]: { role: "button", name: "Save" } }, documentId: this.documentId, nextRef: args.nextRef + 1 };
      case "screenshot": return { dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
      case "window_new": {
        const created = { id: this.nextId++, url: "about:blank", title: "", active: false, cookieStoreId: args.cookieStoreId || "firefox-default", windowId: 2 };
        this.tabs.push(created);
        return { ...created };
      }
      case "wait_for_url": {
        const current = tab || this.tabs[0];
        if (!(current.url || "").includes(args.url) && current.url !== args.url) throw Object.assign(new Error("Timeout waiting for URL"), { code: "TIMEOUT" });
        return { url: current.url, waited: true };
      }
      case "frame_switch": return { frameId: /^\d+$/.test(args.frame) ? Number(args.frame) : 0, url: tab?.url };
      case "find": return { found: true, text: args.value, clicked: args.action === "click" };
      case "is_visible": return { visible: true };
      case "is_enabled": return { enabled: true };
      case "is_checked": return { checked: false };
      case "get_attr": return { value: "https://example.com/second" };
      case "get_value": return { value: "Ada" };
      case "console": return args.clear ? { cleared: true } : { messages: [{ type: "log", text: "hello" }] };
      default:
        if (args.documentId && args.documentId !== this.documentId) throw Object.assign(new Error("Stale ref: document changed"), { code: "STALE_REF" });
        return { done: true };
    }
  }
}
