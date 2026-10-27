const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = Number.isFinite;
const reasons = [null, 'no_pulse', 'beat_uncertain', 'non_44', 'bar_uncertain', 'eight_uncertain'];
const confidence = v => v === null || (finite(v) && v >= 0 && v <= 1);

// Only omission is legacy-compatible; null or malformed restarts stay invalid.
export function normalizeEngineResult(r) {
  if (!object(r)) return r;
  const next = structuredClone(r);
  if (next.restarts === undefined) next.restarts = [];
  return next;
}

export function validateEngineResult(r) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  if (!object(r)) return { ok: false, errors: ['engine object'] };
  check(finite(r.duration) && r.duration >= 0, 'duration');
  check((typeof r.engineVersion === 'string' && r.engineVersion.length > 0) ||
    (Number.isInteger(r.engineVersion) && r.engineVersion > 0), 'engineVersion');
  const beats = Array.isArray(r.beats) ? Array.from(r.beats) : [];
  const counts = Array.isArray(r.counts) ? Array.from(r.counts) : [];
  const segments = Array.isArray(r.segments) ? Array.from(r.segments) : [];
  check(Array.isArray(r.beats), 'beats array');
  check(Array.isArray(r.counts) && counts.length === beats.length, 'counts length');
  check(Array.isArray(r.segments), 'segments array');
  let end = 0;
  segments.forEach((s, i) => {
    const at = `segments[${i}]`;
    if (!object(s)) { check(false, at + ' object'); return; }
    check(finite(s.start) && s.start === end && finite(s.end) &&
      s.end > s.start && s.end <= r.duration, at + ' coverage');
    end = s.end;
    check(['present', 'absent'].includes(s.pulse) && reasons.includes(s.reason), at + ' state');
    check(s.meter === null || (Number.isInteger(s.meter) && s.meter > 0), at + ' meter');
    check(['normal', 'half', 'double'].includes(s.tempoInterp), at + ' tempoInterp');
    for (const k of ['beatConf', 'tempoConf', 'barPhaseConf', 'eightPhaseConf'])
      check(confidence(s[k]), at + ' ' + k);
    check((s.pulse === 'absent') === (s.reason === 'no_pulse'), at + ' pulse reason priority');
    // No confidence threshold is invented here. Known causes determine priority.
    if (s.pulse === 'present' && s.reason !== 'beat_uncertain') {
      const allowed = s.meter === null ? ['bar_uncertain', 'non_44'].includes(s.reason)
        : s.meter === 4 ? [null, 'bar_uncertain', 'eight_uncertain'].includes(s.reason)
          : s.reason === 'non_44';
      check(allowed, at + ' meter reason priority');
    }
  });
  check(end === r.duration, 'segments coverage end');
  let si = 0;
  beats.forEach((b, i) => {
    const at = `beats[${i}]`;
    if (!object(b)) { check(false, at + ' object'); return; }
    check(finite(b.time) && b.time >= 0 && b.time < r.duration &&
      (i === 0 || b.time > beats[i - 1]?.time), at + ' time');
    check(confidence(b.beatConf), at + ' beatConf');
    while (si < segments.length && segments[si]?.end <= b.time) si++;
    const s = segments[si], c = counts[i];
    const covered = object(s) && s.start <= b.time && b.time < s.end;
    check(covered, at + ' segment');
    if (!object(c)) { check(false, `counts[${i}] object`); return; }
    check(reasons.includes(c.reason) && covered && c.reason === s.reason, `counts[${i}] reason priority`);
    const bar = Number.isInteger(c.barPos) && c.barPos >= 1 && c.barPos <= s?.meter;
    if (c.reason === null) {
      check(Number.isInteger(c.count) && c.count >= 1 && c.count <= 8 && bar &&
        c.barPos === (c.count - 1) % 4 + 1, `counts[${i}] numbered count/barPos`);
    } else if (c.reason === 'eight_uncertain') {
      check(c.count === null && bar, `counts[${i}] eight_uncertain count/barPos`);
    } else {
      check(c.count === null && c.barPos === null, `counts[${i}] uncertain count/barPos`);
    }
  });
  const restarts = r.restarts === undefined ? [] : r.restarts;
  check(Array.isArray(restarts), 'restarts array');
  if (Array.isArray(restarts)) Array.from(restarts).forEach((event, i) => {
    const at = `restarts[${i}]`;
    if (!object(event)) { check(false, at + ' object'); return; }
    const j = event.beatIndex;
    const indexOK = Number.isInteger(j) && j >= 0 && j < beats.length;
    check(indexOK, at + ' beatIndex');
    check(i === 0 || j > restarts[i - 1]?.beatIndex, at + ' order');
    check(finite(event.time) && indexOK && event.time === beats[j]?.time, at + ' time');
    const c = counts[j];
    check(indexOK && c?.count === 1 && c?.barPos === 1 && c?.reason === null, at + ' count');
    const s = segments.find(s => s?.start <= event.time && event.time < s?.end);
    check(s?.pulse === 'present' && s?.meter === 4 && s?.reason === null, at + ' segment');
    // A first head, a resumed chain and an already-aligned 8 -> 1 are not realignments.
    const previous = counts[j - 1], previousTime = beats[j - 1]?.time;
    const uninterrupted = indexOK && j > 0 && segments.filter(s =>
      s?.end > previousTime && s?.start <= event.time).every(s =>
      s.pulse === 'present' && s.meter === 4 && s.reason === null);
    check(uninterrupted && previous?.reason === null &&
      Number.isInteger(previous?.count) && previous.count !== 8, at + ' realignment');
  });
  return { ok: errors.length === 0, errors };
}
