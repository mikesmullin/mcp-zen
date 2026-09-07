import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const available = await access(executablePath).then(() => true, () => false);
const html = await readFile(new URL("fixtures/page.html", import.meta.url), "utf8");
const bundle = await readFile(new URL("../firefox-extension/dist/page-runtime.js", import.meta.url), "utf8");

test("page runtime: snapshot/ref/action/wait workflows in a real DOM", { skip: !available && "Set CHROMIUM_PATH for DOM tests", timeout: 30000 }, async (t) => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://fixture.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/frame") return route.fulfill({ contentType: "text/html", body: "<label>Card number<input id='card'></label>" });
    return route.fulfill({ contentType: "text/html", body: html });
  });
  await page.goto("http://fixture.test/");
  await page.evaluate(bundle);
  const run = (cmd, args = {}, context = {}) => page.evaluate(async ({ cmd, args, context }) => {
    try { return { data: await window.__mcpZenRuntime.run(cmd, args, { sessionId: "test", deadline: Date.now() + 3000, ...context }) }; }
    catch (error) { return { error: { message: error.message, code: error.code } }; }
  }, { cmd, args, context });
  const ok = (result) => { assert.ok(!result.error, JSON.stringify(result.error)); return result.data; };
  const snapshot = ok(await run("snapshot", { interactive: true, nextRef: 1 }));
  assert.match(snapshot.snapshot, /textbox "Full name"/);
  assert.doesNotMatch(snapshot.snapshot, /Hidden button/);
  const duplicateRefs = Object.entries(snapshot.refs).filter(([, item]) => item.name === "Duplicate").map(([ref]) => ref);
  assert.equal(duplicateRefs.length, 2);
  ok(await run("click", { selector: `@${duplicateRefs[1]}` }, { documentId: snapshot.documentId }));
  assert.equal(await page.locator("#status").textContent(), "B");
  ok(await run("click", { selector: "button" }));
  assert.match((await run("click", { selector: "#covered" })).error.message, /covered by <div#blocker>/);
  assert.equal((await run("click", { selector: "@e99999" })).error.code, "STALE_REF");
  assert.equal((await run("click", { selector: `@${duplicateRefs[0]}` }, { documentId: "old-document" })).error.code, "STALE_REF");
  assert.equal((await run("click", { selector: `@${duplicateRefs[0]}` }, { sessionId: "other" })).error.code, "STALE_REF");
  await page.locator("#duplicate-a").evaluate((el) => el.remove());
  assert.equal((await run("click", { selector: `@${duplicateRefs[0]}` })).error.code, "STALE_REF");
  ok(await run("fill", { selector: "#name", text: "Ada" }));
  ok(await run("type", { selector: "#name", text: " Lovelace", delayMs: 1 }));
  assert.equal(await page.locator("#name").inputValue(), "Ada Lovelace");
  ok(await run("type", { selector: "#notes", text: "A\nB", clear: true }));
  assert.equal(await page.locator("#notes").inputValue(), "A\nB");
  ok(await run("check", { selector: "#check" }));
  ok(await run("check", { selector: "#check" }));
  assert.equal(await page.locator("#check").isChecked(), true);
  ok(await run("uncheck", { selector: "#check" }));
  assert.equal(await page.locator("#check").isChecked(), false);
  assert.deepEqual(ok(await run("select", { selector: "#select", values: ["Red", "blue"] })).selected, ["red", "blue"]);
  ok(await run("scroll", { selector: "#scroller", direction: "right", amount: 100 }));
  assert.equal(await page.locator("#scroller").evaluate((el) => el.scrollLeft), 100);
  await page.locator("#name").focus();
  ok(await run("press", { key: "Control+a" }));
  ok(await run("press", { key: "Backspace" }));
  assert.equal(await page.locator("#name").inputValue(), "");
  ok(await run("press", { key: "Enter" }));
  assert.equal(await page.locator("#status").textContent(), "Saved");
  ok(await run("wait_for_text", { text: "Saved", waitTimeoutMs: 100 }));
  assert.equal((await run("wait_for_text", { text: "Never here", waitTimeoutMs: 20 })).error.code, "TIMEOUT");
  ok(await run("wait_for_selector", { selector: "#status", waitTimeoutMs: 100 }));
  ok(await run("wait_for_load", { state: "load" }));
  assert.equal((await run("wait_for_load", { state: "networkidle" })).error.code, "UNSUPPORTED_CAPABILITY");
  assert.deepEqual(ok(await run("eval", { script: "Promise.resolve({error:'user data', answer:42})" })).result, { error: "user data", answer: 42 });
  assert.equal(ok(await run("eval", { script: "let x = 1; x + 2" })).result, 3);
  const full = ok(await run("snapshot", { interactive: false, compact: true, includeUrls: true, nextRef: snapshot.nextRef }));
  assert.match(full.snapshot, /heading "Compatibility fixture"/);
  assert.match(full.snapshot, /\/url: http:\/\/fixture.test\/second/);
  const capture = ok(await run("screenshot_prepare", { fullPage: true, annotate: true, nextRef: full.nextRef }));
  assert.ok(capture.rect.width > 0 && capture.rect.height > 0);
  assert.ok(capture.refs);
  assert.equal(await page.locator("[data-mcp-zen-overlay]").count(), 1);
  ok(await run("screenshot_cleanup"));
  assert.equal(await page.locator("[data-mcp-zen-overlay]").count(), 0);
  ok(await run("find", { locator: "text", value: "Place order", action: "click" }));
  assert.equal(await page.locator("#status").textContent(), "Ordered");
  ok(await run("find", { locator: "testid", value: "place-order" }));
  ok(await run("hover", { selector: "#menu-btn" }));
  assert.equal(await page.locator("#menu-panel").evaluate((el) => el.hidden), false);
  ok(await run("scroll_into_view", { selector: "#place-order" }));
  assert.equal(ok(await run("get_value", { selector: "#name" })).value, "");
  assert.match(ok(await run("get_attr", { selector: "#link", name: "href" })).value, /\/second/);
  assert.equal(ok(await run("is_visible", { selector: "#save" })).visible, true);
  assert.equal(ok(await run("is_visible", { selector: "#missing-element" })).visible, false);
  assert.equal(ok(await run("is_enabled", { selector: "#disabled" })).enabled, false);
  assert.equal(ok(await run("is_checked", { selector: "#check" })).checked, false);
  ok(await run("tap", { selector: "#place-order" }));
  ok(await run("swipe", { direction: "down", amount: 40, selector: "#scroller" }));
  assert.match(ok(await run("snapshot", { interactive: true, nextRef: 100 })).snapshot, /iframe/);
  assert.equal(ok(await run("dialog_status")).pending, false);
  assert.equal(ok(await run("frame_info", { selector: "#pay-frame" })).index, 0);
});

test("find matches agent-browser: first leaf, case-sensitive text, exact alt, default click", { skip: !available && "Set CHROMIUM_PATH for DOM tests", timeout: 30000 }, async (t) => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://fixture.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/frame") return route.fulfill({ contentType: "text/html", body: "<label>Card number<input id='card'></label>" });
    return route.fulfill({ contentType: "text/html", body: html });
  });
  await page.goto("http://fixture.test/");
  await page.evaluate(bundle);
  const run = (cmd, args = {}) => page.evaluate(async ({ cmd, args }) => {
    try { return { data: await window.__mcpZenRuntime.run(cmd, args, { sessionId: "find", deadline: Date.now() + 3000 }) }; }
    catch (error) { return { error: { message: error.message, code: error.code } }; }
  }, { cmd, args });
  const ok = (result) => { assert.ok(!result.error, JSON.stringify(result.error)); return result.data; };
  assert.equal((await run("find", { locator: "text", value: "pretzel" })).error.message, "No element found by text 'pretzel'");
  assert.equal((await run("find", { locator: "alt", value: "pretzel" })).error.message, "No element found by alttext 'pretzel'");
  ok(await run("find", { locator: "alt", value: "Snyder's of Hanover Sourdough Nibblers Pretzels, 16 Oz", action: "text" }));
  const first = ok(await run("find", { locator: "text", value: "Duplicate", action: "text" }));
  assert.equal(first.text, "Duplicate");
  ok(await run("find", { locator: "text", value: "Duplicate" }));
  assert.equal(await page.locator("#status").textContent(), "A");
  ok(await run("find", { locator: "testid", value: "place-order", action: "text" }));
  assert.equal((await run("find", { locator: "testid", value: "place" })).error.message, "No element found by testid 'place'");
});

test("console captures page console.log/warn/error and clear", { skip: !available && "Set CHROMIUM_PATH for DOM tests", timeout: 30000 }, async (t) => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<html><body>console</body></html>");
  await page.evaluate(bundle);
  await page.evaluate(() => { console.log("hello", 42); console.warn("careful"); console.error("boom"); });
  const run = (cmd, args = {}) => page.evaluate(async ({ cmd, args }) => {
    try { return { data: await window.__mcpZenRuntime.run(cmd, args, { sessionId: "console", deadline: Date.now() + 3000 }) }; }
    catch (error) { return { error: { message: error.message, code: error.code } }; }
  }, { cmd, args });
  const ok = (result) => { assert.ok(!result.error, JSON.stringify(result.error)); return result.data; };
  const logs = ok(await run("console"));
  assert.ok(logs.messages.some((m) => m.type === "log" && m.text.includes("hello")));
  assert.ok(logs.messages.some((m) => m.type === "warn" && m.text.includes("careful")));
  assert.ok(logs.messages.some((m) => m.type === "error" && m.text.includes("boom")));
  assert.deepEqual(ok(await run("console", { clear: true })), { cleared: true });
  assert.equal(ok(await run("console")).messages.length, 0);
});
