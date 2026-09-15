# Making MCP Zen reliable for Ada

## Scope and checkpoint

Investigated the latest Downloads report, `~/Downloads/ada-browser-struggles-twitter.md`, and the current session selected by `/workspace/ada/.angela/ada-session`: `2026-08-30T02-16-52_7e4b4d`. Read the session metadata and recent JSONL tool calls/results, including the X task and the report-writing exchange. The `.json` file is metadata; the `.jsonl` contains the evidence.

Before editing, committed and pushed Ada's pending context-reload scope fix and sandbox task state as `728debb`. MCP Zen was clean and its push reported everything up to date. Raw session logs and screenshots remain local, not copied into this plan or committed.

Goal: identify the intended X post, operate its video, and verify playback/approximately 50% seek without accidental navigation or engagement actions. Preserve upstream tool signatures; add clearly distinguished extension capabilities rather than silently changing their meaning.

## Findings: report versus actual evidence

| Finding | Evidence and diagnosis |
| --- | --- |
| Bare refs were interpreted as CSS | Session event `e439ad1c3` calls click with `selector: "e136"`; `ec8daf280` uses `e1071`. Runtime only recognized a leading `@`. These failures do **not** establish that React detached the referenced elements. |
| Ref churn is real but not itself expiration | Every snapshot allocated new `eN` values for every element, including the same slider. Old refs remained in the registry until detachment/eviction. Increasing numbers alone did not invalidate them. |
| Screenshot evidence never reached Ada | `back/lib/mcp-zen.coffee` converted every image to literal `[image]`. Trace screenshot results contain just a path and `[image]`. I inspected the saved screenshot ending `1789430800002-c0f3e88b.png`: the video contains visible imagery, not a solid black rectangle. Fix the bridge before attempting compositor/poster workarounds. |
| Browser failures were logged as successful tool returns | `Element not found`, invalid CSS, and CSP failures have `ok: true` in Ada's trace. Zen returned `isError: true`, but the bridge discarded it and returned a normal string. It also discarded structured error codes. |
| Eval is blocked on X | Trace and live read-only reproduction both return `call to eval() blocked by CSP`. Runtime explicitly uses page-realm `wrappedJSObject.eval`. Ordinary content-script DOM operations do not need this eval. Do not weaken X's CSP. |
| Selector expectations differ | `:has-text()` and `:contains-text` are not implemented. The runtime supports standard CSS and `xpath=`. CSS resolution uses `querySelector` (first match), despite earlier README claims of uniqueness. Snapshot's selector selects one subtree, not a union of all matching roots. |
| Find performed its documented default action | Missing `action` means click, matching pinned agent-browser behavior. The trace also shows Ada discovering `action: "text"`. Changing the upstream default would break compatibility; provide explicit read-only locating separately. |
| Seek success was not verified | Events `e645f219b` and `e6e2a2f40` report 87.16535457915113 / 776.533 seconds after the click: about **11.2%**, not 50%. Later controls disappeared and Ada still inferred success. |
| Click coordinates are suspect | `clickAt()` dispatches down/up at the center, then calls `el.click()`. The final click has default zero coordinates, not the coordinates sent in down/up. A click-driven slider can therefore respond incorrectly. This is a source-level candidate, not yet a proven explanation of X's precise seek behavior. |
| Hidden controls and repeated broad snapshots waste turns | Hover helped temporarily; a later `[role=slider]` lookup failed. Broad selectors can also address volume or a different post. Full-page snapshots repeatedly return unrelated engagement buttons and duplicate nested textboxes. |

### Live checks on the user's existing X tab

With permission, connected through MCP Zen at `http://localhost:8791/mcp`. The tab remained on the original `poteto/status/2099558917282181186` post.

- Read `aria-valuenow` through `e1090`: failed. Read through `@e1090`: succeeded (3.32133 seconds).
- Two scoped slider snapshots produced `e1355`, then `e1356`, reproducing churn.
- A read-only `eval` of video currentTime was blocked by CSP.
- A fresh screenshot showed real video imagery and a visible 0:03 / 12:57 timecode.
- No clicks, playback changes, navigation, likes, replies, follows, or posts were performed in these live checks. These are baseline checks of the **running old build**, not deployment verification of the patches.

## Implemented in this pass

### Zen

1. Accept bare `eN` and canonical `@eN` through the same adapter/runtime ref path. Unknown refs must fail as `STALE_REF`, never fall through to CSS. Keep session/tab/document checks and frame routing.
2. Reuse refs for identical connected DOM nodes across full/scoped/annotated snapshots, using per-session reverse WeakMaps and monotonic allocation. Prune detached refs and bound retained registries. A replacement node gets a new ref; do not guess a replacement for an old action target.
3. Return actionable invalid-selector guidance, including the warning that find defaults to click. Document actual CSS, XPath, ref, and first-match behavior.
4. Regression coverage: bare/canonical refs, stable scoped snapshots, detached/replaced nodes, session/document/tab isolation, selector guidance, and Firefox Xray node identity.

### Ada integration

1. Replace the text-only screenshot conversion with Angela's exported `mcpResultToProviderContent`, using its model image-support detection. AGL already accepts content arrays; no second vision service is required.
2. Convert MCP `isError` into a thrown error including the structured code. Do not clear the MCP connection for normal page-level errors. Transport failures invalidate the cached connection and throw instead of returning a success-looking string.
3. Add `back/test/browser-result.test.mjs` covering real image parts, unchanged text results, and structured browser failures.

### Validation

- Zen: `npm test` — **16 passed, 0 skipped**, including Chromium DOM tests and the complete real Zen/Firefox extension workflow in a disposable profile.
- Ada: from `back/`, `bun test test/browser-result.test.mjs` — **2 passed**. Importing the CoffeeScript bridge with Bun also passed.
- Running the Ada helper tests under Node instead of Bun hit an existing AGL provider import incompatibility (`import.meta.dir` usage). Bun is Ada's supported runtime; no unrelated AGL changes were made.
- Still required: end-to-end screenshot delivery to Ada's configured model after restart, and patched-build acceptance on the personal X tab. Unit conversion success alone is not proof the configured provider accepts the image.

## Recommended remaining work, in order

### P0 — Deploy coherently and give Ada backend-specific guidance

Files: Ada `back/lib/mcp-zen.coffee`, agent/system-prompt assembly; Zen `mcp-server/mcp.js`, extension packaging.

- Add a short browser-use guide to Ada's actual prompt/tool descriptions. Her custom bridge discovers tools but does not propagate MCP initialize instructions. Guidance must reach the model, not live only in README: refs, native CSS/XPath, find's mutating default, CSP limits, synthetic input, and verification after actions.
- Keep the current personal/default session for the logged-in X tab. A new named container will not inherit that login. Keep all steps on one explicitly selected tab/frame.
- Give stale/covered/unsupported/CSP/transport errors distinct recovery instructions. Retry at most once after a fresh scoped observation; never silently replay a potentially mutating call after a disconnect.
- Fix lifecycle discrepancies: the bridge comments promise checks before every call, but `ensureMcpZen()` is called during startup/registration only. Use an endpoint handshake as the health signal, single-flight reconnect, and re-discovery after server restart; a pidfile alone does not establish endpoint health. Test restart/disconnect and startup-with-server-down.
- Carry cancellation/deadlines from Ada to MCP so stopping a turn stops pending browser work. Audit transport retry semantics separately from page errors.
- Retain tool schemas and annotations when wiring tools into policy. Image content and error status must survive UX/policy wrapping and retained session reconstruction, not just the first conversion.

Acceptance: a known screenshot reaches the configured model as an image; a missing-element call is an explicit error; reconnect works without duplicating clicks; Ada knows find does not default to read-only.

### P1 — Add CSP-independent media inspection and verified seek

Implement dedicated, narrowly scoped commands inside the existing extension content runtime (no arbitrary page eval). Suggested additive names, not upstream promises: `zen_media_state`, `zen_media_seek`, and optionally explicit `zen_media_play` / `zen_media_pause`.

- Read `<video>`/`<audio>` state: paused, ended, currentTime, finite duration or null, seeking, readyState, networkState, muted, playbackRate, seekable ranges, dimensions, poster, and media error code. Return document/tab/frame identity and observation time.
- Scope to the intended post/player. If there is more than one matching media element, return candidates and require disambiguation; never choose a different video silently. Support cross-origin frames through explicit existing frame switching and permission checks.
- Seek accepts seconds OR fraction (mutually exclusive); validate range and reject unknown/infinite duration for fractional seeking. Respect actual seekable ranges, including live streams. Do not modify `aria-valuenow` to fake a seek.
- Read back actual media time after `seeked` or a bounded timeout. Return requested versus observed time, normalized fraction, tolerance, and whether verification succeeded. Seeking must preserve paused/playing state unless explicitly requested otherwise.
- For play, await `play()` and expose autoplay rejection. Verify time advances between observations; `paused: false` alone does not prove playback is progressing.
- Mark inspection read-only; seek/play/pause mutating, with policy/allowlist coverage. Keep small output sizes and avoid returning unnecessary media URLs/tokens.

Acceptance: on a strict-CSP local video fixture and then the intended X video, seek to 0.5 yields approximately 388.27 seconds for a 776.533-second duration (within a declared tolerance, e.g. 2 seconds), and playback is observed advancing. Unknown duration, multiple videos, blocked play, and seek timeout must not report success.

### P1 — Repair coordinate input, without pretending it is trusted input

Files: `firefox-extension/page-runtime.js`, tests, additive schema definitions if new position controls are introduced.

- Reproduce click-driven versus pointerdown-driven slider behavior in fixtures. Preserve client coordinates in the final click event and dispatch exactly one activation sequence. Verify default activation on checkboxes, links, and buttons; disabled/covered controls must not fire.
- Add an explicit relative-position operation (x/y fractions 0..1) rather than quietly adding ignored fields to pinned upstream schemas. Aim inside the visible element, handle scrolling/clipping, and report covered targets.
- For native range controls, support value setters with appropriate input/change events. Custom ARIA sliders require site-supported keyboard/pointer interaction and readback; changing an ARIA attribute is not an implementation.
- Keep synthetic-event limitations explicit. Do not advertise trusted OS input, reliable CSS `:hover`, or arbitrary draggable-widget support.

Acceptance: center/fraction clicks carry matching down/up/click coordinates, zero double-activation, slider readback meets tolerance, and overlaid/disabled cases fail safely.

### P2 — Read-only locating and compact observations

- Keep `agent_browser_find` default click for compatibility. Add a separate read-only locate tool returning bounded candidate refs, accessible names, roles, useful attributes, scoped text, and match counts. It should support CSS plus text/role/name filters and an explicit ancestor scope; this is safer than emulating an undocumented slice of Playwright selector syntax.
- No implicit clicks or CSS changes in snapshots. A separate reveal operation can scroll/hover, poll for controls, and return a scoped snapshot with timeout/failure details. Never force CSS visibility and call it equivalent to genuine interaction.
- Include slider min/max/now/valuetext and compact media state in relevant observations. Let Ada verify a seek in one bounded read rather than several attribute calls while the controls disappear.
- Expose truncation and root match count. Multiple selectors currently inspect only the first subtree; do not imply a complete union result. Reduce redundant nested contenteditable nodes and unrelated feed content.
- Stable refs cannot prevent React recycling a live node for a different item. Investigate observation fingerprints (role/name/href/post identity) for high-risk actions; if identity changes, require re-observation. Never auto-resolve an old Like/Follow/Reply target onto a new post.

Acceptance: identify a post by text without navigation, scope its player uniquely among several videos, reveal controls or fail explicitly, and keep unrelated engagement controls out of routine observations.

## Deployment and acceptance checklist

1. Review diffs and retain the passing regression suite. Do not edit the active session JSONL or rewrite its history to hide previous failures.
2. Rebuild Zen; restart its persistent server when no Ada tool is in flight. Reload/update the extension. An already-injected runtime has an install guard, so a fresh page document may be required; coordinate that reload because it can lose playback position or unsaved page state.
3. Restart `ada-back` under its normal Bun/systemd environment to load the bridge fix. This pass has **not** restarted the user's services or extension.
4. Capture URL and media state before personal-browser acceptance; avoid reloading/navigating the user's tab without coordinating restoration. Start with read-only image/ref/error checks.
5. Once media/input work is implemented, run the authorized play/50%-seek task and verify actual time and progression. Restore the user's original paused/time state if desired. No engagement actions are part of acceptance.
6. Add a recorded deterministic X-like fixture: multiple posts/videos, React-style replacement, CSS/JS hidden controls, strict CSP, seek handlers using click coordinates, overlays, and delayed media metadata. Keep real X smoke tests opt-in and non-posting.

Success criterion: Ada can identify the intended post, observe its media, perform the requested operation, and cite measured state—or clearly report why verification failed. Fewer retries matter, but preventing confident false success matters more.
