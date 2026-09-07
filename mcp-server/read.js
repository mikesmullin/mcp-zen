import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const MAX_BYTES = 10 * 1024 * 1024;
const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
export function normalizeUrl(value) {
  if (!value || !value.trim()) throw new Error("URL must not be empty");
  const input = value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
  if (!["http:", "https:", "about:"].includes(url.protocol) || (url.protocol === "about:" && url.href !== "about:blank")) {
    throw new Error("Only http:, https:, and about:blank URLs are supported");
  }
  return url.href;
}

async function fetchText(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8" } });
  const chunks = [];
  let size = 0;
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Read response exceeds 10 MiB");
  }
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Read response exceeds 10 MiB");
    chunks.push(Buffer.from(chunk));
  }
  return { status: response.status, ok: response.ok, url: response.url, body: Buffer.concat(chunks).toString("utf8"), contentType: response.headers.get("content-type") || "" };
}

function headingsFrom(doc) {
  return [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .map((el) => `${"#".repeat(Number(el.tagName[1]))} ${el.textContent.replace(/\s+/g, " ").trim()}`)
    .filter((line) => /\s\S/.test(line));
}

function extract(html, url) {
  // JSDOM deliberately has neither runScripts nor resource loading enabled.
  const dom = new JSDOM(html, { url, runScripts: undefined, resources: undefined });
  try {
    const doc = dom.window.document;
    const title = doc.title;
    const headings = headingsFrom(doc);
    let article;
    try { article = new Readability(doc.cloneNode(true), { charThreshold: 0 }).parse(); } catch {}
    for (const el of doc.querySelectorAll("script,style,noscript,template,nav,footer")) el.remove();
    const content = markdown.turndown(article?.content || doc.body?.innerHTML || "");
    return { title: article?.title || title, content, headings };
  } finally { dom.window.close(); }
}

function selectSections(content, { filter, outline }, headings = []) {
  let result = outline && headings.length ? headings.join("\n") : content;
  if (filter) {
    const needle = filter.toLowerCase();
    const sections = result.split(/(?=^#{1,6}\s)/m);
    result = sections.filter((section) => section.toLowerCase().includes(needle)).join("\n");
  }
  if (outline && !headings.length) result = result.split("\n").filter((line) => /^#{1,6}\s/.test(line)).join("\n");
  return result;
}

export async function readContent(args, { activePage, signal, deadline }) {
  if (args.readTimeoutMs !== undefined && args.readTimeoutMs <= 0) throw new Error("readTimeoutMs must be positive");
  const timeout = Math.max(1, Math.min(args.readTimeoutMs ?? 30000, deadline - Date.now(), 2147483647));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Read timed out")), timeout);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    let page;
    if (!args.url) page = await activePage();
    let url = args.url ? normalizeUrl(args.url) : page.url;
    let fetched;
    if (args.llms) {
      if (!/^https?:/.test(url)) throw new Error("llms discovery requires an HTTP(S) URL");
      const candidate = new URL(url);
      candidate.search = "";
      candidate.hash = "";
      let directory = new URL(".", candidate);
      for (;;) {
        fetched = await fetchText(new URL(args.llms === "full" ? "llms-full.txt" : "llms.txt", directory), combined);
        if (fetched.ok) break;
        if (fetched.status !== 404) throw new Error(`Read failed: HTTP ${fetched.status}`);
        const parent = new URL("..", directory);
        if (parent.href === directory.href) throw new Error("No llms file found in the URL's ancestors");
        directory = parent;
      }
    } else if (args.url) {
      if (!/^https?:/.test(url)) throw new Error("URL fetching requires HTTP(S)");
      fetched = await fetchText(url, combined);
      if (!fetched.ok) throw new Error(`Read failed: HTTP ${fetched.status}`);
    }
    const contentType = fetched?.contentType || "text/html";
    if (args.requireMd && !/^text\/markdown\b/i.test(contentType)) throw new Error("Expected Content-Type: text/markdown");
    const body = fetched?.body ?? page.html;
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Read response exceeds 10 MiB");
    url = fetched?.url || url;
    let result = { title: page?.title || "", content: body, headings: [] };
    if (!args.raw && /(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) result = extract(body, url);
    const { headings, ...publicResult } = result;
    publicResult.content = selectSections(result.content, args, headings);
    return { ...publicResult, url, contentType };
  } finally { clearTimeout(timer); }
}
