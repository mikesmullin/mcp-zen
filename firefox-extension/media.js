// HTMLMediaElement operations in the isolated content world, independent of CSP eval.
export function createMediaTools(win, { selectUnique, refFor, fail, checkDeadline, sleep, hover, clickAt, painted }) {
  const finite = (n) => Number.isFinite(n) ? n : null;
  function ranges(media) {
    return Array.from({ length: Math.min(media.seekable.length, 20) }, (_, i) => ({ start: media.seekable.start(i), end: media.seekable.end(i) }));
  }
  function state(media) {
    if (!media.isConnected) fail('Media element detached; locate the intended player again', 'STALE_REF');
    const duration = finite(media.duration);
    return {
      ref: refFor(media), kind: media.localName, observedAt: new Date().toISOString(),
      currentTime: finite(media.currentTime), duration,
      fraction: duration > 0 ? media.currentTime / duration : null,
      paused: media.paused, ended: media.ended, seeking: media.seeking,
      readyState: media.readyState, networkState: media.networkState,
      muted: media.muted, volume: media.volume, playbackRate: media.playbackRate,
      seekable: ranges(media), width: media.videoWidth || null, height: media.videoHeight || null,
      hasPoster: Boolean(media.poster), errorCode: media.error?.code ?? null,
      fullscreen: isFullscreen(media, win.document),
    };
  }
  function isFullscreen(media, doc) {
    if (!doc) return Boolean(media.webkitDisplayingFullscreen);
    const el = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement;
    if (el && (el === media || el.contains?.(media) || media.contains?.(el))) return true;
    if (media.webkitDisplayingFullscreen) return true;
    const btn = fullscreenControl(playerRoot(media));
    return /exit\s*full\s*screen/i.test(btn?.getAttribute?.("aria-label") || "");
  }
  function playerRoot(media) {
    return media.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], figure') || media.parentElement || media;
  }
  function fullscreenButtons(root) {
    return [...(root.querySelectorAll?.('button, [role=button]') || [])].filter((b) => /full\s*screen/i.test(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`));
  }
  function fullscreenControl(root, paintedFn) {
    const all = fullscreenButtons(root);
    return all.find((b) => !paintedFn || paintedFn(b)) || all[0] || null;
  }
  function candidates(selector, context) {
    const root = selector ? selectUnique(selector, context) : win.document;
    if (root.matches?.('video,audio') || root.localName === 'video' || root.localName === 'audio') return [root];
    return [...(root.querySelectorAll?.('video,audio') || [])];
  }
  function one(selector, context) {
    const all = candidates(selector, context);
    if (all.length !== 1) fail(`Expected one media element, found ${all.length}. Use zen_browser_media_state/zen_browser_locate and select the intended media ref.`, all.length ? 'AMBIGUOUS_TARGET' : 'ELEMENT_ERROR');
    return all[0];
  }
  async function until(media, predicate, deadline, message) {
    while (true) {
      if (!media.isConnected) fail('Media detached during operation; re-observe before retrying', 'STALE_REF');
      if (media.error) fail(`Media error ${media.error.code}`, 'MEDIA_ERROR');
      if (predicate()) return;
      if (Date.now() >= deadline) fail(`${message}. Observed: ${JSON.stringify(state(media))}`, 'VERIFICATION_FAILED');
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())), deadline + 1);
    }
  }
  return async function mediaTool(cmd, args, context) {
    const deadline = Math.min(context.deadline, Date.now() + (args.waitTimeoutMs ?? 5000));
    if (cmd === 'media_state') {
      const all = candidates(args.selector, context);
      const items = all.slice(0, 20);
      const before = items.map(state);
      if (args.sampleMs) {
        await sleep(args.sampleMs, context.deadline);
        return { media: items.map((el, i) => ({ ...state(el), timeAdvanced: el.currentTime - before[i].currentTime, sampleMs: args.sampleMs })), count: all.length, truncated: all.length > items.length };
      }
      return { media: before, count: all.length, truncated: all.length > items.length };
    }
    const media = one(args.selector, context);
    const before = state(media);
    checkDeadline(context.deadline);
    if (cmd === 'media_pause') {
      media.pause();
      if (!media.paused) fail('Pause was not observed', 'VERIFICATION_FAILED');
      return { verified: true, before, after: state(media) };
    }
    if (cmd === 'media_play') {
      let timer;
      try {
        await Promise.race([
          media.play(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Media play timed out; inspect state before retrying'), { code: 'VERIFICATION_FAILED' })), Math.max(1, deadline - Date.now())); }),
        ]);
      } catch (error) {
        fail(`Playback not verified (${error.name}): ${error.message}. Inspect zen_browser_media_state; autoplay may require a real user gesture.`, error.code === 'VERIFICATION_FAILED' ? error.code : 'PLAYBACK_REJECTED');
      } finally { clearTimeout(timer); }
      const startedAt = media.currentTime;
      await until(media, () => !media.paused && media.currentTime > startedAt + 0.05, deadline, 'Playback did not advance');
      return { verified: true, before, after: state(media), timeAdvanced: media.currentTime - startedAt };
    }
    if (cmd === 'media_seek') {
      if ((args.seconds === undefined) === (args.fraction === undefined)) fail('Specify exactly one of seconds or fraction', 'INVALID_ARGUMENT');
      if (args.fraction !== undefined && (!Number.isFinite(args.fraction) || args.fraction < 0 || args.fraction > 1)) fail('fraction must be between 0 and 1', 'INVALID_ARGUMENT');
      if (args.fraction !== undefined && !(Number.isFinite(media.duration) && media.duration > 0)) fail('Fractional seek requires a finite positive duration; inspect metadata first', 'UNSUPPORTED_CAPABILITY');
      const requestedTime = args.seconds ?? args.fraction * media.duration;
      if (!Number.isFinite(requestedTime) || requestedTime < 0 || (Number.isFinite(media.duration) && requestedTime > media.duration)) fail('Requested time is outside the media duration', 'INVALID_ARGUMENT');
      if (!ranges(media).some(({ start, end }) => requestedTime >= start && requestedTime <= end)) fail(`Requested time ${requestedTime} is outside seekable ranges ${JSON.stringify(ranges(media))}`, 'NOT_SEEKABLE');
      media.currentTime = requestedTime;
      const toleranceSeconds = args.toleranceSeconds ?? 1;
      await until(media, () => !media.seeking && Math.abs(media.currentTime - requestedTime) <= toleranceSeconds, deadline, `Seek to ${requestedTime}s not verified`);
      const after = state(media);
      if (after.paused !== before.paused) fail(`Playback state changed during seek. Observed: ${JSON.stringify(after)}`, 'VERIFICATION_FAILED');
      return { verified: true, requestedTime, toleranceSeconds, before, after };
    }
    if (cmd === 'media_fullscreen') {
      const doc = win.document;
      const currently = isFullscreen(media, doc);
      const want = args.on === true ? true : args.on === false ? false : !currently;
      if (want === currently) return { verified: true, method: 'already', before, after: state(media), fullscreen: currently, requested: want };
      const resume = args.resume ?? !media.paused;
      if (!want) {
        return { servo: { action: 'escape', want, resume, mediaSelector: args.selector }, requested: want, before };
      }
      if (args.phase !== 'target') {
        return { servo: { action: 'reveal', want, resume, mediaSelector: args.selector }, requested: want, before };
      }
      const root = playerRoot(media);
      let btn = fullscreenControl(root, painted);
      const ready = btn && (!painted || painted(btn));
      if (!ready) {
        if (!media.paused) {
          media.pause();
          return { servo: { action: 'paused-reveal', want, resume: true, mediaSelector: args.selector }, requested: want, before };
        }
        fail('No painted in-player Full screen control after OS hover (and pause fallback).', 'CHROME_HIDDEN');
      }
      const ref = refFor(btn);
      return {
        servo: { action: 'click', want, resume, mediaSelector: args.selector, selector: `@${ref}` },
        requested: want, before,
      };
    }
    fail(`Unknown media operation ${cmd}`, 'UNSUPPORTED_CAPABILITY');
  };
}
