import { test } from "node:test";
import assert from "node:assert/strict";
import { urlMatches } from "../firefox-extension/message-handler.js";

test("wait_for_url patterns match agent-browser route_url_matches", () => {
  assert.equal(urlMatches("https://shop.test/checkout/success", "/success"), true);
  assert.equal(urlMatches("https://shop.test/cart", "/success"), false);
  assert.equal(urlMatches("https://shop.test/orders/123", "https://shop.test/orders/*"), true);
  assert.equal(urlMatches("https://shop.test/orders/123", "https://shop.test/orders/123"), true);
  assert.equal(urlMatches("https://a.test/x", "https://b.test/*"), false);
  assert.equal(urlMatches("https://shop.test/a", "*"), true);
});
