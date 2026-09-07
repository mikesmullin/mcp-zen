// Page-realm console capture. Injected at document_start and from page-runtime.
export function installConsole(win = window) {
  const page = win.wrappedJSObject || win;
  try {
    page.eval(`(() => {
      if (window.__mcpZenConsole) return window.__mcpZenConsole;
      const entries = [];
      const max = 1000;
      const serialize = (value) => {
        const type = value === null ? "null" : typeof value;
        if (type === "string" || type === "number" || type === "boolean") return { type, value };
        if (type === "undefined") return { type: "undefined" };
        try { return { type: "object", value: JSON.parse(JSON.stringify(value)), description: String(value) }; }
        catch { return { type: "object", description: String(value) }; }
      };
      const textOf = (args) => args.map((arg) => {
        if (typeof arg === "string") return arg;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(" ");
      const add = (level, args) => {
        if (entries.length >= max) entries.shift();
        const rec = { type: level, text: textOf(args) };
        const serialized = args.map(serialize);
        if (serialized.length) rec.args = serialized;
        entries.push(rec);
      };
      for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
        const orig = console[level] && console[level].bind(console);
        if (!orig) continue;
        console[level] = function (...args) { add(level, args); return orig(...args); };
      }
      window.__mcpZenConsole = {
        entries,
        take(clear) {
          const out = entries.slice();
          if (clear) entries.length = 0;
          return out;
        },
      };
      return window.__mcpZenConsole;
    })()`);
  } catch {}
}

if (typeof window !== "undefined") installConsole();
