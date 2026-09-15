# mcp-zen

A persistent MCP HTTP server paired with a Zen/Firefox extension that lets any
MCP client remote-control your **already-running** browser.

The public tool surface is **`zen_browser_*`**: one prefix for core browsing,
frames, and additive media/locate tools. Schemas were captured from
[agent-browser](https://github.com/vercel-labs/agent-browser) `0.36.0` (pinned
in `common/agent-browser/`) then renamed. The backend is your attached
Firefox/Zen window, not a managed Chromium process. See
[docs/parity.md](docs/parity.md).

The server is one long-lived process. The extension's WebSocket stays up
independently of short-lived MCP client sessions.

## Setup

### 1. Load the extension in Zen

1. `npm install && npm run build`
2. Zen: `about:debugging` → This Firefox → Load Temporary Add-on →
   `firefox-extension/manifest.json`
3. Options page: **Enable browser automation** (`<all_urls>`). Optional:
   **Enable isolated sessions** (Firefox containers for named `session`s).
4. Temporary add-ons unload on browser restart unless you install permanently.

### 2. Ports (optional)

```bash
cd mcp-server
cp .env.example .env
```

- `MCP_HTTP_PORT` (default `8791`) — MCP clients
- `EXTENSION_PORT` (default `8765`) — extension WebSocket
- `MCP_SCREENSHOT_DIR` — screenshot files (server filesystem)

Localhost only. The extension origin is required on the WebSocket; browser
origins are rejected on `/mcp`.

### 3. Run

`bin/` is gitignored. Create the wrapper once per checkout:

```bash
mkdir -p bin
cat > bin/mcp-zen <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec node "$SCRIPT_DIR/../mcp-server/server.js" "$@"
EOF
chmod +x bin/mcp-zen
ln -sf "$(pwd)/bin/mcp-zen" ~/.local/bin/mcp-zen
mcp-zen
```

Point an MCP client at `http://localhost:8791/mcp`.

```bash
node mcpcall.mjs zen_browser_tab_list '{}'
node mcpcall.mjs zen_browser_open '{"url":"https://example.com"}'
node mcpcall.mjs zen_browser_snapshot '{}'
node mcpcall.mjs zen_browser_click '{"selector":"@e1"}'
```

## Tools

Default profile is agent-browser **core** (29 tools). Every tool accepts the
upstream common options; unsupported ones (`allowedDomains`, `restore*`,
`extraArgs`, `caCert`, …) return `UNSUPPORTED_CAPABILITY` instead of being
ignored.

| Tool | Notes |
|---|---|
| `zen_browser_tools_profiles` | `core` only in this version |
| `zen_browser_open` | Navigate bound tab; no browser launch flags |
| `zen_browser_read` | Live tab HTML; `url` navigates first if needed. `llms` fetches llms.txt |
| `zen_browser_snapshot` | A11y-style tree + `@eN` refs |
| `zen_browser_click` | `@ref`, bare `eN`, or first CSS match; `newTab` opens the link |
| `zen_browser_fill` / `type` | `text` (not `value`); synthetic input |
| `zen_browser_press` | Chords like `Control+a`; untrusted events |
| `zen_browser_check` / `uncheck` / `select` | `select` takes `values: string[]` |
| `zen_browser_scroll` | `up\|down\|left\|right`, default 300px |
| `zen_browser_wait_ms` | Required `ms` ≥ 0 |
| `zen_browser_wait_for_selector` / `_text` / `_load` | `waitTimeoutMs`; no `networkidle` |
| `zen_browser_screenshot` | Path + image content; `fullPage` / `selector` / `annotate` |
| `zen_browser_get_text` | Requires `selector` |
| `zen_browser_get_url` / `get_title` | Bound tab |
| `zen_browser_eval` | Page-realm JS |
| `zen_browser_tab_new` / `tab_list` / `tab_switch` / `tab_close` | `tN` / label / `firefox:<id>` |
| `zen_browser_back` / `forward` / `reload` | |
| `zen_browser_close` | Owned tabs/containers only — not your browser |
| `zen_browser_frame_switch` / `frame_main` | Iframes (Stripe/PayPal/3DS) |
| `zen_browser_find` | Click/fill by role, text, label, testid, … |
| `zen_browser_wait_for_url` | Substring, glob, or `/regex/` |
| `zen_browser_hover` / `scroll_into_view` | |
| `zen_browser_get_value` / `get_attr` / `is_visible` / `is_enabled` / `is_checked` | |
| `zen_browser_dialog_*` | `alert`/`confirm`/`prompt` hooked after the runtime is installed |
| `zen_browser_window_new` | |
| `zen_browser_tap` / `swipe` | Synthetic touch |
| `zen_browser_console` | `{ clear?: boolean }` — page console buffer |

### Reliable targeting

- Use `@eN` from snapshots; bare `eN` is also accepted. Repeated snapshots
  retain refs for the same connected DOM node. Removed/replaced nodes, navigation,
  or evicted refs require a fresh snapshot; refs never automatically retarget.
- Selectors use standard CSS (first match), `xpath=...`, or snapshot refs—not
  Playwright `:has-text()` / `:text()`. Scope to the intended post/player rather
  than using a page-wide `[role=slider]` (which can also match volume).
- `zen_browser_find` **defaults to click**. Use `action: "text"` to read
  without activating the match. Snapshot queries do not click.
- `eval` may be blocked by a site's CSP. Ordinary DOM tools still work.
- Hover is synthetic and may not reveal CSS-only controls. A click response
  confirms dispatch, not application success: verify playback/seek state.
- MCP clients must forward screenshot image content, not just its filesystem
  path. An image placeholder is not visual evidence.
- Additive `zen_*` tools (locate, reveal, click_at, set_range, media_*) are
  Firefox capabilities, not agent-browser. Prefer `zen_browser_media_*` on CSP-strict
  video pages instead of `eval`. `zen_browser_locate` never clicks; `zen_browser_find` still defaults to click.

Omit `session` to use the default binding (a personal tab). Named
`session`/`namespace` values use Firefox containers once that permission is
granted.

## Development

Plain ES modules, Node 22+. No TypeScript.

```bash
npm test
```

- Adapter tests use a mock extension.
- DOM tests use Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`).
- Live tests use a **disposable** Zen/Firefox profile (`FIREFOX_PATH`) and
  never attach to your daily browser.
- `node scripts/capture-agent-browser.js` regenerates pinned schemas from a
  built agent-browser binary.

## Project layout

```
common/agent-browser/   pinned upstream MCP schemas + provenance
mcp-server/             HTTP MCP server, adapter, read pipeline
firefox-extension/      background client + in-page runtime
docs/parity.md          core vs remaining 156-tool surface
test/                   schema, adapter, DOM, live Firefox
mcpcall.mjs             one-shot Streamable HTTP client
```

## License

MIT — see [LICENSE](LICENSE).

Pinned agent-browser schema JSON is copied from an Apache-2.0 project; see
`common/agent-browser/LICENSE`.
