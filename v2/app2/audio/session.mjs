import { decodeToModelRate } from './decode.mjs';
import { createAudioClock } from './clock.mjs';
import { createClickScheduler } from './click.mjs';

let nextOpenToken = 0;

export function createAudioSession({ media, decode = decodeToModelRate, store = null, urls = globalThis.URL,
  contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
  gestureTarget = globalThis.window, ...options }) {
  let context = null, objectUrl = null, sequence = 0, disposed = false;
  const clock = createAudioClock(media);
  const resume = () => ['suspended', 'interrupted'].includes(context?.state) ? context.resume() : Promise.resolve();
  const scheduler = createClickScheduler({ ...options, clock, getContext: () => context, onVisible: wake });
  function wake() {
    if (disposed || !['suspended', 'interrupted'].includes(context?.state)) return;
    scheduler.reset();
    try { resume().catch(() => {}); } catch { /* next gesture can retry */ }
  }
  gestureTarget?.addEventListener('pointerdown', wake, { passive: true });
  // Call synchronously inside pointer/click handlers, before any await.
  function unlockFromGesture() {
    if (disposed) throw new Error('Audio session disposed');
    if (!context) context = contextFactory();
    scheduler.reset();
    return resume().then(() => context);
  }
  function activateElementFromGesture() {
    if (disposed) throw new Error('Audio session disposed');
    if (!media.src) { try { Promise.resolve(media.play()).catch(() => {}); } catch { /* no source yet */ } }
  }
  const isCurrentOpenToken = token => !disposed && sequence > 0 && token === sequence;
  async function open(load, key, persist) {
    if (disposed) throw new Error('Audio session disposed');
    const seq = sequence = ++nextOpenToken, current = () => !disposed && seq === sequence;
    try {
      const file = await load();
      if (!current()) return { status: 'superseded' };
      if (!file) throw new Error('Stored audio missing');
      const pcm = await decode(file);
      if (!current()) return { status: 'superseded' };
      const storageKey = typeof key === 'function' ? key({ ...pcm, file }) : key;
      const saved = persist && store && storageKey !== undefined ? await store.saveAudio(storageKey, file) : null;
      if (!current()) return { status: 'superseded' };
      const nextUrl = urls.createObjectURL(file);
      try { clock.replaceSource(nextUrl); }
      catch (error) { urls.revokeObjectURL(nextUrl); throw error; }
      const previous = objectUrl; objectUrl = nextUrl;
      if (previous) urls.revokeObjectURL(previous);
      scheduler.setResult(null); // A new source must never inherit the old song's counts.
      return { status: 'opened', file, ...pcm, saved, openToken: seq };
    } catch (error) {
      if (!current()) return { status: 'superseded' };
      throw error;
    }
  }
  return {
    clock, scheduler, unlockFromGesture, activateElementFromGesture,
    playFromGesture() { const ready = unlockFromGesture(); const playing = clock.play(); return Promise.all([ready, playing]); },
    getOpenToken: () => disposed || sequence === 0 ? null : sequence,
    isCurrentOpenToken,
    setResultForOpen(token, value) {
      if (!isCurrentOpenToken(token)) return false;
      scheduler.setResult(value); return true;
    },
    openFile: (file, { key } = {}) => open(() => file, key, true),
    openStored: key => open(() => store?.loadAudio(key), key, false),
    dispose() {
      if (disposed) return;
      disposed = true; sequence++;
      gestureTarget?.removeEventListener('pointerdown', wake);
      scheduler.dispose(); clock.dispose(); media.pause();
      media.removeAttribute('src'); media.load?.();
      if (objectUrl) { urls.revokeObjectURL(objectUrl); objectUrl = null; }
      if (context) context.close().catch(() => {});
    },
  };
}
