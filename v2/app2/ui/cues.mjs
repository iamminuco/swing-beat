import { scheduleTone } from '../audio/click.mjs';

// UI-only plans: derived user numbers and listening questions are never EngineResults.
export function createCuePlayer({ clock, visibility = globalThis.document, tone = scheduleTone }) {
  let context = null, plan = [], next = 0, options = {}, disposed = false;
  const live = new Set();
  function reset() {
    for (const cancel of live) { try { cancel(); } catch {} }
    live.clear();
    next = plan.findIndex(c => c.time >= clock.snapshot().position);
    if (next < 0) next = plan.length;
  }
  const off = clock.subscribe(reset);
  visibility?.addEventListener('visibilitychange', reset);
  return {
    setContext(value) { context = value; },
    setPlan(value = [], settings = {}) { plan = value; options = settings; reset(); },
    reset,
    tick() {
      const s = clock.snapshot(), ctx = context;
      if (disposed || visibility?.hidden || s.paused || s.seeking || s.ended ||
          !ctx || ctx.state !== 'running') { reset(); return; }
      while (next < plan.length && plan[next].time < s.position + .15 * s.rate) {
        const c = plan[next++];
        if (c.time < s.position || options.enabled === false) continue;
        const n = c.count, accent = options.accent ?? 'OFF';
        const level = n === null ? 1 : accent === 'EVEN' ? (n % 2 === 0 ? 0 : 2)
          : accent === 'ONE_FIVE' ? (n === 1 ? 0 : n === 5 ? 1 : 2) : 1;
        let cancel;
        cancel = tone({ ctx, when: ctx.currentTime + (c.time - s.position) / s.rate + (options.lag ?? 0),
          count: n, level, kind: n === 1 ? 'kick' : 'click', volume: .85, done: () => live.delete(cancel) });
        live.add(cancel);
      }
    },
    dispose() { disposed = true; reset(); off(); visibility?.removeEventListener('visibilitychange', reset); },
  };
}
