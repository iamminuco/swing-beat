// Deterministic virtual clock: replaces setTimeout/setInterval/performance.now so results do not depend on CPU load.
const realImmediate = setImmediate;
let now = 0, nextId = 1; const timers = new Map();
export const vnow = () => now;
function add(fn, ms, interval, args) { const id = nextId++; timers.set(id, { id, at: now + Math.max(0, ms || 0), fn, interval, args }); return id; }
export function install() {
  globalThis.setTimeout = (fn, ms, ...args) => add(fn, ms, null, args);
  globalThis.setInterval = (fn, ms, ...args) => add(fn, ms, Math.max(1, ms || 0), args);
  globalThis.clearTimeout = globalThis.clearInterval = id => { timers.delete(id); };
  globalThis.performance = { now: () => now };
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => realImmediate(r)); };
export async function advance(ms) {
  const end = now + ms;
  for (;;) {
    let next = null;
    for (const t of timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
    if (!next) { now = end; await flush(); return; }
    now = next.at;
    if (next.interval) { next.at += next.interval; } else timers.delete(next.id);
    try { next.fn(...(next.args || [])); } catch (e) { console.error('timer error', e); }
    await flush();
  }
}
export async function settle(promise, maxMs = 20000, step = 5) {
  let done = false, value, error; promise.then(v => { done = true; value = v; }, e => { done = true; error = e; });
  for (let t = 0; t < maxMs && !done; t += step) await advance(step);
  if (error) throw error; return value;
}
