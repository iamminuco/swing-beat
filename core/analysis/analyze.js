import { inspectSignal } from './signal.js';

function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function intervals(beats) { return beats.slice(1).map((t, i) => t - beats[i]); }

// Display summary only. Never replace local beat times with this fitted line.
function fittedBpm(beats) {
  if (beats.length < 2) return null;
  const n = beats.length, xMean = (n - 1) / 2;
  const yMean = beats.reduce((a, b) => a + b, 0) / n;
  let xy = 0, xx = 0;
  for (let i = 0; i < n; i++) {
    xy += (i - xMean) * (beats[i] - yMean); xx += (i - xMean) ** 2;
  }
  return 60 / (xy / xx);
}

function validateTimes(times, duration, name) {
  if (!Array.isArray(times)) throw new TypeError(`${name} must be an array`);
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || times[i] < 0 || times[i] >= duration ||
        (i > 0 && times[i] <= times[i - 1])) {
      throw new RangeError(`${name} must be finite, ordered, unique and inside the audio`);
    }
  }
}

// Exact postprocessor beat/downbeat output, in seconds, on this PCM's clock.
// Model metadata is required so a sample-rate/duration mismatch cannot hide.
export function buildGrid(model, { sr, duration, firstOnset }) {
  if (!Number.isFinite(sr) || sr <= 0 || !Number.isFinite(duration) || duration < 0 ||
      (firstOnset !== null && (!Number.isFinite(firstOnset) || firstOnset < 0 || firstOnset >= duration))) {
    throw new RangeError('Invalid PCM clock or first onset');
  }
  if (model?.sr !== sr || !Number.isFinite(model?.duration) ||
      Math.abs(model.duration - duration) > 0.5 / sr) {
    throw new RangeError('Model output and PCM clock differ');
  }
  validateTimes(model.beats, duration, 'beats');
  validateTimes(model.downbeats, duration, 'downbeats');
  // Beat This! postprocessing makes downbeats a subset of beats. Reject a
  // different interface rather than silently snapping timestamps from another clock.
  const beatSet = new Set(model.beats);
  if (model.downbeats.some(t => !beatSet.has(t))) {
    throw new RangeError('Downbeats must be a subset of beats');
  }
  let beats = firstOnset === null ? [] : model.beats.filter(t => t >= firstOnset);
  const retained = new Set(beats);
  const downbeats = model.downbeats.filter(t => retained.has(t));
  const rawIntervals = intervals(beats), med = median(rawIntervals);
  const rawBpm = med === null ? null : 60 / med;
  const warnings = [];
  const rawIndices = downbeats.map(t => beats.indexOf(t));
  const bars = intervals(rawIndices);
  const twoBeatRatio = bars.length ? bars.filter(n => n === 2).length / bars.length : null;
  if (twoBeatRatio > 0.4) warnings.push('possible_double_tempo');
  // 12-song reference run (2026-09-07): every real song has a stray non-4 bar
  // (clean songs 0.8~9%), while the three songs the user flagged as shaky bars
  // measured 18.7%/28.2%/47.4%. Warn on ratio, not on any single bar.
  const irregularBarRatio = bars.length ? bars.filter(n => n !== 4).length / bars.length : null;
  if (irregularBarRatio > 0.15) warnings.push('bar_alignment_needs_review');
  // Same front/back 40-interval windows as the retained experiment. Require
  // disjoint windows; a very short clip cannot establish a tempo change.
  let frontBpm = null, backBpm = null;
  if (rawIntervals.length >= 80) {
    frontBpm = 60 / median(rawIntervals.slice(0, 40));
    backBpm = 60 / median(rawIntervals.slice(-40));
    if (Math.max(frontBpm, backBpm) / Math.min(frontBpm, backBpm) >= 1.6) {
      warnings.push('tempo_changes_need_review');
    }
  }
  let tempoFactor = 1;
  if (rawBpm !== null && rawBpm < 110 && rawBpm * 2 >= 110 && rawBpm * 2 <= 290) {
    // Inserted midpoints are synthetic, not model output — say so out loud.
    tempoFactor = 2;
    warnings.push('tempo_doubled');
    beats = beats.flatMap((t, i) => i + 1 < beats.length ? [t, (t + beats[i + 1]) / 2] : [t]);
  } else if (rawBpm !== null && rawBpm > 290 && rawBpm / 2 >= 110 && rawBpm / 2 <= 290) {
    // Keep the first known bar start when choosing which alternating beats survive.
    tempoFactor = 0.5;
    warnings.push('tempo_halved');
    beats = beats.filter((_, i) => i % 2 === (rawIndices.length ? rawIndices[0] % 2 : 0));
  } else if (rawBpm !== null && (rawBpm < 110 || rawBpm > 290)) {
    warnings.push('tempo_out_of_range');
  }
  const correctedSet = new Set(beats);
  const keptDownbeats = downbeats.filter(t => correctedSet.has(t));
  // 스윙은 2·4 백비트가 세서 모델이 백비트를 다운비트로 착각, '1' 위상이 통째로 어긋나는 곡이 있다
  // (실측 2026-09-10: Moon River 96%→4%, As Long As I Live 98%→5%). 첫 다운비트 하나에만 의존하지 말고,
  // 다운비트가 가장 많이 몰리는 4박 위상을 격자 시작(1)으로 삼는다. 규칙적인 곡은 첫 다운비트가 이미
  // 최빈 위상이라 offset·카운트가 그대로 유지된다(잘 맞던 곡 회귀 없음, 실측 확인). 앞 비트는 pickup 처리.
  let offset = null;
  if (keptDownbeats.length) {
    const dbIdx = keptDownbeats.map(t => beats.indexOf(t));
    const votes = [0, 0, 0, 0];
    for (const i of dbIdx) votes[((i % 4) + 4) % 4] += 1;
    const firstPhase = ((dbIdx[0] % 4) + 4) % 4;
    let best = firstPhase; // 동률이면 첫 다운비트 위상 유지 → 기존 동작 보존
    for (let r = 0; r < 4; r++) if (votes[r] > votes[best]) best = r;
    offset = dbIdx.find(i => ((i % 4) + 4) % 4 === best);
    if (best !== firstPhase) warnings.push('downbeat_phase_corrected');
  } else if (beats.length) {
    warnings.push('no_downbeat');
  }
  if (beats.length < 2) warnings.push('insufficient_beats');
  // Count integrity, not bar-length statistics: the 1..8 numbering is modular
  // from the first downbeat, so ONE odd-length bar shifts every later count,
  // while 2+2-beat bars self-heal. Score EVERY model downbeat (a downbeat the
  // half-correction removed from the grid is misaligned by definition, not
  // evidence to discard) against the counting grid: on it and ≡ 0 mod 4 from
  // the anchor means a count 1 or 5. 12-song run: irregularBarRatio and this
  // drift measure point at DIFFERENT songs — both are kept on purpose.
  let misaligned = 0, firstDriftTime = null;
  if (offset !== null) {
    for (const t of downbeats) {
      const i = beats.indexOf(t);
      if (i === -1 || (i - offset) % 4 !== 0) {
        misaligned += 1;
        if (firstDriftTime === null) firstDriftTime = t;
      }
    }
  }
  const misalignedDownbeatRatio = downbeats.length && offset !== null
    ? misaligned / downbeats.length : null;
  if (misalignedDownbeatRatio > 0.05) warnings.push('count_drift_needs_review');
  const local = intervals(beats);
  return {
    sr, duration, firstOnset, beats, downbeats: keptDownbeats,
    // The engine's recorded proposal for 1 (provenance; the model cannot
    // resolve musical 1 vs 5). Runtime corrections live in the SongMap.
    barPhase: { offset, confidence: null },
    bpm: fittedBpm(beats),
    tempoCurve: local.map((dt, i) => ({ time: beats[i], bpm: 60 / dt })),
    tempoFactor, diagnostics: {
      rawBpm, frontBpm, backBpm, twoBeatRatio, irregularBarRatio,
      misalignedDownbeatRatio, firstDriftTime, warnings,
    },
  };
}

export function analyze(samples, sr, model, { waveformBins = 1024 } = {}) {
  const signal = inspectSignal(samples, sr, waveformBins);
  return { ...buildGrid(model, signal), waveform: signal.waveform };
}

// This initial layout has no user corrections yet. Pickups before the first
// downbeat have no numbered count, and the final count ends after one interval
// (0.5 s when the song has no interval to copy, so a count never has zero width).
export function layoutGrid(grid, phraseLen = 4) {
  if (![4, 6, 8].includes(phraseLen)) throw new RangeError('Phrase length must be 4, 6 or 8 eights');
  const { beats, duration, barPhase: { offset } } = grid;
  const counts = [];
  if (offset !== null) {
    for (let i = offset; i < beats.length; i++) {
      const n = i - offset;
      const lastInterval = i > 0 ? beats[i] - beats[i - 1] : 0.5;
      const end = beats[i + 1] ?? Math.min(duration, beats[i] + lastInterval);
      counts.push({ beat: i, time: beats[i], end, count: n % 8 + 1,
        eight: Math.floor(n / 8) + 1, phrase: Math.floor(n / (phraseLen * 8)) + 1 });
    }
  }
  return { counts, totals: {
    beats: beats.length, pickupBeats: offset ?? beats.length,
    fullEights: Math.floor(counts.length / 8),
    fullPhrases: Math.floor(counts.length / (phraseLen * 8)),
    endingCounts: counts.length % (phraseLen * 8),
  } };
}

export function countAt(layout, time) {
  if (!Number.isFinite(time)) throw new TypeError('Time must be finite');
  const a = layout.counts;
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid].time <= time) lo = mid + 1; else hi = mid;
  }
  const item = a[lo - 1];
  return item && time < item.end ? item : null;
}
