import { validateEngineResult as checkEngineResult } from '../engine/result.mjs';

export const SCHEMA_VERSION = 5;
export const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = Number.isFinite;
export function requireValue(condition, message) {
  if (!condition) throw new RangeError(message);
}
// Preserve the SongMap API: validate, throw on rejection, return an owned copy.
export function validateEngineResult(value) {
  const result = checkEngineResult(value);
  requireValue(result.ok, result.errors.join('; '));
  return clone(value);
}
export function defaultUser() {
  return { corrections: { oneAnchorTime: null, oneFiveReturnTime: null,
    sectionOnes: [], manualTempo: null, source: 'user' },
    truth: null, markers: [], phraseLen: 4, accent: 'EVEN', rate: 1,
    loop: null, latency: { screen: 0, click: 0 }, manualTempoBasis: null };
}
export function validateUser(user) {
  requireValue(object(user) && object(user.corrections), 'user corrections');
  const c = user.corrections;
  const time = t => finite(t) && t >= 0;
  for (const k of ['oneAnchorTime', 'oneFiveReturnTime'])
    requireValue(c[k] === null || time(c[k]), k);
  requireValue(Array.isArray(c.sectionOnes) && c.sectionOnes.every(time), 'sectionOnes');
  requireValue([null, 'half', 'double'].includes(c.manualTempo) &&
    ['user', 'structure'].includes(c.source), 'manualTempo/source');
  requireValue(user.truth === null || (object(user.truth) && Array.isArray(user.truth.taps) &&
    user.truth.taps.length > 0 && user.truth.taps.every((t, i, a) =>
      time(t) && (i === 0 || t > a[i - 1])) && typeof user.truth.recordedAt === 'string'), 'truth taps');
  requireValue(Array.isArray(user.markers) &&
    user.markers.every(m => object(m) && time(m.time) && typeof m.name === 'string'), 'markers');
  requireValue([4, 6, 8].includes(user.phraseLen) &&
    ['EVEN', 'ONE_FIVE', 'OFF'].includes(user.accent), 'phraseLen/accent');
  requireValue(finite(user.rate) && user.rate >= .5 && user.rate <= 1, 'rate');
  requireValue(user.loop === null || (object(user.loop) && time(user.loop.start) &&
    finite(user.loop.end) && user.loop.end > user.loop.start), 'loop');
  requireValue(object(user.latency) && ['screen', 'click'].every(k =>
    finite(user.latency[k]) && Math.abs(user.latency[k]) <= .3), 'latency');
  if (user.manualTempoBasis != null) {
    const b = user.manualTempoBasis;
    requireValue(object(b) && b.engineVersion != null && Array.isArray(b.segments) &&
      b.segments.every(s => object(s) && typeof s.id === 'string' && time(s.start) &&
        finite(s.end) && s.end > s.start &&
        ['normal', 'half', 'double'].includes(s.tempoInterp)), 'manualTempoBasis');
  }
  return clone(user);
}
// Explicit normalization at map read/write and correction-operation boundaries.
export function normalizeUser(user) {
  const next = validateUser(user), c = next.corrections;
  const time = t => finite(t) && t >= 0;
  // Drop inverse records as soon as their own anchor is edited or removed.
  if (Array.isArray(next.swapReturn)) {
    const staleGlobal = next.swapReturn.find(r => r?.kind === 'oneAnchorTime' && r.time !== c.oneAnchorTime);
    if (staleGlobal && c.oneFiveReturnTime === staleGlobal.expectedReturnTime)
      next.corrections.oneFiveReturnTime = null;
    next.swapReturn = next.swapReturn.filter(r => object(r) &&
      ['oneAnchorTime', 'sectionOne'].includes(r.kind) && time(r.time) &&
      (r.originalTime === null || time(r.originalTime)) && r.expectedSource === c.source &&
      (r.kind === 'oneAnchorTime'
        ? c.oneAnchorTime === r.time && c.oneFiveReturnTime === r.expectedReturnTime
        : c.sectionOnes.includes(r.time)));
    if (!next.swapReturn.length) delete next.swapReturn;
  } else if (next.swapReturn != null) {
    delete next.swapReturn;
  }
  return next;
}
// Invalid automatic output is isolated; a valid user object remains usable.
export function validateSongMap(raw) {
  requireValue(object(raw) && raw.schemaVersion === 5 && typeof raw.songKey === 'string' &&
    raw.songKey.length > 0 && Number.isSafeInteger(raw.revision) && raw.revision >= 0, 'v5 envelope');
  const user = normalizeUser(raw.user);
  let auto = null, autoError = null;
  if (raw.auto !== null) {
    try { auto = validateEngineResult(raw.auto); }
    catch (error) { autoError = error.message; }
  }
  const { auto: ignoredAuto, user: ignoredUser, ...rest } = raw;
  return { map: { ...clone(rest), auto, user }, autoRejected: autoError !== null, autoError };
}
export function createSongMap(songKey, auto = null, user = defaultUser()) {
  return validateSongMap({ schemaVersion: 5, songKey, revision: 0, auto, user });
}
