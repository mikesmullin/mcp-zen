import { WebsocketClient } from "./client.js";
import { MessageHandler } from "./message-handler.js";
import { getConfig, getAllowedCommands } from "./extension-config.js";

// Shared capture queue across all configured server connections.
const handler = new MessageHandler(browser, new Set(getAllowedCommands()));
getConfig().then((config) => {
  for (const port of config.ports) new WebsocketClient(port, handler).connect();
}).catch((error) => console.error("mcp-zen: initialization failed:", error));

// Capture console.log from document start, not only after the first tool call.
if (browser.webNavigation?.onCommitted) {
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === undefined || !details.tabId) return;
    browser.tabs.executeScript(details.tabId, { file: "dist/console-hook.js", frameId: details.frameId, runAt: "document_start" }).catch(() => {});
  });
}
