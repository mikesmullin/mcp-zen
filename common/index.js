// Pinned upstream schemas are the API contract; do not hand-maintain duplicates.
import coreTools from "./agent-browser/core.json" with { type: "json" };
import allTools from "./agent-browser/all.json" with { type: "json" };
import upstream from "./agent-browser/upstream.json" with { type: "json" };

const extraNames = [
  "agent_browser_frame_switch",
  "agent_browser_frame_main",
  "agent_browser_find",
  "agent_browser_wait_for_url",
  "agent_browser_hover",
  "agent_browser_scroll_into_view",
  "agent_browser_get_value",
  "agent_browser_is_visible",
  "agent_browser_is_enabled",
  "agent_browser_is_checked",
  "agent_browser_get_attr",
  "agent_browser_dialog_status",
  "agent_browser_dialog_accept",
  "agent_browser_dialog_dismiss",
  "agent_browser_window_new",
  "agent_browser_tap",
  "agent_browser_swipe",
  "agent_browser_console",
];
const extraTools = extraNames.map((name) => {
  const tool = allTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Pinned schema missing ${name}`);
  return tool;
});
const enabledTools = [...coreTools, ...extraTools];

export { coreTools, allTools, extraTools, enabledTools, upstream };
