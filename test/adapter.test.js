import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBrowserAdapter } from "../mcp-server/adapter.js";
import { MockBrowser } from "./helpers/mock-browser.js";

const setup = () => {
  const api = new MockBrowser();
  const adapter = new AgentBrowserAdapter(api);
  const call = (name, args = {}) => adapter.call(`agent_browser_${name}`, args);
  return { api, adapter, call };
};
const data = (result) => { assert.equal(result.isError, false, result.content[0].text); return result.structuredContent.response.data; };

test("session binding survives foreground changes and reports closed tabs", async () => {
  const { api, call } = setup();
  data(await call("get_url"));
  api.tabs.push({ id: 99, url: "https://other.test", title: "Other", active: true });
  api.tabs[0].active = false;
  assert.equal(data(await call("get_url")).url, "https://example.com/");
  api.tabs = api.tabs.filter((tab) => tab.id !== 10);
  const gone = await call("get_url");
  assert.equal(gone.structuredContent.response.data.code, "TAB_GONE");
  const listing = data(await call("tab_list"));
  data(await call("tab_switch", { tab: listing.tabs[0].id }));
  assert.equal(data(await call("get_url")).url, "https://other.test");
});

test("named sessions use distinct containers, labels, and never close personal tabs", async () => {
  const { api, call } = setup();
  const a = data(await call("tab_new", { session: "a", label: "work", url: "example.org" }));
  const b = data(await call("tab_new", { session: "b", label: "work" }));
  assert.equal(a.id, "t1");
  assert.equal(b.id, "t1");
  assert.notEqual(api.tabs[1].cookieStoreId, api.tabs[2].cookieStoreId);
  assert.equal(data(await call("tab_list", { session: "a" })).tabs.length, 1);
  data(await call("tab_switch", { session: "a", tab: "work" }));
  assert.equal(data(await call("get_url", { session: "a" })).url, "https://example.org/");
  assert.equal((await call("tab_new", { session: "a", label: "work" })).isError, true);
  data(await call("close", { all: true }));
  assert.deepEqual(api.tabs.map((tab) => tab.id), [10]);
});

test("refs are monotonic and bound to a session, tab, and document", async () => {
  const { api, call } = setup();
  const first = data(await call("snapshot"));
  assert.ok(first.refs.e1);
  data(await call("click", { selector: "@e1" }));
  assert.equal(api.calls.at(-1).args.documentId, "document-1");
  assert.ok(data(await call("snapshot")).refs.e2);
  api.documentId = "document-2";
  assert.equal((await call("click", { selector: "@e1" })).structuredContent.response.data.code, "STALE_REF");
  data(await call("open", { url: "example.org" }));
  assert.equal((await call("click", { selector: "@e2" })).structuredContent.response.data.code, "STALE_REF");
  assert.ok(data(await call("snapshot")).refs.e3);
  data(await call("tab_new"));
  assert.equal((await call("click", { selector: "@e3" })).isError, true);
});

test("unsupported launch/security/restore settings fail before browser side effects", async () => {
  const { api, call } = setup();
  for (const args of [{ allowedDomains: [] }, { restore: false }, { extraArgs: [] }, { caCert: "cert.pem" }, { headed: true }, { webmcp: false }]) {
    const result = await call("open", { url: "example.com", ...args });
    assert.equal(result.structuredContent.response.data.code, "UNSUPPORTED_CAPABILITY");
  }
  assert.equal((await call("wait_for_load", { state: "networkidle" })).isError, true);
  assert.equal(api.calls.length, 0);
});

test("queued calls expire without side effects; independent sessions do not block", async () => {
  const { api, call } = setup();
  const long = call("wait_ms", { ms: 80 });
  const expired = await call("tab_new", { timeoutMs: 15 });
  assert.equal(expired.isError, true);
  assert.equal(data(await call("wait_ms", { session: "other", ms: 1 })).waited, 1);
  await long;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.calls.length, 0);
});

test("close all waits for existing session work and gates later work", async () => {
  const { api, call } = setup();
  const create = call("tab_new", { session: "a" });
  const close = call("close", { all: true });
  const later = call("tab_new", { session: "b" });
  data(await create); data(await close); data(await later);
  assert.equal(api.tabs.length, 2);
  assert.equal(api.tabs[1].cookieStoreId, "firefox-container-2");
});
