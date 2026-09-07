# Agent-browser parity

mcp-zen advertises the **agent-browser core** MCP surface captured from
`tmp/agent-browser` (`cli/src/mcp.rs`, revision recorded in
`common/agent-browser/upstream.json`). Tool **names, titles, descriptions,
JSON Schema, defaults, and annotations** match that capture.

This is not a Chromium CDP daemon. The backend is an attached Zen/Firefox
browser plus a WebExtension. Matching signatures does not imply matching
browser internals.

## What this version implements

29 core tools plus a **checkout** extra set (frames, find/hover, dialogs, URL waits, queries, `window_new`, tap/swipe):

| Tool | Backend notes |
|---|---|
| `tools_profiles` | Reports `core` only, plus the pinned upstream revision |
| `open` | Navigates the session's bound tab (`about:blank` if URL omitted). Launch flags (`headed`, `webgpu`, `webmcp`) error |
| `read` | Live tab HTML (Readability). `url` navigates that tab if different, then waits for load. `llms` still HTTP-fetches ancestor llms.txt |
| `snapshot` | DOM accessibility approximation with `@eN` refs (not Chromium `Accessibility.getFullAXTree`) |
| `click` / `fill` / `type` / `press` / `check` / `uncheck` / `select` / `scroll` | Synthetic DOM events; `@ref` or unique CSS |
| `wait_ms` | Server-side timer |
| `wait_for_selector` / `wait_for_text` / `wait_for_load` | In-page polling. `networkidle` errors |
| `screenshot` | `tabs.captureTab` (background tabs, optional rect). Overlay numbers for `annotate`. Files are written on the **MCP server host** |
| `get_text` / `get_url` / `get_title` / `eval` | Page / tab APIs. `eval` uses the page realm via `wrappedJSObject` |
| `back` / `forward` / `reload` | `browser.tabs` + `webNavigation` completion |
| `tab_new` / `tab_list` / `tab_switch` / `tab_close` | Public ids `tN`, optional labels, `firefox:<id>` |
| `close` | Closes **mcp-zen-owned** tabs/containers only. Never quits Zen |
| `frame_switch` / `frame_main` | `webNavigation` frame ids; `@ref` / CSS / numeric id. Cross-origin frames can be targeted after switch |
| `find` | Faithful port of agent-browser locators: first match, default `click`, leaf `textContent` (case-sensitive), exact `alt`/`title`/`placeholder`/`testid` attributes. Role uses DOM `getRole` instead of Chrome AX |
| `wait_for_url` | Substring, glob, or `/regex/` against the tab URL |
| `hover` / `scroll_into_view` | Synthetic pointer events; real CSS `:hover` may not apply |
| `get_value` / `get_attr` / `is_visible` / `is_enabled` / `is_checked` | |
| `dialog_*` | Hooks `alert`/`confirm`/`prompt` in the page realm. Already-open native dialogs cannot be seen |
| `window_new` | Extra Firefox window; session binds its tab |
| `tap` / `swipe` | Synthetic touch/pointer + scroll. Not iOS WebDriver |
| `console` | Page `console.*` hook (not CDP `Runtime.consoleAPICalled`). Misses messages before the hook is installed |

Common schema fields that **cannot** be honored on an attached Firefox
(`restore*`, `allowedDomains`, `caCert`, `clearCaCert`, `idleTimeout`,
`extraArgs`) fail with `UNSUPPORTED_CAPABILITY` and are not applied.

`session` / `namespace` are honored as named Firefox containers (optional
permission). They are **not** agent-browser daemon sockets or restore-state
directories. The default session binds one of the user's existing tabs and
does not claim ownership of it.

## Remaining work for full 156-tool parity

Captured `all` profile: **156** tools. Implemented: **29** core + **17** checkout extras.

### Network (9)

`set_headers`, `set_credentials`, `set_offline`, `network_route`,
`network_unroute`, `network_requests`, `network_request`, `network_har_start`,
`network_har_stop`.

Needs `webRequest` / declarative net request, HAR buffering, and request
bodies. Firefox cannot silently implement Chromium CDP Network domain
semantics.

### State (27)

Cookies, storage, auth profiles, saved browser state, sessions, Chrome
profiles, bundled skills.

Partial overlap exists (`contextualIdentities` for named sessions). Cookie
and storage APIs are feasible with extra permissions. Chrome profile /
restore-file / skill bundles are Chromium-daemon concepts.

### Debug (40)

Downloads, PDF, upload, tracing, profiler, recording, axe a11y, console,
highlight, inspect, clipboard, diffs, batch, confirm/deny, connect, streaming,
plugins, doctor, dashboard, install, upgrade, chat.

Some are addable (`downloads`, `clipboardWrite`, console via
`devtools.inspectedWindow` is not available to this background page).
Others require CDP, a sidecar Chromium, or packaging agent-browser itself.

### Tabs extras (beyond core)

`window_new`, `frame_switch`, `frame_main`, and `dialog_*` are implemented.
Native dialogs already showing before the page hook is installed cannot be
accepted. `beforeunload` is not hooked.

### React (8)

React fiber inspection, render recording, Suspense, vitals, pushstate,
init-script removal. Page-script heuristics possible; not CDP.

### Mobile (15)

`tap` / `swipe` are synthetic. Remaining: real mouse buttons, viewport/device/geo/media emulation.

### WebMCP (4)

Page-provided tools. Doable in-page, not implemented.

### Core behavioral gaps (even for the 29)

- Snapshots are DOM-computed roles/names, not Chromium `Accessibility.getFullAXTree`.
- Clicks now fail if `elementFromPoint` is a covering overlay (same error as upstream), then `el.click()` because Firefox cannot emit CDP-trusted mouse events.
- `fill`/`type` use `execCommand('insertText')` after clear; still not `Input.insertText`.
- No `networkidle`, no domain allowlist enforcement, no state restore.
- `close` does not terminate the user's browser process.
- `eval` cannot return DOM nodes or functions (structured clone).
- Screenshots: element/full-page use `captureTab` rects; very large pages
  are rejected. JPEG/annotate/path are implemented.
- Refs are per mcp-zen session + tab + document, not Chromium backend node
  ids. Navigation invalidates them.
- `read` uses the tab DOM (not a cookie-less Node fetch). `llms.txt` discovery still fetches from Node.
- Concurrent MCP clients share one extension socket; isolation is logical
  (session queues + containers), not process isolation.

Re-capture schemas after bumping the vendor revision:

```bash
# build tmp/agent-browser/cli, then:
node scripts/capture-agent-browser.js
```
