import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { readContent, normalizeUrl, urlsMatch } from "../mcp-server/read.js";

test("urlsMatch ignores hash and trailing slash", () => {
  assert.equal(urlsMatch("https://www.youtube.com/feed/subscriptions", "https://www.youtube.com/feed/subscriptions/"), true);
  assert.equal(urlsMatch("https://www.youtube.com/feed/subscriptions#x", "https://www.youtube.com/feed/subscriptions"), true);
  assert.equal(urlsMatch("https://www.youtube.com/feed/subscriptions", "https://www.youtube.com/"), false);
});

test("read: live-tab HTML extraction, outline/filter, llms ancestors, raw and errors", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/llms.txt") { res.setHeader("Content-Type", "text/plain"); res.end("# Docs\n\n- [Guide](/guide)"); }
    else if (req.url === "/llms-full.txt") { res.setHeader("Content-Type", "text/plain"); res.end("# Complete documentation"); }
    else if (req.url === "/slow/llms.txt") { setTimeout(() => res.end("late"), 200); }
    else if (req.url.startsWith("/blocked")) { res.statusCode = 500; res.end("no"); }
    else { res.statusCode = 404; res.end("not found"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const htmlPage = {
    html: "<title>Title</title><body><h1>Article</h1><p>Readable content here.</p><script>throw new Error('must not execute')</script></body>",
    url: `${url}/html`,
    title: "Title",
  };
  const mdPage = { html: "# First\n\nOne\n\n## Second\n\nTwo", url: `${url}/md`, title: "" };
  const read = (args, page = htmlPage) => readContent(args, { deadline: Date.now() + 1000, signal: new AbortController().signal, activePage: async () => page });
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.throws(() => normalizeUrl("javascript:alert(1)"));
  assert.match((await read({ outline: true }, mdPage)).content, /# First/);
  assert.equal((await read({ outline: true }, mdPage)).content, "# First\n## Second");
  assert.match((await read({ filter: "Second" }, mdPage)).content, /Two/);
  assert.doesNotMatch((await read({ filter: "Second" }, mdPage)).content, /One/);
  assert.match((await read({})).content, /# Article/);
  assert.doesNotMatch((await read({})).content, /must not execute/);
  assert.match((await read({ raw: true })).content, /<body>/);
  await assert.rejects(() => read({ requireMd: true }), /text\/markdown/);
  assert.match((await read({ url: `${url}/a/b/page`, llms: "index" })).content, /Guide/);
  assert.match((await read({ url: `${url}/a/b/page`, llms: "full" })).content, /Complete/);
  const fixture = await readFile(new URL("fixtures/page.html", import.meta.url), "utf8");
  const outlined = await read({ outline: true }, { html: fixture, url: `${url}/html`, title: "Agent compatibility fixture" });
  assert.match(outlined.content, /Compatibility fixture/);
  await assert.rejects(() => read({ llms: "index", url: `${url}/blocked/page` }), /HTTP 500/);
  await assert.rejects(() => read({ llms: "index", url: `${url}/slow/page`, readTimeoutMs: 10 }), /timed out/);
});
