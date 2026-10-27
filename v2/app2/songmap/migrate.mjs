import { migrateSongMap as legacyValidate, songKey } from '../../app/core/songmap/schema.js';
import { layout as legacyLayout } from '../../app/core/songmap/songmap.js';
import { clone, validateSongMap, requireValue } from './schema.mjs';
import { normalizeEngineResult } from '../engine/result.mjs';

// Every renamed or relocated user field is explicit. Whole objects retain extra metadata.
export const LEGACY_USER_FIELDS = Object.freeze({
  corrections: 'user.corrections', truth: 'user.truth',
  'truth.ones': 'user.truth.taps', 'truth.recordedAt': 'user.truth.recordedAt',
  markers: 'user.markers', phraseLen: 'user.phraseLen', accent: 'user.accent',
  rate: 'user.rate', loop: 'user.loop', latency: 'user.latency',
});
const interp = factor => factor === .5 ? 'half' : factor === 2 ? 'double' : 'normal';
export function migrateSongMap(raw) {
  if (raw?.schemaVersion === 5) {
    const result = validateSongMap(raw);
    if (result.map.auto !== null) result.map.auto = normalizeEngineResult(result.map.auto);
    return result;
  }
  requireValue(Number.isInteger(raw?.schemaVersion) &&
    raw.schemaVersion >= 1 && raw.schemaVersion <= 4, 'legacy version');
  const normalized = legacyValidate(raw);
  const user = {};
  for (const [field, destination] of Object.entries(LEGACY_USER_FIELDS)) {
    const from = field.split('.'), to = destination.split('.').slice(1);
    if (from.length > 1 && user.truth === null) continue;
    const value = from.reduce((v, k) => v?.[k], raw) ??
      from.reduce((v, k) => v?.[k], normalized);
    const target = to.slice(0, -1).reduce((v, k) => v[k], user);
    target[to.at(-1)] = clone(value);
    if (from.length > 1 && from.at(-1) !== to.at(-1)) delete target[from.at(-1)];
  }
  user.corrections = { ...normalized.corrections, ...user.corrections };
  const a = normalized.analysis;
  user.manualTempoBasis = user.corrections.manualTempo === null ? null : {
    engineVersion: 'legacy:' + (a.engine ?? 'unknown'),
    segments: [{ id: JSON.stringify([a.engine, 0, a.duration, a.tempoFactor]),
      start: 0, end: a.duration, tempoInterp: interp(a.tempoFactor) }],
  };
  // An import receipt, not an EngineResult or a training label. Keep it after reanalysis.
  const legacy = { schemaVersion: raw.schemaVersion, song: clone(raw.song),
    analysis: clone(raw.analysis), display: clone(legacyLayout(normalized).counts) };
  return validateSongMap({ schemaVersion: 5, songKey: songKey(normalized.song),
    revision: 0, auto: null, user, legacy });
}
export function importedDisplay(map) {
  requireValue(Array.isArray(map.legacy?.display), 'no legacy import receipt');
  return clone(map.legacy.display);
}
export { songKey };
