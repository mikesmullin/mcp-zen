# mcp-zen

A persistent MCP HTTP server paired with a Zen/Firefox extension that lets any
MCP client remote-control your **already-running** browser.

The public tool surface is the **agent-browser core** API (`agent_browser_*`):
same names, titles, descriptions, JSON Schema, and annotations as
[agent-browser](https://github.com/vercel-labs/agent-browser) `0.36.0` (pinned
in `common/agent-browser/`). The backend is your attached Firefox/Zen window,
not a managed Chromium process. See [docs/parity.md](docs/parity.md) for what
that distinction means.

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
node mcpcall.mjs agent_browser_tab_list '{}'
node mcpcall.mjs agent_browser_open '{"url":"https://example.com"}'
node mcpcall.mjs agent_browser_snapshot '{}'
node mcpcall.mjs agent_browser_click '{"selector":"@e1"}'
```

## Tools

Default profile is agent-browser **core** (29 tools). Every tool accepts the
upstream common options; unsupported ones (`allowedDomains`, `restore*`,
`extraArgs`, `caCert`, …) return `UNSUPPORTED_CAPABILITY` instead of being
ignored.

| Tool | Notes |
|---|---|
| `agent_browser_tools_profiles` | `core` only in this version |
| `agent_browser_open` | Navigate bound tab; no browser launch flags |
| `agent_browser_read` | Live tab HTML; `url` navigates first if needed. `llms` fetches llms.txt |
| `agent_browser_snapshot` | A11y-style tree + `@eN` refs |
| `agent_browser_click` | `@ref` or unique CSS; `newTab` opens the link |
| `agent_browser_fill` / `type` | `text` (not `value`); synthetic input |
| `agent_browser_press` | Chords like `Control+a`; untrusted events |
| `agent_browser_check` / `uncheck` / `select` | `select` takes `values: string[]` |
| `agent_browser_scroll` | `up\|down\|left\|right`, default 300px |
| `agent_browser_wait_ms` | Required `ms` ≥ 0 |
| `agent_browser_wait_for_selector` / `_text` / `_load` | `waitTimeoutMs`; no `networkidle` |
| `agent_browser_screenshot` | Path + image content; `fullPage` / `selector` / `annotate` |
| `agent_browser_get_text` | Requires `selector` |
| `agent_browser_get_url` / `get_title` | Bound tab |
| `agent_browser_eval` | Page-realm JS |
| `agent_browser_tab_new` / `tab_list` / `tab_switch` / `tab_close` | `tN` / label / `firefox:<id>` |
| `agent_browser_back` / `forward` / `reload` | |
| `agent_browser_close` | Owned tabs/containers only — not your browser |
| `agent_browser_frame_switch` / `frame_main` | Iframes (Stripe/PayPal/3DS) |
| `agent_browser_find` | Click/fill by role, text, label, testid, … |
| `agent_browser_wait_for_url` | Substring, glob, or `/regex/` |
| `agent_browser_hover` / `scroll_into_view` | |
| `agent_browser_get_value` / `get_attr` / `is_visible` / `is_enabled` / `is_checked` | |
| `agent_browser_dialog_*` | `alert`/`confirm`/`prompt` hooked after the runtime is installed |
| `agent_browser_window_new` | |
| `agent_browser_tap` / `swipe` | Synthetic touch |
| `agent_browser_console` | `{ clear?: boolean }` — page console buffer |

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
