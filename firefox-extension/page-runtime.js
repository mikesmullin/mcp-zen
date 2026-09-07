// Runs in the extension's isolated content-script world, once per document.
import { computeAccessibleName, getRole, isInaccessible } from "dom-accessibility-api";
import { installConsole } from "./console-hook.js";

export function installRuntime(win = window) {
  if (win.__mcpZenRuntime) return win.__mcpZenRuntime;
  const doc = win.document;
  // randomUUID is secure-context-only; automation must also work on plain HTTP.
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const sessions = new Map();
  const interactiveRoles = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem"]);
  const contentRoles = new Set(["heading", "img", "cell", "columnheader", "rowheader"]);
  const fail = (message, code = "ELEMENT_ERROR") => { throw Object.assign(new Error(message), { code }); };
  const checkDeadline = (deadline) => {
    if (Date.now() >= deadline) fail("Tool deadline exceeded", "TIMEOUT");
  };
  const sleep = (ms, deadline) => new Promise((resolve, reject) => {
    if (Date.now() >= deadline) return reject(Object.assign(new Error("Tool deadline exceeded"), { code: "TIMEOUT" }));
    setTimeout(() => {
      try { checkDeadline(deadline); resolve(); } catch (error) { reject(error); }
    }, Math.min(ms, deadline - Date.now()));
  });
  // Bind Window methods explicitly for Firefox's Xray content-script wrappers.
  const accessibilityOptions = { getComputedStyle: win.getComputedStyle.bind(win) };
  const inaccessible = (el) => isInaccessible(el, accessibilityOptions);
  const visible = (el) => Boolean(el && el.offsetWidth > 0 && el.offsetHeight > 0);
  function sessionFor(id) {
    if (!sessions.has(id)) sessions.set(id, new Map());
    return sessions.get(id);
  }
  function queryFirst(selector) {
    if (selector.startsWith("xpath=")) {
      return doc.evaluate(selector.slice(6), doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }
    try { return doc.querySelector(selector); }
    catch { fail(`Invalid CSS selector: ${selector}`, "INVALID_SELECTOR"); }
  }
  function resolve(selector, context, allowMissing = false) {
    if (typeof selector !== "string" || !selector.trim()) fail("A nonempty selector is required", "INVALID_SELECTOR");
    let el;
    if (selector.startsWith("@")) {
      if (context.documentId && context.documentId !== documentId) fail(`Stale ref ${selector}: document changed; take a new snapshot`, "STALE_REF");
      el = sessionFor(context.sessionId).get(selector.slice(1));
      if (!el?.isConnected) fail(`Stale or unknown ref ${selector}; take a new snapshot`, "STALE_REF");
    } else el = queryFirst(selector);
    if (!el && !allowMissing) fail(`Element not found: ${selector}`);
    return el;
  }
  function inView(rect) {
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < (win.innerHeight || doc.documentElement.clientHeight) && rect.left < (win.innerWidth || doc.documentElement.clientWidth);
  }
  function blockerAt(el, x, y) {
    let d = doc, lx = x, ly = y;
    let hit = d.elementFromPoint(lx, ly);
    while (hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME") && hit.contentDocument && hit !== el) {
      const r = hit.getBoundingClientRect();
      lx -= r.x + hit.clientLeft;
      ly -= r.y + hit.clientTop;
      d = hit.contentDocument;
      hit = d.elementFromPoint(lx, ly);
    }
    if (!hit || hit === el) return null;
    const up = (n) => n.parentNode || n.host || n.getRootNode?.()?.host || null;
    for (let n = hit; n; n = up(n)) if (n === el) return null;
    for (let n = el; n; n = up(n)) if (n === hit) return null;
    const hitLabel = hit.closest?.("label");
    if (hitLabel && (hitLabel.control === el || hitLabel.contains(el))) return null;
    const elLabel = el.closest?.("label");
    if (elLabel && elLabel.contains(hit)) return null;
    let desc = hit.tagName.toLowerCase();
    if (hit.id) desc += `#${hit.id}`;
    else if (typeof hit.className === "string" && hit.className.trim()) desc += `.${hit.className.trim().split(/\s+/).slice(0, 2).join(".")}`;
    if (!hit.id && hit.closest) {
      const anchored = hit.closest("[id]");
      if (anchored && anchored !== hit) desc += ` inside ${anchored.tagName.toLowerCase()}#${anchored.id}`;
    }
    return desc;
  }
  function aim(el, selector) {
    let rect = el.getBoundingClientRect();
    if (!inView(rect)) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      rect = el.getBoundingClientRect();
    }
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const blocker = blockerAt(el, x, y);
    if (blocker) fail(`Element '${selector}' is covered by <${blocker}> at its click point, so the input would land on that element instead. Dismiss or interact with the covering element first (it is often a dialog, banner, or sticky header).`, "COVERED");
    return { x, y };
  }
  function mouseAt(x, y, type, extra = {}) {
    const target = doc.elementFromPoint(x, y) || doc.body;
    const init = { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y, buttons: extra.buttons ?? 0, button: extra.button ?? 0, detail: extra.detail ?? 0 };
    target.dispatchEvent(new win.PointerEvent(type.replace("mouse", "pointer"), { ...init, pointerType: extra.pointerType || "mouse" }));
    target.dispatchEvent(new win.MouseEvent(type, init));
    return target;
  }
  function clickAt(el, selector) {
    const { x, y } = aim(el, selector);
    mouseAt(x, y, "mousemove");
    mouseAt(x, y, "mousedown", { buttons: 1, button: 0, detail: 1 });
    mouseAt(x, y, "mouseup", { buttons: 0, button: 0, detail: 1 });
    // Untrusted mouse events do not activate native controls; after the overlay
    // check, click the target itself (CDP's trusted click equivalent here).
    el.click();
  }
  function editable(el) {
    if (el.matches(":disabled") || el.readOnly || el.getAttribute("aria-disabled") === "true") fail("Element is disabled or read-only");
    if (!visible(el)) fail("Element is not visible");
    if (!(el.matches("input,textarea") || el.isContentEditable)) fail("Element is not editable");
    if (el.matches('input[type="file"],input[type="checkbox"],input[type="radio"]')) fail("Element is not a text field");
  }
  function setValue(el, value) {
    if (el.isContentEditable) el.textContent = value;
    else {
      const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    }
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }
  const valueOf = (el) => el.isContentEditable ? el.textContent : el.value;
  const nameOf = (el) => computeAccessibleName(el, accessibilityOptions).replace(/\s+/g, " ").trim();
  const enabled = (el) => !(el.matches(":disabled") || el.getAttribute("aria-disabled") === "true");
  const checkedOf = (el) => el.matches('input[type="checkbox"],input[type="radio"]') ? el.checked : el.getAttribute("aria-checked") === "true";
  function hover(el, selector = el.tagName) {
    const { x, y } = aim(el, selector);
    mouseAt(x, y, "mouseover");
    mouseAt(x, y, "mousemove");
  }
  function pointer(el, type, extra = {}) {
    const box = el.getBoundingClientRect();
    const x = extra.clientX ?? box.left + box.width / 2;
    const y = extra.clientY ?? box.top + box.height / 2;
    const init = { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y, ...extra };
    el.dispatchEvent(new win.PointerEvent(type, { ...init, pointerType: extra.pointerType || "mouse" }));
    if (type.startsWith("mouse") || type.startsWith("pointer")) el.dispatchEvent(new win.MouseEvent(type.replace("pointer", "mouse"), init));
  }
  function installDialogs() {
    const page = win.wrappedJSObject || win;
    try {
      page.eval(`(() => {
        if (window.__mcpZenDialogHooked) return;
        window.__mcpZenDialogHooked = true;
        window.__mcpZenDialog = { pending: null };
        const hold = (type, message, defaultValue) => {
          const pending = { type, message: String(message ?? ""), defaultValue: String(defaultValue ?? ""), reply: null };
          window.__mcpZenDialog.pending = pending;
          const start = Date.now();
          while (pending.reply == null && Date.now() - start < 120000) {}
          window.__mcpZenDialog.pending = null;
          return pending.reply || { accept: false, text: "" };
        };
        window.alert = (message) => { hold("alert", message); };
        window.confirm = (message) => Boolean(hold("confirm", message).accept);
        window.prompt = (message, defaultValue) => {
          const reply = hold("prompt", message, defaultValue);
          return reply.accept ? reply.text : null;
        };
      })()`);
    } catch {}
  }
  installDialogs();
  installConsole(win);
  function textOf(el) {
    return (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }
  function cssAttr(name, value) {
    return `[${name}=${JSON.stringify(value)}]`;
  }
  function queryAttr(selector) {
    try { return doc.querySelector(selector); }
    catch { return null; }
  }
  function normalizeWs(value) {
    return String(value || "").trim().split(/\s+/).join(" ");
  }
  function normalizeRole(role) {
    const lower = String(role || "").toLowerCase();
    if (lower === "image") return "img";
    if (lower === "rootwebarea") return "document";
    return lower;
  }
  // Faithful port of agent-browser handle_semantic_locator / getByRole / nth:
  // first match wins, no visibility filter, no accessible-name fallback on text.
  function findElement(args) {
    const exact = Boolean(args.exact);
    const needle = String(args.value ?? "");
    const locator = args.locator;
    const mark = (el) => el;
    if (locator === "first" || locator === "last" || locator === "nth") {
      let els;
      try { els = doc.querySelectorAll(needle); }
      catch { fail(`Invalid CSS selector: ${needle}`, "INVALID_SELECTOR"); }
      const raw = locator === "first" ? 0 : locator === "last" ? -1 : (args.index ?? 0);
      const idx = raw < 0 ? els.length + raw : raw;
      const el = els[idx];
      if (!el) fail(locator === "nth" ? `No element at index ${args.index ?? 0} for selector '${needle}'` : `No element found by ${locator} '${needle}'`);
      return mark(el);
    }
    if (locator === "placeholder") {
      const el = queryAttr(`input${cssAttr("placeholder", needle)}, textarea${cssAttr("placeholder", needle)}`);
      if (!el) fail(`No element found by placeholder '${needle}'`);
      return mark(el);
    }
    if (locator === "alt") {
      const el = queryAttr(`img${cssAttr("alt", needle)}, ${cssAttr("alt", needle)}`);
      if (!el) fail(`No element found by alttext '${needle}'`);
      return mark(el);
    }
    if (locator === "title") {
      const el = queryAttr(cssAttr("title", needle));
      if (!el) fail(`No element found by title '${needle}'`);
      return mark(el);
    }
    if (locator === "testid") {
      const el = queryAttr(cssAttr("data-testid", needle));
      if (!el) fail(`No element found by testid '${needle}'`);
      return mark(el);
    }
    if (locator === "label") {
      const matches = exact ? (s) => !!s && s.trim() === needle : (s) => !!s && s.includes(needle);
      const label = [...doc.querySelectorAll("label")].find((el) => matches(el.textContent));
      if (label) {
        const forId = label.getAttribute("for");
        const target = forId ? doc.getElementById(forId) : label.querySelector("input,select,textarea");
        if (target) return mark(target);
      }
      const aria = [...doc.querySelectorAll("[aria-label]")].find((el) => matches(el.getAttribute("aria-label")));
      if (aria) return mark(aria);
      const referenced = [...doc.querySelectorAll("[aria-labelledby]")].find((el) => {
        const text = (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join(" ");
        return matches(text);
      });
      if (referenced) return mark(referenced);
      fail(`No element found by label '${needle}'`);
    }
    if (locator === "text") {
      for (const el of doc.querySelectorAll("*")) {
        if (el.children.length !== 0) continue;
        const content = el.textContent || "";
        const hit = exact ? content.trim() === needle : content.includes(needle);
        if (hit) return mark(el);
      }
      fail(`No element found by text '${needle}'`);
    }
    if (locator === "role") {
      const role = normalizeRole(needle);
      const presentational = role === "none" || role === "presentation" || role === "directory";
      const namesSeen = [];
      const namesSet = new Set();
      let roleMatchCount = 0;
      if (presentational) {
        const valid = new Set(["alert","alertdialog","application","article","banner","blockquote","button","caption","cell","checkbox","code","columnheader","combobox","complementary","contentinfo","definition","deletion","dialog","directory","document","emphasis","feed","figure","form","generic","grid","gridcell","group","heading","img","insertion","link","list","listbox","listitem","log","main","mark","marquee","math","meter","menu","menubar","menuitem","menuitemcheckbox","menuitemradio","navigation","none","note","option","paragraph","presentation","progressbar","radio","radiogroup","region","row","rowgroup","rowheader","scrollbar","search","searchbox","separator","slider","spinbutton","status","strong","subscript","superscript","switch","tab","table","tablist","tabpanel","term","textbox","time","timer","toolbar","tooltip","tree","treegrid","treeitem"]);
        const globalAria = new Set(["aria-atomic","aria-busy","aria-controls","aria-current","aria-describedby","aria-description","aria-details","aria-disabled","aria-dropeffect","aria-errormessage","aria-flowto","aria-grabbed","aria-haspopup","aria-hidden","aria-invalid","aria-keyshortcuts","aria-label","aria-labelledby","aria-live","aria-owns","aria-relevant","aria-roledescription"]);
        for (const el of doc.querySelectorAll("[role]")) {
          const tokens = (el.getAttribute("role") || "").trim().toLowerCase().split(/\s+/);
          const operative = tokens.find((token) => valid.has(token));
          if (operative !== role) continue;
          if ((role === "none" || role === "presentation") && (el.tabIndex >= 0 || el.hasAttribute("tabindex") || [...el.getAttributeNames()].some((name) => globalAria.has(name)))) continue;
          const name = normalizeWs(nameOf(el));
          const wanted = args.name;
          const hit = wanted == null ? true : exact ? name === normalizeWs(wanted) : name.toLowerCase().includes(normalizeWs(wanted).toLowerCase());
          if (hit) return mark(el);
        }
        fail(`No element found: getByRole('${needle}'${args.name ? `, { name: '${args.name}'${exact ? ", exact: true" : ""} }` : ""})`);
      }
      for (const el of doc.querySelectorAll("*")) {
        const nodeRole = normalizeRole(getRole(el) || (el.tagName === "IFRAME" ? "iframe" : ""));
        if (nodeRole !== role) continue;
        const nodeName = normalizeWs(nameOf(el));
        const wanted = args.name;
        const hit = wanted == null ? true : exact ? nodeName === normalizeWs(wanted) : nodeName.toLowerCase().includes(normalizeWs(wanted).toLowerCase());
        if (!hit) {
          roleMatchCount++;
          if (!namesSet.has(nodeName)) { namesSet.add(nodeName); namesSeen.push(nodeName); }
          continue;
        }
        return mark(el);
      }
      if (args.name && namesSeen.length) {
        const shown = namesSeen.slice(0, 5).map((name) => `"${name}"`).join(", ");
        const more = namesSeen.length > 5 ? ", ..." : "";
        const plural = roleMatchCount === 1 ? "" : "s";
        const verb = roleMatchCount === 1 ? "has" : "have";
        fail(`${roleMatchCount} element${plural} ${verb} role "${needle}", but none match name "${args.name}". Names seen: ${shown}${more}`);
      }
      fail(`No element found: getByRole('${needle}'${args.name ? `, { name: '${args.name}'${exact ? ", exact: true" : ""} }` : ""})`);
    }
    fail(`Unknown find locator: ${locator}`);
  }

  function snapshot(args, context) {
    const scope = args.selector ? resolve(args.selector, context) : doc.body;
    if (!scope) fail("Page has no body");
    const refs = {};
    const registry = sessionFor(context.sessionId);
    // Bound retained references per session/document. Old refs fail explicitly.
    if (registry.size > 10000) registry.clear();
    let nextRef = args.nextRef || 1;
    const lines = [];
    const annotations = [];
    function walk(el, depth) {
      if (args.depth !== undefined && depth > args.depth) return;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName) || inaccessible(el)) return;
      let role = getRole(el);
      if (!role && el.isContentEditable) role = "textbox";
      if (!role && ["IFRAME", "FRAME"].includes(el.tagName)) role = "iframe";
      const name = role ? nameOf(el) : "";
      const interactive = interactiveRoles.has(role) || el.tabIndex >= 0 || el.isContentEditable || role === "iframe";
      const hasRef = interactive || (contentRoles.has(role) && name);
      if (args.interactive !== false && !hasRef) {
        for (const child of el.children) walk(child, depth);
        if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, depth);
        return;
      }
      const include = args.interactive !== false ? hasRef : Boolean(role || (!args.compact && el.children.length));
      if (include) {
        let line = `- ${role || "generic"}`;
        if (name) line += ` ${JSON.stringify(name)}`;
        if (hasRef) {
          const ref = `e${nextRef++}`;
          registry.set(ref, el);
          refs[ref] = { role: role || "generic", name };
          line += ` [ref=${ref}]`;
          annotations.push({ ref, el });
        }
        if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") line += " [disabled]";
        if (el.checked || el.getAttribute("aria-checked") === "true") line += " [checked]";
        if (el.selected || el.getAttribute("aria-selected") === "true") line += " [selected]";
        if (el.getAttribute("aria-expanded") !== null) line += ` [expanded=${el.getAttribute("aria-expanded")}]`;
        if (/^H[1-6]$/.test(el.tagName)) line += ` [level=${el.tagName.slice(1)}]`;
        if (args.includeUrls && el.href) line += `\n${"  ".repeat(depth + 1)}- /url: ${el.href}`;
        if (args.interactive === false && el.matches("input,textarea") && el.type !== "password" && el.value) line += `: ${JSON.stringify(el.value)}`;
        lines.push("  ".repeat(depth) + line);
      }
      if (args.interactive === false && !interactive) {
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && node.textContent.trim()) lines.push(`${"  ".repeat(depth + 1)}- text: ${node.textContent.trim()}`);
        }
      }
      for (const child of el.children) walk(child, depth + 1);
      if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, depth + 1);
    }
    walk(scope, 0);
    return { data: { snapshot: lines.join("\n") || "(empty)", refs, documentId, nextRef }, annotations };
  }

  async function run(cmd, args = {}, context = {}) {
    const deadline = context.deadline || Date.now() + 120000;
    checkDeadline(deadline);
    if (cmd === "snapshot") return snapshot(args, context).data;
    if (cmd === "get_url") return { url: win.location.href };
    if (cmd === "get_title") return { title: doc.title };
    if (cmd === "read_page") return { html: doc.documentElement.outerHTML, url: win.location.href, title: doc.title };
    if (cmd === "get_text") {
      const el = resolve(args.selector, context);
      return { text: (el.innerText ?? el.textContent ?? "").toString() };
    }
    if (cmd === "eval") {
      // Firefox's wrappedJSObject executes against the page realm (not extension globals).
      const page = win.wrappedJSObject || win;
      let timer;
      try {
        const value = await Promise.race([
          Promise.resolve(page.eval(args.script)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Evaluation timed out"), { code: "TIMEOUT" })), Math.min(deadline - Date.now(), 2147483647)); }),
        ]);
        return { result: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
      } finally { clearTimeout(timer); }
    }
    if (cmd.startsWith("wait_for_")) {
      const waitDeadline = Math.min(deadline, Date.now() + (args.waitTimeoutMs ?? 25000));
      if (cmd === "wait_for_load" && args.state === "networkidle") fail("networkidle requires network instrumentation and is not supported by this backend", "UNSUPPORTED_CAPABILITY");
      for (;;) {
        checkDeadline(waitDeadline);
        let found = false;
        if (cmd === "wait_for_selector") {
          const el = resolve(args.selector, context, true);
          found = Boolean(el && visible(el) && inView(el.getBoundingClientRect()));
        } else if (cmd === "wait_for_text") found = (doc.body?.innerText || "").includes(args.text);
        else if (cmd === "wait_for_load") found = args.state === "load" ? doc.readyState === "complete" : doc.readyState !== "loading";
        if (found) return { waited: true };
        await sleep(50, waitDeadline);
      }
    }
    if (cmd === "scroll") {
      const target = args.selector ? resolve(args.selector, context) : win;
      const amount = args.amount ?? 300;
      const direction = args.direction ?? "down";
      target.scrollBy({ left: direction === "left" ? -amount : direction === "right" ? amount : 0, top: direction === "up" ? -amount : direction === "down" ? amount : 0, behavior: "instant" });
      return { scrolled: true };
    }
    if (cmd === "press") {
      const parts = args.key.split("+");
      const key = parts.pop();
      const aliases = { Ctrl: "Control", Cmd: "Meta", Command: "Meta" };
      const mods = parts.map((part) => aliases[part] || part);
      if (!key || mods.some((mod) => !["Control", "Meta", "Alt", "Shift"].includes(mod))) fail(`Unsupported key chord: ${args.key}`, "INVALID_KEY");
      const target = doc.activeElement || doc.body;
      const init = { key, bubbles: true, cancelable: true, ctrlKey: mods.includes("Control"), metaKey: mods.includes("Meta"), shiftKey: mods.includes("Shift"), altKey: mods.includes("Alt") };
      const proceed = target.dispatchEvent(new win.KeyboardEvent("keydown", init));
      // Explicitly emulate common editing/focus defaults; events remain untrusted.
      if (proceed) {
        if ((init.ctrlKey || init.metaKey) && key.toLowerCase() === "a" && typeof target.select === "function") target.select();
        else if (key === "Tab") {
          const focusable = [...doc.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && visible(el));
          if (focusable.length) {
            const index = focusable.indexOf(target);
            focusable[(index + (init.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
          }
        } else if (key === "Enter" && target.matches("button,a[href],input[type=submit]")) target.click();
        else if (key === "Enter" && target.matches("input") && target.form) target.form.requestSubmit();
        else if (["Backspace", "Delete"].includes(key) && target.matches("input,textarea")) {
          editable(target);
          let start = target.selectionStart ?? target.value.length;
          let end = target.selectionEnd ?? start;
          if (start === end) { if (key === "Backspace") start = Math.max(0, start - 1); else end++; }
          setValue(target, target.value.slice(0, start) + target.value.slice(end));
          target.setSelectionRange?.(start, start);
        }
      }
      target.dispatchEvent(new win.KeyboardEvent("keyup", init));
      return { pressed: args.key, synthetic: true };
    }
    if (cmd === "screenshot_prepare") {
      let rect;
      if (args.selector) {
        const el = resolve(args.selector, context);
        if (!visible(el)) fail("Screenshot target is not visible");
        const box = el.getBoundingClientRect();
        rect = { x: box.left + win.scrollX, y: box.top + win.scrollY, width: box.width, height: box.height };
      } else if (args.fullPage) {
        rect = { x: 0, y: 0, width: Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth || 0, win.innerWidth), height: Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0, win.innerHeight) };
      }
      if (rect && (rect.width <= 0 || rect.height <= 0 || rect.width * rect.height > 100000000 || rect.width > 32767 || rect.height > 32767)) fail("Screenshot dimensions exceed the safe capture limit");
      let data = {};
      let overlay;
      if (args.annotate) {
        const result = snapshot({ interactive: true, nextRef: args.nextRef }, context);
        data = result.data;
        overlay = doc.createElement("div");
        overlay.dataset.mcpZenOverlay = context.sessionId;
        overlay.style.cssText = "position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none";
        for (const { ref, el } of result.annotations) {
          if (!visible(el)) continue;
          const box = el.getBoundingClientRect();
          const label = doc.createElement("span");
          label.textContent = ref.slice(1);
          label.style.cssText = `position:absolute;left:${box.left + win.scrollX}px;top:${box.top + win.scrollY}px;background:#d00;color:white;font:12px monospace;padding:2px;border:1px solid white`;
          overlay.appendChild(label);
        }
        doc.documentElement.appendChild(overlay);
        // Even if the socket disconnects or capture fails, never leave overlays behind.
        setTimeout(() => overlay.remove(), Math.min(Math.max(deadline - Date.now(), 1), 30000));
      }
      return { ...data, rect };
    }
    if (cmd === "screenshot_cleanup") {
      for (const el of doc.querySelectorAll("[data-mcp-zen-overlay]")) if (el.dataset.mcpZenOverlay === context.sessionId) el.remove();
      return {};
    }
    if (cmd === "console") {
      installConsole(win);
      const page = win.wrappedJSObject || win;
      try {
        const raw = page.eval(`(() => {
          const buf = window.__mcpZenConsole;
          if (!buf) return ${JSON.stringify({ messages: [] })};
          if (${JSON.stringify(Boolean(args.clear))}) { buf.entries.length = 0; return ${JSON.stringify({ cleared: true })}; }
          return { messages: buf.entries.slice() };
        })()`);
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return args.clear ? { cleared: true } : { messages: [] };
      }
    }
    if (cmd === "dialog_status") {
      const page = win.wrappedJSObject || win;
      let pending;
      try { pending = page.eval("window.__mcpZenDialog && window.__mcpZenDialog.pending"); } catch { pending = page.__mcpZenDialog?.pending; }
      if (!pending) return { pending: false };
      return { pending: true, type: pending.type, message: pending.message };
    }
    if (cmd === "dialog_accept" || cmd === "dialog_dismiss") {
      const page = win.wrappedJSObject || win;
      const reply = { accept: cmd === "dialog_accept", text: args.text ?? "" };
      try {
        page.eval(`(() => { if (!window.__mcpZenDialog || !window.__mcpZenDialog.pending) throw new Error("No JavaScript dialog is pending"); window.__mcpZenDialog.pending.reply = ${JSON.stringify(reply)}; })()`);
      } catch (error) {
        fail(String(error.message || error).replace(/^Error: /, ""));
      }
      return { handled: true };
    }
    if (cmd === "frame_info") {
      const frame = resolve(args.selector, context);
      if (!frame.matches("iframe,frame")) fail("Element is not an iframe");
      return { src: frame.src || frame.getAttribute("src") || "", href: frame.src || "", name: frame.name || "", index: [...doc.querySelectorAll("iframe,frame")].indexOf(frame) };
    }
    if (cmd === "find") {
      const found = findElement(args);
      // CLI default subaction is click when omitted.
      const action = args.action || "click";
      const located = "[data-agent-browser-located='true']";
      if (action === "text") return { text: (found.innerText || found.textContent || "").trim() };
      if (action === "click") { clickAt(found, args.value || args.locator); return { clicked: located }; }
      if (action === "hover") { hover(found, args.value || args.locator); return { hovered: located }; }
      if (action === "check") {
        if (!checkedOf(found)) clickAt(found, args.value || args.locator);
        return { checked: located };
      }
      if (action === "fill") {
        editable(found);
        found.focus();
        setValue(found, args.text ?? "");
        found.dispatchEvent(new win.Event("change", { bubbles: true }));
        return { filled: located };
      }
      fail(`Unknown action '${action}' for find. Valid actions: click, fill, check, hover, text.`);
    }
    if (cmd === "is_visible") {
      const el = resolve(args.selector, context, true);
      return { visible: Boolean(el && visible(el)) };
    }
    if (cmd === "is_enabled") {
      const el = resolve(args.selector, context);
      return { enabled: enabled(el) };
    }
    if (cmd === "is_checked") {
      const el = resolve(args.selector, context);
      return { checked: checkedOf(el) };
    }
    if (cmd === "get_attr") {
      const el = resolve(args.selector, context);
      return { value: el.getAttribute(args.name) };
    }
    if (cmd === "get_value") {
      const el = resolve(args.selector, context);
      return { value: valueOf(el) ?? "" };
    }
    if (cmd === "scroll_into_view") {
      const el = resolve(args.selector, context);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return { scrolled: true };
    }
    if (cmd === "swipe") {
      const target = args.selector ? resolve(args.selector, context) : doc.scrollingElement || doc.body;
      const amount = args.amount ?? 300;
      const box = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
      const x = box.left + (box.width || win.innerWidth) / 2;
      const y = box.top + (box.height || win.innerHeight) / 2;
      const dx = args.direction === "left" ? -amount : args.direction === "right" ? amount : 0;
      const dy = args.direction === "up" ? -amount : args.direction === "down" ? amount : 0;
      const start = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      pointer(target, "pointerdown", { pointerType: "touch", clientX: x, clientY: y });
      pointer(target, "pointermove", { pointerType: "touch", clientX: x + dx, clientY: y + dy });
      pointer(target, "pointerup", { pointerType: "touch", clientX: x + dx, clientY: y + dy });
      if (target.scrollBy) target.scrollBy({ left: args.direction === "left" ? -amount : args.direction === "right" ? amount : 0, top: args.direction === "up" ? -amount : args.direction === "down" ? amount : 0, behavior: "instant" });
      else win.scrollBy({ left: dx, top: dy, behavior: "instant" });
      return { swiped: args.direction, amount, synthetic: true };
    }
    const el = resolve(args.selector, context);
    if (cmd === "click") {
      if (args.newTab) {
        const link = el.closest("a[href]") || (el.href ? el : null);
        if (!link?.href) fail(`Element '${args.selector}' does not have an href attribute. --new-tab only works on links.`);
        return { newTabUrl: link.href, clicked: args.selector, newTab: true, url: link.href };
      }
      clickAt(el, args.selector);
      return { clicked: args.selector };
    }
    if (cmd === "hover") { hover(el, args.selector); return { hovered: args.selector }; }
    if (cmd === "tap") {
      const { x, y } = aim(el, args.selector);
      mouseAt(x, y, "mousedown", { pointerType: "touch", buttons: 1, detail: 1 });
      mouseAt(x, y, "mouseup", { pointerType: "touch", detail: 1 });
      el.click();
      return { tapped: args.selector };
    }
    if (!visible(el)) fail("Element is not visible");
    if (cmd === "fill" || cmd === "type") {
      editable(el);
      el.focus();
      const insert = (text) => {
        if (el.isContentEditable) {
          if (doc.execCommand("insertText", false, text)) return;
          el.textContent = (el.textContent || "") + text;
          return;
        }
        try { if (doc.execCommand("insertText", false, text)) return; } catch {}
        setValue(el, (el.value || "") + text);
      };
      const clearField = () => {
        if (typeof el.select === "function") el.select();
        if (el.isContentEditable) el.textContent = "";
        else {
          const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, "");
          el.value = "";
        }
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
      };
      if (cmd === "fill") { clearField(); insert(args.text); }
      else {
        if (args.clear) clearField();
        for (const character of args.text) {
          checkDeadline(deadline);
          if (character === "\n" || character === "\r" || character === "\t") {
            el.dispatchEvent(new win.KeyboardEvent("keydown", { key: character === "\t" ? "Tab" : "Enter", bubbles: true, cancelable: true }));
            if (character !== "\t") insert("\n");
            el.dispatchEvent(new win.KeyboardEvent("keyup", { key: character === "\t" ? "Tab" : "Enter", bubbles: true }));
          } else insert(character);
          if (args.delayMs) await sleep(args.delayMs, deadline);
        }
      }
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return { [cmd === "fill" ? "filled" : "typed"]: args.selector };
    }
    if (cmd === "check" || cmd === "uncheck") {
      const wanted = cmd === "check";
      const native = el.matches('input[type="checkbox"],input[type="radio"]');
      if (!native && !["checkbox", "radio", "switch"].includes(getRole(el))) fail("Element is not a checkbox, radio, or switch");
      if (!wanted && el.matches('input[type="radio"]')) fail("A radio button cannot be unchecked directly");
      const checked = () => native ? el.checked : el.getAttribute("aria-checked") === "true";
      if (checked() !== wanted) clickAt(el, args.selector);
      if (checked() !== wanted) fail("Element did not reach the requested checked state");
      return cmd === "check" ? { checked: args.selector } : { unchecked: args.selector };
    }
    if (cmd === "select") {
      if (el.tagName !== "SELECT") fail("Element is not a select");
      if (!el.multiple && args.values.length > 1) fail("Cannot select multiple values in a single-select");
      const selected = args.values.map((value) => [...el.options].find((option) => option.value === value || option.label === value));
      if (selected.some((option) => !option || option.disabled || option.parentElement?.disabled)) fail("Option not found or disabled");
      for (const option of el.options) option.selected = selected.includes(option);
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return { selected: selected.map((option) => option.value) };
    }
    fail(`Unsupported page operation: ${cmd}`, "UNSUPPORTED_CAPABILITY");
  }

  win.__mcpZenRuntime = { run, documentId };
  return win.__mcpZenRuntime;
}

if (typeof window !== "undefined") installRuntime();
