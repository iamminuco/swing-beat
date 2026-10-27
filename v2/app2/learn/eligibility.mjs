import { validateEngineResult } from '../engine/result.mjs';

export const LAYERS = ['beat', 'bar', 'eight'];
export const LEVEL_LAYERS = { all: 'beat', even: 'bar', ones: 'eight', intro: 'eight', five: 'eight' };
export const KIND_LAYERS = { aligned: 'beat', halfbeat: 'beat', offset: 'beat', onecount: 'eight', onefive: 'eight' };

// Conditions describe the selected reference, never replacement count values.
// layers[layer] = {trusted?, source: 'auto'|'user', start?, end?}.
// User anchor coverage must be resolved by the caller. It is attribution only:
// neither a correction nor a continuous-mode number becomes musical truth.
export function learningInput(engine, conditions = {}) {
  const checked = validateEngineResult(engine);
  if (!checked.ok) throw new RangeError(checked.errors.join('; '));
  if (!['music', 'continuous'].includes(conditions.mode ?? 'music')) throw new RangeError('Unknown learning mode');
  for (const layer of LAYERS) {
    const c = conditions.layers?.[layer];
    if (c === undefined) continue;
    if (!c || typeof c !== 'object' || Array.isArray(c) ||
        !['auto', 'user'].includes(c.source ?? 'auto') ||
        (c.trusted !== undefined && typeof c.trusted !== 'boolean') ||
        (c.start !== undefined && (!Number.isFinite(c.start) || c.start < 0)) ||
        (c.end !== undefined && (!Number.isFinite(c.end) || c.end > engine.duration)) ||
        (c.start ?? 0) >= (c.end ?? engine.duration)) throw new RangeError('Invalid layer condition: ' + layer);
  }
  // V2_DESIGN 4.3: with no next beat a count ends where its own segment ends, not at the file end.
  const lastBeat = engine.beats.at(-1);
  const lastEnd = lastBeat && engine.segments.find(s => s.start <= lastBeat.time && lastBeat.time < s.end)?.end;
  const counts = engine.beats.map((b, i) => ({
    ...engine.counts[i], time: b.time, end: engine.beats[i + 1]?.time ?? lastEnd ?? engine.duration,
  }));
  return { engine, counts, conditions };
}

function supports(segment, layer) {
  if (segment.pulse !== 'present' || ['beat_uncertain', 'no_pulse'].includes(segment.reason)) return false;
  if (layer === 'beat') return true;
  if (segment.meter !== 4 || ['non_44', 'bar_uncertain'].includes(segment.reason)) return false;
  return layer === 'bar' || segment.reason === null;
}

function allowedBounds(engine, layer, conditions) {
  const rank = LAYERS.indexOf(layer);
  if (rank < 0) throw new RangeError('Unknown reference layer: ' + layer);
  if (layer === 'eight' && (conditions.mode ?? 'music') !== 'music') return null;
  let start = 0, end = engine.duration;
  for (const needed of LAYERS.slice(0, rank + 1)) {
    const c = conditions.layers?.[needed];
    if (c?.trusted === false) return null;
    start = Math.max(start, c?.start ?? 0);
    end = Math.min(end, c?.end ?? engine.duration);
  }
  return start < end ? { start, end } : null;
}

export function referenceRange(engine, time, layer, conditions = {}) {
  const bounds = allowedBounds(engine, layer, conditions);
  if (!bounds || time < bounds.start || time >= bounds.end) return null;
  let i = engine.segments.findIndex(s => s.start <= time && time < s.end);
  if (i < 0 || !supports(engine.segments[i], layer)) return null;
  let left = i, right = i;
  while (left > 0 && supports(engine.segments[left - 1], layer)) left--;
  while (right + 1 < engine.segments.length && supports(engine.segments[right + 1], layer)) right++;
  const source = conditions.layers?.[layer]?.source ?? 'auto';
  return {
    layer, source, sourceLabel: source === 'user' ? '사용자 확인' : '자동',
    matchText: source === 'user' ? '사용자 확인 기준과 일치' : '앱 안내와 일치',
    isGroundTruth: false,
    start: Math.max(bounds.start, engine.segments[left].start),
    end: Math.min(bounds.end, engine.segments[right].end),
  };
}

// A span is half-open. Checking the whole span catches gaps with no beat in them.
export function spanReference(engine, start, end, layer, conditions = {}) {
  const reference = referenceRange(engine, start, layer, conditions);
  return reference && end > start && end <= reference.end ? reference : null;
}

export function referenceSummary(references) {
  const sources = [...new Set(references.filter(Boolean).map(r => r.source))];
  return {
    sourceLabel: sources.length > 1 ? '혼합' : sources[0] === 'user' ? '사용자 확인' : sources.length ? '자동' : '기록 없음',
    matchText: sources.includes('auto') ? '앱 안내와 일치' : sources.length ? '사용자 확인 기준과 일치' : '채점할 구간 없음',
    isGroundTruth: false,
  };
}
