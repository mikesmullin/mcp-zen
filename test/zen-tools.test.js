import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMediaTools } from '../firefox-extension/media.js';

const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const available = await access(executablePath).then(() => true, () => false);
const bundle = await readFile(new URL('../firefox-extension/dist/page-runtime.js', import.meta.url), 'utf8');
const html = await readFile(new URL('fixtures/media.html', import.meta.url));
const video = await readFile(new URL('fixtures/media.webm', import.meta.url));
const css = 'video{width:160px;height:90px}#slider{margin:30px;width:400px;height:25px;background:gray}.css-control{display:none}#css-player:hover .css-control{display:block}#css-player{width:150px;height:30px}';
const js = `window.clicks=[]; for(const type of ['mousedown','mouseup','click']) slider.addEventListener(type,e=>{clicks.push({type,x:e.clientX,y:e.clientY});if(type==='click')slider.setAttribute('aria-valuenow',100*(e.clientX-slider.getBoundingClientRect().left)/slider.clientWidth)}); player.addEventListener('mouseover',()=>player.querySelector('button').hidden=false); window.disabledClicks=0; disabled.addEventListener('click',()=>disabledClicks++);`;

test('additive tools: strict CSP media, verified seek/play/pause, locate, refs, relative click and reveal', { skip: !available, timeout: 30000 }, async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'");
    const [type, body] = req.url === '/media.webm' ? ['video/webm', video] : req.url === '/media.css' ? ['text/css', css] : req.url === '/media-fixture.js' ? ['text/javascript', js] : ['text/html', html];
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Accept-Ranges': 'bytes' }); res.end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(bundle);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2 && document.querySelector('video').seekable.length > 0);
  const run = (cmd, args = {}, context = {}) => page.evaluate(async ({ cmd, args, context }) => {
    try { return { data: await window.__mcpZenRuntime.run(cmd, args, { sessionId: 'media', deadline: Date.now() + 5000, ...context }) }; }
    catch (error) { return { error: { code: error.code, message: error.message } }; }
  }, { cmd, args, context });
  const ok = (r) => { assert.ok(!r.error, JSON.stringify(r.error)); return r.data; };
  const located = ok(await run('locate', { selector: 'article', text: 'overview' }));
  assert.equal(located.count, 1);
  const scoped = ok(await run('locate', { scope: located.candidates[0].ref, selector: 'video' }));
  assert.equal(scoped.count, 1);
  const ref = scoped.candidates[0].ref;
  const states = ok(await run('media_state'));
  assert.equal(states.count, 2);
  assert.equal((await run('media_seek', { selector: 'video', fraction: 0.5 })).error.code, 'AMBIGUOUS_TARGET');
  const seek = ok(await run('media_seek', { selector: ref, fraction: 0.5 }));
  assert.equal(seek.verified, true); assert.equal(seek.after.paused, true);
  assert.ok(Math.abs(seek.after.fraction - 0.5) < 0.05);
  assert.equal((await run('media_seek', { selector: ref, seconds: 100 })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await run('media_seek', { selector: ref, seconds: 1, fraction: 0.5 })).error.code, 'INVALID_ARGUMENT');
  assert.equal(ok(await run('media_play', { selector: ref })).verified, true);
  assert.ok(ok(await run('media_state', { selector: ref, sampleMs: 150 })).media[0].timeAdvanced > 0);
  assert.equal(ok(await run('media_pause', { selector: ref })).after.paused, true);
  const point = ok(await run('click_at', { selector: '#slider', x: 0.75, y: 0.5 }));
  assert.equal(point.dispatched, true);
  const events = await page.evaluate(() => window.clicks);
  assert.deepEqual(events.map((e) => e.type), ['mousedown', 'mouseup', 'click']);
  assert.ok(events.every((e) => Math.abs(e.x - point.x) < 1 && Math.abs(e.y - point.y) < 1));
  assert.ok(Math.abs(Number(await page.locator('#slider').getAttribute('aria-valuenow')) - 75) < 0.1);
  ok(await run('click', { selector: '#toggle' })); assert.equal(await page.locator('#toggle').isChecked(), true);
  assert.ok((await run('click_at', { selector: '#disabled' })).error);
  assert.equal(await page.evaluate(() => disabledClicks), 0);
  assert.equal(ok(await run('set_range', { selector: '#range', value: 70 })).observedValue, 70);
  assert.equal((await run('set_range', { selector: '#slider', value: 70 })).error.code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(ok(await run('reveal', { selector: '#player', controls: 'button', waitTimeoutMs: 200 })).revealed, true);
  assert.equal((await run('reveal', { selector: '#css-player', controls: '.css-control', waitTimeoutMs: 100 })).error.code, 'REVEAL_FAILED');
  const before = ok(await run('locate', { selector: '#recycled' }));
  await page.locator('#recycled').evaluate((el) => el.textContent = 'Like a different post');
  assert.equal((await run('click_at', { selector: before.candidates[0].ref })).error.code, 'STALE_REF');
  const snap = ok(await run('snapshot', { selector: '[role=slider]' }));
  assert.match(snap.snapshot, /aria-valuenow/);
  assert.equal(ok(await run('snapshot', { selector: 'article', interactive: false })).rootMatchCount, 2);
  const waiting = run('media_state', { selector: ref, sampleMs: 2000 }, { requestId: 'cancel-me' });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__mcpZenRuntime.cancel('cancel-me'));
  assert.equal((await waiting).error.code, 'CANCELLED');
});

test('media failure cases: unknown duration, unseekable target, autoplay rejection, stalled seek', async () => {
  const media = { isConnected: true, localName: 'video', currentTime: 0, duration: Infinity, paused: true, readyState: 0, seekable: { length: 0 }, play: async () => { throw new Error('autoplay blocked'); } };
  const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
  const run = createMediaTools({}, { selectUnique: () => ({ matches: () => true, ...media }), refFor: () => 'e1', fail, checkDeadline: () => {}, sleep: async () => {} });
  await assert.rejects(() => run('media_seek', { selector: 'video', fraction: 0.5 }, { deadline: Date.now() + 100 }), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(() => run('media_seek', { selector: 'video', seconds: 5 }, { deadline: Date.now() + 100 }), { code: 'NOT_SEEKABLE' });
  await assert.rejects(() => run('media_play', { selector: 'video' }, { deadline: Date.now() + 100 }), { code: 'PLAYBACK_REJECTED' });
  media.duration = 10; media.seeking = true; media.seekable = { length: 1, start: () => 0, end: () => 10 };
  await assert.rejects(() => run('media_seek', { selector: 'video', seconds: 5 }, { deadline: Date.now() - 1 }), { code: 'VERIFICATION_FAILED' });
});

test('media_fullscreen uses the element API and verifies document.fullscreenElement', async () => {
  const doc = { fullscreenElement: null, exitFullscreen: async function exit() { doc.fullscreenElement = null; } };
  const media = {
    isConnected: true, localName: 'video', currentTime: 1, duration: 10, paused: true,
    ended: false, seeking: false, readyState: 4, networkState: 1, muted: true, volume: 1,
    playbackRate: 1, seekable: { length: 1, start: () => 0, end: () => 10 }, poster: '', error: null,
    closest: () => null, parentElement: null,
    requestFullscreen: async function req() { doc.fullscreenElement = media; },
  };
  const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
  const run = createMediaTools({ document: doc }, { selectUnique: () => media, refFor: () => 'e1', fail, checkDeadline: () => {}, sleep: async () => {} });
  const entered = await run('media_fullscreen', { selector: 'video', on: true }, { deadline: Date.now() + 1000 });
  assert.equal(entered.verified, true);
  assert.equal(entered.fullscreen, true);
  assert.equal(entered.method, 'api');
  const left = await run('media_fullscreen', { selector: 'video', on: false }, { deadline: Date.now() + 1000 });
  assert.equal(left.fullscreen, false);
});
