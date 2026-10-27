import { learningInput, spanReference } from './eligibility.mjs';

// Eight-position windows retain v1's exact 1..8 sequence rule.
// Lower layers can use unnumbered beats; they never synthesize 1/5 labels.
export function fullWindows(engine, len = 16, conditions = {}, layer = 'eight') {
  if (!Number.isInteger(len) || len < 8 || len % 8 !== 0) {
    throw new RangeError('Window length must be a positive multiple of 8');
  }
  const { counts } = learningInput(engine, conditions);
  const out = [];
  for (let i = 0; i + len <= counts.length; i++) {
    const base = counts.slice(i, i + len);
    const numbered = base.every(c => c.count !== null);
    if (layer === 'eight' || numbered) {
      if (!base.every((c, k) => c.count === (k % 8) + 1)) continue;
    } else if (layer === 'bar') {
      if (!base.every((c, k) => c.barPos === k % 4 + 1)) continue;
    } else if (i % 8 !== 0) continue;
    const start = base[0].time, end = base.at(-1).end;
    if (spanReference(engine, start, end, layer, conditions)) out.push({ index: i, start, end });
  }
  return out;
}

export function pickWindow(windows, rng = Math.random) {
  if (!windows.length) throw new RangeError('No full window available');
  return windows[Math.min(windows.length - 1, Math.floor(rng() * windows.length))];
}
