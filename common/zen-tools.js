// Additive Firefox capabilities. Never modify pinned agent-browser schemas.
const common = {
  session: { type: 'string', minLength: 1, description: 'Omit for the existing personal/logged-in tab. Named sessions use separate containers.' },
  namespace: { type: 'string', minLength: 1 },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 120000, default: 15000 },
};
const selector = { type: 'string', minLength: 1, description: 'A snapshot/locate/media ref (@eN or eN), or standard CSS. Must identify exactly one element for actions. No Playwright pseudo-selectors.' };
const fraction = { type: 'number', minimum: 0, maximum: 1 };
const waitTimeoutMs = { type: 'integer', minimum: 1, maximum: 30000, default: 5000 };
function tool(name, description, properties, required = [], readOnly = false, extra = {}) {
  return {
    name: `zen_${name}`, title: `Zen ${name.replaceAll('_', ' ')}`, description,
    inputSchema: { type: 'object', properties: { ...common, ...properties }, required, additionalProperties: false, ...extra },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
  };
}
export const zenTools = [
  tool('locate', 'Read-only: locate elements without clicking. Filter standard CSS by text/role/name inside a unique scope. Returns bounded candidates with refs and match counts; use the intended ref for actions.', {
    scope: selector, selector: { ...selector, default: '*' }, text: { type: 'string', minLength: 1 }, role: { type: 'string' }, name: { type: 'string' },
    exact: { type: 'boolean', default: false }, includeHidden: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
  }, [], true),
  tool('reveal', 'Explicit synthetic scroll/hover, then wait for visible matching controls inside a unique target and return a compact snapshot. Does not alter CSS; CSS-only hover may fail.', {
    selector, controls: { type: 'string', minLength: 1, description: 'Standard CSS for controls inside the target.' }, waitTimeoutMs,
  }, ['selector', 'controls']),
  tool('click_at', 'Click once at relative x/y fractions within a unique element using synthetic pointer/mouse events with consistent coordinates. Dispatch is NOT proof of application success; verify state afterwards.', {
    selector, x: { ...fraction, default: 0.5 }, y: { ...fraction, default: 0.5 },
  }, ['selector']),
  tool('set_range', 'Set a native input[type=range] value and dispatch input/change. Does not fake ARIA values on custom sliders. Verify application state afterwards.', {
    selector, value: { type: 'number' },
  }, ['selector', 'value']),
  tool('media_state', 'Read-only, CSP-independent HTML video/audio inspection: returns refs, time, duration, fraction, paused/ended/seeking, readiness, volume/mute and seekable ranges. Optional sampleMs measures actual time progression. No page eval or screenshot inference needed.', {
    selector, sampleMs: { type: 'integer', minimum: 0, maximum: 3000, default: 0 },
  }, [], true),
  tool('media_seek', 'Seek one unambiguous HTML video/audio by seconds OR fraction, preserving paused/playing state. Verifies actual time after seeking, returns requested and observed state, or fails explicitly. Use media_state first; works under page CSP.', {
    selector, seconds: { type: 'number', minimum: 0 }, fraction, toleranceSeconds: { type: 'number', minimum: 0.01, maximum: 2, default: 1 }, waitTimeoutMs,
  }, ['selector'], false, { oneOf: [{ required: ['seconds'], not: { required: ['fraction'] } }, { required: ['fraction'], not: { required: ['seconds'] } }] }),
  tool('media_play', 'Play one unambiguous HTML video/audio and verify that media time advances. Exposes autoplay rejection or stalled playback as an error. Does not change mute/volume.', { selector, waitTimeoutMs }, ['selector']),
  tool('media_pause', 'Pause one unambiguous HTML video/audio and verify paused state. Does not seek or change volume.', { selector }, ['selector']),
];
