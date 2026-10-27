import { validateEngineResult } from '../engine/result.mjs';

const masters = new WeakMap();
function bus(ctx) {
  if (!masters.has(ctx)) {
    const master = ctx.createGain();
    master.gain.value = .9; master.connect(ctx.destination); masters.set(ctx, master);
  }
  return masters.get(ctx);
}
function levelFor(count, accent) {
  return count === null ? 1 : accent === 'EVEN' ? (count % 2 === 0 ? 0 : 2)
    : accent === 'ONE_FIVE' ? (count === 1 ? 0 : count === 5 ? 1 : 2) : 1;
}

// Returns a cancellation function for both future and already sounding tones.
export function scheduleTone({ ctx, when, level, volume, kind = 'click', done }) {
  if (volume <= 0) return () => {};
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  const kick = kind === 'kick', accent = kind === 'accent';
  const vol = accent ? volume : Math.min(.98, volume * (kick ? 1 : [ .85, .55, .3 ][level]));
  osc.type = accent ? 'triangle' : 'sine';
  if (kick || accent) {
    osc.frequency.setValueAtTime(kick ? 330 : 1500, when);
    osc.frequency.exponentialRampToValueAtTime(kick ? 180 : 900, when + (kick ? .08 : .03));
  } else osc.frequency.value = [1050, 840, 660][level];
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(vol, when + (kick ? .004 : accent ? .002 : .003));
  gain.gain.exponentialRampToValueAtTime(.0001, when + (kick ? .14 : accent ? .045 : .035));
  osc.connect(gain); gain.connect(bus(ctx));
  osc.onended = () => { osc.disconnect(); gain.disconnect(); done(); };
  osc.start(when); osc.stop(when + (kick ? .16 : accent ? .06 : .05));
  return () => {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(Math.max(.0001, gain.gain.value), now);
    gain.gain.exponentialRampToValueAtTime(.0001, now + .003);
    osc.stop(now + .004);
  };
}

export function createClickScheduler({ clock, getContext, visibility = globalThis.document,
  scheduleClick = scheduleTone, onVisible = () => {},
  setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval,
  lagClickMs = 0, accent = 'EVEN', volume = 1, clickOn = true,
}) {
  let result = null, next = 0, disposed = false;
  const live = new Set(), leadIn = new Set();
  function reset() {
    for (const cancel of [...live, ...leadIn]) { try { cancel(); } catch { /* ended node */ } }
    live.clear(); leadIn.clear();
    const time = clock.snapshot().position;
    let lo = 0, hi = result?.beats.length ?? 0;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (result.beats[mid].time < time) lo = mid + 1; else hi = mid; }
    next = lo;
  }
  function settings(options = {}) {
    const lag = options.lagClickMs ?? lagClickMs, mode = options.accent ?? accent, vol = options.volume ?? volume;
    const enabled = options.clickOn ?? clickOn;
    if (!Number.isFinite(lag) || lag < 0 || lag > 300 || !Number.isFinite(vol) || vol < 0 || vol > 1 ||
        !['EVEN', 'ONE_FIVE', 'OFF'].includes(mode) || typeof enabled !== 'boolean') throw new RangeError('Click options');
    return { lag, mode, vol, enabled };
  }
  function configure(options = {}) {
    const { lag, mode, vol, enabled } = settings(options);
    lagClickMs = lag; accent = mode; volume = vol; clickOn = enabled; reset();
  }
  function reserve(event, pending = live) {
    let cancel;
    cancel = scheduleClick({ ...event, done: () => pending.delete(cancel) });
    pending.add(cancel);
    return cancel;
  }
  function readyContext() {
    const ctx = getContext();
    return !disposed && !visibility?.hidden && ctx?.state === 'running' ? ctx : null;
  }
  function countIn(interval, rate, options = {}) {
    if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(rate) || rate <= 0)
      throw new RangeError('Count-in interval/rate');
    const { lag, mode, vol } = settings(options), ctx = readyContext(), s = clock.snapshot();
    if (!ctx || !result || s.seeking || s.ended || !Number.isFinite(s.position)) return 0;
    const i = result.beats.findIndex(b => b.time >= s.position), target = result.beats[i]?.time;
    // A 5-8 lead-in must lead to a known 1 without crossing an uncertain span.
    if (i < 0 || result.counts[i].count !== 1 || result.segments.some(g =>
      g.end > s.position && g.start <= target && (g.pulse !== 'present' || g.reason !== null))) return 0;
    const step = interval / rate;
    for (let i = 0; i < 4; i++) if (vol > 0) reserve({ ctx, count: 5 + i, kind: 'click',
      level: levelFor(5 + i, mode), volume: vol, when: ctx.currentTime + i * step + lag / 1000 }, leadIn);
    return 4 * step;
  }
  function accentClick(when, vol, count) {
    const ctx = readyContext(), s = clock.snapshot();
    if (!ctx || !result || s.paused || s.seeking || s.ended || !Number.isFinite(s.position) ||
        !Number.isFinite(s.rate) || s.rate <= 0 || !Number.isFinite(when) || !Number.isFinite(vol) ||
        !Number.isInteger(count) || count < 1 || count > 8 || count % 2 !== 0 || vol <= 0) return;
    const time = s.position + (when - ctx.currentTime - lagClickMs / 1000) * s.rate;
    const i = result.beats.findIndex(b => Math.abs(b.time - time) < 1e-6);
    if (i < 0 || result.counts[i].count !== count || result.counts[i].reason !== null) return;
    return reserve({ ctx, when, count, kind: 'accent', level: 0, volume: vol });
  }
  function tick() {
    if (disposed) return;
    const ctx = getContext(), s = clock.snapshot();
    if (visibility?.hidden || s.seeking || s.ended || !ctx || ctx.state !== 'running' ||
        !Number.isFinite(s.position) || !Number.isFinite(s.rate) || s.rate <= 0) { reset(); return; }
    // Lead-in is intentionally audible while media is paused. Media events still cancel it.
    if (s.paused) { if (!leadIn.size) reset(); return; }
    if (!result) { reset(); return; }
    const horizon = s.position + .15 * s.rate;
    while (next < result.beats.length && result.beats[next].time < horizon) {
      const i = next++, time = result.beats[i].time;
      if (time < s.position || (clickOn && volume === 0)) continue;
      const segment = result.segments.find(g => g.start <= time && time < g.end);
      if (!segment || segment.pulse === 'absent' || ['no_pulse', 'beat_uncertain'].includes(segment.reason)) continue;
      const count = segment.reason === null ? result.counts[i].count : null;
      if (!clickOn && (accent !== 'EVEN' || count === null || count % 2 !== 0)) continue;
      reserve({ ctx, index: i, time, count, level: levelFor(count, accent), volume: clickOn ? volume : .6,
        kind: !clickOn ? 'accent' : count === 1 ? 'kick' : 'click',
        when: Math.max(ctx.currentTime, ctx.currentTime + (time - s.position) / s.rate + lagClickMs / 1000) });
    }
  }
  function visible() { reset(); if (!visibility?.hidden) onVisible(); }
  const unsubscribe = clock.subscribe(reset);
  visibility?.addEventListener('visibilitychange', visible);
  configure();
  const timer = setInterval(tick, 25);
  return {
    tick, reset, configure, countIn, accentClick,
    setResult(value) {
      if (value !== null) {
        const validation = validateEngineResult(value);
        if (!validation.ok) throw new TypeError('Invalid EngineResult: ' + validation.errors.join(', '));
      }
      result = value === null ? null : structuredClone(value); reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true; clearInterval(timer); unsubscribe();
      visibility?.removeEventListener('visibilitychange', visible); reset();
    },
  };
}
