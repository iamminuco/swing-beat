import { clone, validateEngineResult, normalizeUser, requireValue } from './schema.mjs';
import { normalizeEngineResult } from '../engine/result.mjs';
const factor = mode => ({ normal: 1, half: .5, double: 2 })[mode];
const at = (segments, time) => segments.find(s => time >= s.start && time < s.end);
const mod = (n, base) => ((n % base) + base) % base;
export function withManualTempo(user, engine, mode) {
  requireValue([null, 'half', 'double'].includes(mode), 'manual tempo');
  const e = validateEngineResult(engine), next = normalizeUser(user);
  next.corrections.manualTempo = mode;
  next.manualTempoBasis = mode === null ? null : {
    engineVersion: e.engineVersion,
    segments: e.segments.map(s => ({ id: JSON.stringify([e.engineVersion, s.start, s.end, s.tempoInterp]),
      start: s.start, end: s.end, tempoInterp: s.tempoInterp })),
  };
  return next;
}
// Raw positions advance only through usable 4/4 beats. Resume at the next bar.
function alignedBeats(e) {
  const original = e.beats.map((b, i) => ({ ...b, automatic: clone(e.counts[i]) }));
  let last = null, lastBar = null, seen = false;
  for (let si = 0; si < e.segments.length;) {
    const valid = s => s.pulse === 'present' && s.meter === 4 && s.reason !== 'beat_uncertain';
    if (!valid(e.segments[si])) { si++; continue; }
    const start = e.segments[si].start;
    let end = e.segments[si++].end;
    while (si < e.segments.length && valid(e.segments[si])) end = e.segments[si++].end;
    const run = original.filter(b => b.time >= start && b.time < end);
    const down = run.findIndex(b => b.automatic.barPos === 1);
    let base = last === null ? original.indexOf(run[0]) : last + 1;
    if (seen && down >= 0 && lastBar !== null)
      base += mod(lastBar - base, 4) - down;
    run.forEach((b, i) => {
      b.phase = base + i;
      b.phaseUncertain = seen && down < 0;
      if (b.automatic.barPos === 1) lastBar = b.phase;
      last = b.phase;
    });
    seen = true;
  }
  return original;
}
function tempoGrid(e, user, enabled) {
  const mode = user.corrections.manualTempo;
  const original = alignedBeats(e);
  if (!enabled || mode === null) return { beats: original.map(b => ({ ...b, position: b.phase })), changed: false, issues: [] };
  const basis = user.manualTempoBasis;
  const issues = [], ratios = [];
  for (const s of e.segments) {
    const covering = basis?.segments.filter(b => b.start < s.end && b.end > s.start) ?? [];
    const complete = covering.length && covering[0].start <= s.start &&
      covering[covering.length - 1].end >= s.end &&
      covering.every((b, i) => i === 0 || b.start === covering[i - 1].end);
    const desired = new Set(covering.map(b => factor(b.tempoInterp) * factor(mode)));
    const ratio = complete && desired.size === 1 ? [...desired][0] / factor(s.tempoInterp) : NaN;
    if (![.5, 1, 2].includes(ratio)) issues.push({ start: s.start, end: s.end,
      applyFailed: true, reason: 'tempo_basis_unavailable', engineVersion: basis?.engineVersion ?? null });
    ratios.push(ratio);
  }
  if (issues.length) return { beats: original.map(b => ({ ...b, position: b.phase })), changed: false, issues };
  const beats = [];
  const down = original.map((b, i) => b.automatic.barPos === 1 ? i : -1).filter(i => i >= 0);
  const odd = down.filter(i => mod(original[i].phase ?? i, 2)).length;
  const rawAnchor = user.corrections.oneAnchorTime ?? Math.min(...user.corrections.sectionOnes);
  let si = 0, previous = null;
  original.forEach(b => {
    while (e.segments[si].end <= b.time) si++;
    b.ratio = ratios[si];
    if (b.phase !== undefined) {
      b.position = previous === null ? b.phase * b.ratio
        : previous.position + (b.phase - previous.phase) * previous.ratio;
      previous = b;
    }
  });
  const origin = attachAnchor(original, rawAnchor, e.duration);
  const parity = !origin.applyFailed ? mod(original[origin.beatIndex].phase, 2) : odd > down.length - odd ? 1 : 0;
  const originPosition = !origin.applyFailed ? original[origin.beatIndex].position
    : original.find(b => mod(b.phase, 2) === parity && b.position !== undefined)?.position;
  let phaseLessStart = 0;
  original.forEach((b, i) => {
    const ratio = b.ratio;
    if (b.position !== undefined) phaseLessStart = i + 1;
    const keep = b.position === undefined ? (i - phaseLessStart) % 2 === 0
      : originPosition === undefined || Math.abs(mod(b.position - originPosition, 1)) < 1e-9;
    if (ratio !== .5 || keep) beats.push(b);
    if (ratio === 2 && i + 1 < original.length) {
      const right = original[i + 1], time = (b.time + right.time) / 2;
      if (at(e.segments, b.time).pulse !== 'present' ||
          at(e.segments, right.time).pulse !== 'present' || at(e.segments, time).pulse !== 'present') return;
      const s = at(e.segments, time);
      const position = s.meter !== 4 || s.reason === 'beat_uncertain' ? undefined
        : b.position !== undefined ? b.position + 1
        : right.position !== undefined ? right.position - 1 : undefined;
      beats.push({ time, beatConf: null, position,
        phaseUncertain: b.phaseUncertain || right.phaseUncertain,
        automatic: { count: null, barPos: null, reason: s.reason } });
    }
  });
  return { beats, changed: ratios.some(r => r !== 1), issues };
}
export function attachAnchor(beats, rawTime, duration) {
  let index = null, distance = Infinity, near = false;
  beats.forEach((b, i) => {
    const d = Math.abs(b.time - rawTime);
    const epsilon = 8 * Number.EPSILON * Math.max(1, Math.abs(rawTime), Math.abs(b.time));
    if (d <= .070 + epsilon) near = true;
    if (!Number.isFinite(b.position)) return;
    if (d < distance - epsilon) { distance = d; index = i; }
  });
  const epsilon = 8 * Number.EPSILON * Math.max(1, Math.abs(rawTime));
  const inRange = Number.isFinite(rawTime) && rawTime >= 0 && rawTime < duration;
  const ok = inRange && index !== null && distance <= .070 + epsilon;
  return { rawTime, time: ok ? beats[index].time : rawTime,
    beatIndex: ok ? index : null, position: ok ? beats[index].position : null, applyFailed: !ok,
    ...(ok ? {} : { reason: inRange && near ? 'no_phase' : 'no_beat',
      nearestPhaseTime: index === null ? null : beats[index].time }) };
}
// This is a derived user view, never an EngineResult or an evaluation truth.
export function reapplyCorrections(engine, inputUser, { enabled = true, mode = 'music' } = {}) {
  requireValue(['music', 'continuous'].includes(mode), 'count mode');
  const e = normalizeEngineResult(validateEngineResult(engine)), user = normalizeUser(inputUser);
  const grid = tempoGrid(e, user, enabled), beats = grid.beats;
  const c = user.corrections, anchors = [];
  const attach = rawTime => {
    const result = attachAnchor(beats, rawTime, e.duration);
    if (result.reason === 'no_beat') {
      const excluded = e.beats.filter(b => {
        const s = at(e.segments, b.time);
        return s.pulse !== 'present' || s.meter !== 4 || s.reason === 'beat_uncertain';
      });
      if (attachAnchor(excluded, rawTime, e.duration).reason === 'no_phase') result.reason = 'no_phase';
    }
    return result;
  };
  const anchor = (kind, rawTime) => {
    const result = { kind, ...attach(rawTime) };
    const saved = user.swapReturn?.find(r => r.kind === kind && r.time === rawTime);
    result.start = Math.min(result.time, saved?.originalTime == null ? result.time
      : attachAnchor(beats, saved.originalTime, e.duration).time);
    anchors.push(result);
    return result;
  };
  const global = c.oneAnchorTime === null ? null : anchor('oneAnchorTime', c.oneAnchorTime);
  if (c.oneFiveReturnTime !== null) anchor('oneFiveReturnTime', c.oneFiveReturnTime);
  const sections = c.sectionOnes.map(t => anchor('sectionOne', t)).sort((a, b) => a.rawTime - b.rawTime)
    .filter(a => !global || (a.applyFailed || global.applyFailed
      ? a.rawTime > global.rawTime : a.position > global.position));
  const taps = (user.truth?.taps ?? []).map(t => ({ kind: 'tap', ...attach(t) }));
  const autoOneTime = e.beats.find((b, i) => e.counts[i].count === 1)?.time;
  const fallback = autoOneTime === undefined ? null : attachAnchor(beats, autoOneTime, e.duration);
  let continuous = null, previousTime = 0;
  const counts = beats.map((b, i) => {
    const s = at(e.segments, b.time), automatic = b.automatic;
    let count = automatic.count, barPos = automatic.barPos, reason = s.reason, provenance = 'auto';
    if (mode === 'continuous') {
      if (e.segments.some(s => s.end > previousTime && s.start <= b.time && s.reason !== null))
        continuous = null;
      if (!continuous && automatic.count === 1 && s.reason === null && Number.isFinite(b.position))
        continuous = { time: b.time, beatIndex: i, applyFailed: false };
      previousTime = b.time;
    }
    // An unmatched section blocks an earlier correction until the next user section.
    const section = sections.filter(a => a.start <= b.time ||
      (!a.applyFailed && a.time <= b.time)).at(-1);
    const userAnchor = section ?? global;
    let chosen = enabled ? userAnchor : null;
    // One authority: effective user anchor, then the requested automatic counting mode.
    if (mode === 'continuous' && (!chosen || b.time < (chosen.start ?? chosen.time))) chosen = continuous;
    if (!chosen && enabled && grid.changed && mode === 'music') chosen = fallback;
    if (chosen && !chosen.applyFailed && b.time >= (chosen.start ?? chosen.time) &&
        s.pulse === 'present' && s.meter === 4 && s.reason !== 'beat_uncertain' && Number.isFinite(b.position)) {
      count = mod(b.position - beats[chosen.beatIndex].position, 8) + 1;
      barPos = (count - 1) % 4 + 1;
      const anchorTime = beats[chosen.beatIndex].time;
      const separated = e.segments.some(s => s.start < Math.max(anchorTime, b.time) &&
        s.end > Math.min(anchorTime, b.time) &&
        (s.pulse !== 'present' || s.meter !== 4 || s.reason === 'beat_uncertain'));
      reason = b.phaseUncertain && separated ? 'eight_uncertain' : null;
      if (reason) count = null;
      provenance = enabled && (chosen === userAnchor || grid.changed) ? 'user' : 'auto';
    } else if (grid.changed || mode === 'continuous') {
      count = null; barPos = mode === 'continuous' ? automatic.barPos : null;
      reason = s.reason ?? 'eight_uncertain';
    }
    // The view ends at the next beat, or before entering an uncertain/absent segment.
    let end = beats[i + 1]?.time ?? s.end;
    if (s.reason !== null) end = Math.min(end, s.end);
    for (const next of e.segments) {
      if (next.start > b.time && next.start < end && next.reason !== null) end = next.start;
    }
    requireValue(count === null || (Number.isInteger(count) && count >= 1 && count <= 8), 'derived count');
    return { beat: i, time: b.time, end, count, barPos, reason,
      automaticReason: s.reason, provenance, verified: false };
  });
  const restarts = e.restarts.map(({ time }) => {
    const result = attachAnchor(beats, time, e.duration);
    // Applied only when the number shown at that beat is the automatic restart itself.
    const shown = result.applyFailed ? null : counts[result.beatIndex];
    return { ...result, applied: mode === 'music' && shown?.count === 1 && shown.provenance === 'auto',
      message: '앱은 여기서 1로 다시 셌어요' };
  });
  return { beats: beats.map(({ automatic, phase, position, ratio, phaseUncertain, ...b }) => b), counts, anchors, taps, restarts,
    manualTempo: { basis: clone(user.manualTempoBasis ?? null), issues: grid.issues },
    applyFailed: anchors.some(a => a.kind !== 'oneFiveReturnTime' && a.applyFailed) || grid.issues.length > 0 };
}
export function swapOneFive(user, engine, { time = null } = {}) {
  const next = normalizeUser(user), c = next.corrections;
  delete next.swapBlocked;
  const view = reapplyCorrections(engine, next);
  const beats = tempoGrid(validateEngineResult(engine), next, true).beats;
  const global = view.anchors.find(a => a.kind === 'oneAnchorTime');
  const when = time ?? global?.time ?? view.counts.find(c => c.count === 1)?.time;
  const sections = view.anchors.filter(a => a.kind === 'sectionOne' &&
    (!global || (a.applyFailed || global.applyFailed
      ? a.rawTime > global.rawTime : a.position > global.position)))
    .sort((a, b) => a.rawTime - b.rawTime);
  const section = sections.filter(a => a.start <= when || (!a.applyFailed && a.time <= when)).at(-1);
  const chosen = section ?? global, kind = section ? 'sectionOne' : 'oneAnchorTime';
  const k = section ? sections.indexOf(section) : -1;
  const previous = section ? sections[k - 1] ?? global : null;
  const following = sections[k + 1];
  const canReturn = target => !target.applyFailed &&
    (!previous || target.time > Math.max(previous.rawTime, previous.time)) &&
    (!following || target.time < Math.min(following.rawTime, following.time));
  let records = next.swapReturn ?? [];
  // 실제로 움직이지 못하면 기록을 지우지 않고 원래 상태 그대로 막힘만 알린다(W2 r5 검토 P1)
  const blocked = swapBlocked => ({ ...normalizeUser(user), swapBlocked });
  const inverse = records.find(r => r.kind === kind && r.time === chosen?.rawTime);
  if (inverse) {
    const targetTime = inverse.originalTime ?? engine.beats.find((b, i) => engine.counts[i].count === 1)?.time;
    const target = attachAnchor(beats, targetTime, engine.duration);
    if (!target.applyFailed) {
      if (!canReturn(target)) {
        next.swapBlocked = { reason: 'neighbor_anchor', kind, time: chosen?.rawTime ?? targetTime };
        return next;
      }
      if (section) c.sectionOnes = c.sectionOnes.map(t => t === inverse.time ? inverse.originalTime : t);
      else {
        c.oneAnchorTime = inverse.originalTime;
        c.oneFiveReturnTime = inverse.oneFiveReturnTime;
      }
      next.swapReturn = records.filter(r => r !== inverse);
      c.source = next.swapReturn.length ? 'user' : inverse.source;
      if (!next.swapReturn.length) delete next.swapReturn;
      return next;
    }
    records = records.filter(r => r !== inverse);
    if (records.length) next.swapReturn = records;
    else delete next.swapReturn;
    if (!section) c.oneFiveReturnTime = null;
  }
  const pending = !section && c.oneFiveReturnTime !== null
    ? attachAnchor(beats, c.oneFiveReturnTime, engine.duration) : null;
  if (pending?.applyFailed) c.oneFiveReturnTime = null;
  const saved = { kind, originalTime: section?.rawTime ?? c.oneAnchorTime,
    oneFiveReturnTime: c.oneFiveReturnTime, source: records[0]?.source ?? c.source };
  const remember = t => {
    next.swapReturn = [...records, { ...saved, time: t,
      expectedReturnTime: c.oneFiveReturnTime, expectedSource: 'user' }];
    c.source = 'user';
  };
  if (pending && !pending.applyFailed) {
    if (!canReturn(pending)) {
      return blocked({ reason: 'neighbor_anchor', kind, time: chosen?.rawTime ?? c.oneAnchorTime });
    }
    c.oneAnchorTime = c.oneFiveReturnTime;
    c.oneFiveReturnTime = null;
    remember(c.oneAnchorTime);
    return next;
  }
  if (chosen?.applyFailed) return blocked({ reason: chosen.reason, kind, time: chosen.rawTime });
  const first = chosen ? (!chosen.applyFailed ? view.counts[chosen.beatIndex] : null)
    : view.counts.find(c => c.count === 1);
  if (!first || first.provenance !== 'user' && chosen) return blocked({ reason: 'no_user_count', kind, time: chosen?.rawTime ?? when });
  const position = beats[first.beat].position;
  const candidates = [position - 4, position + 4].flatMap(target =>
    beats.flatMap((b, i) => Number.isFinite(b.position) && b.position === target ? [i] : []));
  const i = candidates.find(i => view.beats[i] &&
    (!previous || view.beats[i].time > Math.max(previous.rawTime, previous.time)) &&
    (!following || view.beats[i].time < Math.min(following.rawTime, following.time)));
  if (i === undefined) {
    return blocked({ reason: 'neighbor_anchor_or_song_boundary_or_no_phase', kind,
      time: chosen?.rawTime ?? first.time });
  }
  if (section) {
    c.sectionOnes = c.sectionOnes.map(t => t === section.rawTime ? view.beats[i].time : t);
  } else {
    c.oneAnchorTime = view.beats[i].time;
    c.oneFiveReturnTime = view.beats[first.beat].time;
  }
  remember(view.beats[i].time);
  return next;
}
