import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { readContent, normalizeUrl } from "../mcp-server/read.js";

test("read: Markdown negotiation, HTML extraction, outline/filter, llms ancestors, raw and errors", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/md") { assert.match(req.headers.accept, /text\/markdown/); res.setHeader("Content-Type", "text/markdown"); res.end("# First\n\nOne\n\n## Second\n\nTwo"); }
    else if (req.url === "/html") { res.setHeader("Content-Type", "text/html"); res.end("<title>Title</title><body><h1>Article</h1><p>Readable content here.</p><script>throw new Error('must not execute')</script></body>"); }
    else if (req.url === "/llms.txt") { res.setHeader("Content-Type", "text/plain"); res.end("# Docs\n\n- [Guide](/guide)"); }
    else if (req.url === "/llms-full.txt") { res.setHeader("Content-Type", "text/plain"); res.end("# Complete documentation"); }
    else if (req.url === "/slow") { setTimeout(() => res.end("late"), 100); }
    else { res.statusCode = 404; res.end("not found"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const read = (args) => readContent(args, { deadline: Date.now() + 1000, signal: new AbortController().signal });
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.throws(() => normalizeUrl("javascript:alert(1)"));
  assert.match((await read({ url: `${url}/md`, requireMd: true })).content, /# First/);
  assert.equal((await read({ url: `${url}/md`, outline: true })).content, "# First\n## Second");
  assert.match((await read({ url: `${url}/md`, filter: "Second" })).content, /Two/);
  assert.doesNotMatch((await read({ url: `${url}/md`, filter: "Second" })).content, /One/);
  assert.match((await read({ url: `${url}/html` })).content, /# Article/);
  assert.doesNotMatch((await read({ url: `${url}/html` })).content, /must not execute/);
  assert.match((await read({ url: `${url}/html`, raw: true })).content, /<body>/);
  await assert.rejects(() => read({ url: `${url}/html`, requireMd: true }), /text\/markdown/);
  assert.match((await read({ url: `${url}/a/b/page`, llms: "index" })).content, /Guide/);
  assert.match((await read({ url: `${url}/a/b/page`, llms: "full" })).content, /Complete/);
  const fixture = await readFile(new URL("fixtures/page.html", import.meta.url), "utf8");
  const fixturePage = { html: fixture, url: `${url}/html`, title: "Agent compatibility fixture" };
  const outlined = await readContent({ outline: true }, { deadline: Date.now() + 1000, signal: new AbortController().signal, activePage: async () => fixturePage });
  assert.match(outlined.content, /Compatibility fixture/);
  await assert.rejects(() => read({ url: `${url}/missing` }), /404/);
  await assert.rejects(() => read({ url: `${url}/slow`, readTimeoutMs: 10 }), /timed out/);
});
