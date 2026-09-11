import { inspectSignal } from './signal.js';

// 격자 엔진 버전 — buildGrid의 후처리 규칙이 바뀌면 올린다. 저장된 SongMap의 analysis.engine이 이 값과
// 다르면 앱이 곡을 열 때 다시 분석한다(사용자의 1·마커·설정은 유지). codex 2026-09-11: 저장곡은 analyze()를
// 건너뛰어 글리치 필터·템포 게이트 수리가 기존 곡에 전혀 적용되지 않았다.
//   1 = 첫 다운비트 앵커(9/7) · 2 = 다운비트 최빈 위상 투표(9/10) · 3 = 글리치 박 필터 + 템포 증거 게이트(9/11)
//   4 = 220 BPM 초과 옥타브 주의 경고(9/11 밤) — 경고만 바뀌어도 저장곡이 다시 받도록 올린다(codex 7차)
export const GRID_ENGINE = 4;

function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function intervals(beats) { return beats.slice(1).map((t, i) => t - beats[i]); }

// 물리적으로 불가능한 짧은 간격의 박(검출 글리치)을 버린다 — 마지막으로 남긴 박에서
// 곡 중앙 박간격의 GLITCH_RATIO 미만이면 글리치. 2026-09-11 codex 감사 실측(Shoo Fly Pie):
// 0.5초 펄스 곡에서 29.76초(직전 간격 0.32)·29.90초(0.14) 검출 중 29.76이 가짜였고, 이 한 박이
// 뒤 모든 박 인덱스를 +1 밀어 다운비트 mod-4 위상을 1→2로 뒤집었다. phaseVoteOffset은 인덱스
// 최빈 위상의 첫 다운비트를 고르므로 앞 30초 카운트가 통째로 버려졌다. 글리치를 빼면
// 인덱스가 일관돼 곡 처음부터 카운트된다. 0.7 = 정박 대비 30% 이른 박까지만 글리치로 봄
// (스윙의 박은 정속·스윙감은 8분음 층이라 실제 박이 30% 앞당겨지는 일은 드물다).
const GLITCH_RATIO = 0.7;
function dropImplausibleBeats(beats) {
  if (beats.length < 4) return { beats, dropped: 0 };
  const med = median(intervals(beats));
  if (med === null || med <= 0) return { beats, dropped: 0 };
  const kept = [beats[0]];
  let dropped = 0;
  for (let i = 1; i < beats.length; i++) {
    if (beats[i] - kept[kept.length - 1] >= GLITCH_RATIO * med) kept.push(beats[i]);
    else dropped += 1;
  }
  return { beats: kept, dropped };
}

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
// 다운비트가 가장 많이 몰리는 4박 위상의 첫 다운비트를 격자 시작(count 1)으로 고른다.
// 스윙은 2·4 백비트가 세서 모델이 백비트를 다운비트로 착각, '1' 위상이 통째로 어긋나는 곡이 있다
// (실측 2026-09-10: Moon River 96%→4%, As Long As I Live 98%→5%). 규칙적인 곡은 첫 다운비트가 이미
// 최빈 위상이라 첫 다운비트를 그대로 반환한다(잘 맞던 곡 회귀 없음). buildGrid와 런타임 effectiveGrid가
// 같은 offset을 쓰도록 공용으로 둔다 — 한쪽만 바꾸면 화면 카운트가 교정 안 되고 경고만 억제된다.
export function phaseVoteOffset(beats, downbeats) {
  if (!downbeats || !downbeats.length) return null;
  const dbIdx = downbeats.map(t => beats.indexOf(t)).filter(i => i >= 0);
  if (!dbIdx.length) return null;
  const votes = [0, 0, 0, 0];
  for (const i of dbIdx) votes[((i % 4) + 4) % 4] += 1;
  let best = ((dbIdx[0] % 4) + 4) % 4; // 동률이면 첫 다운비트 위상 유지 → 기존 동작 보존
  for (let r = 0; r < 4; r++) if (votes[r] > votes[best]) best = r;
  return dbIdx.find(i => ((i % 4) + 4) % 4 === best);
}

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
  const glitch = dropImplausibleBeats(beats);
  beats = glitch.beats;
  const retained = new Set(beats);
  const downbeats = model.downbeats.filter(t => retained.has(t));
  // 놓친 박 채우기(간격 2~4배에 합성 박)는 2026-09-11 실측으로 기각: GTZAN 83곡 A4 4곡↑ 4곡↓(상쇄),
  // 수업곡 12곡의 후보 5개는 전부 곡 끝 리타르단도(206~266초)였고 중간 놓침은 0개였다. 넣지 마라.
  const rawIntervals = intervals(beats), med = median(rawIntervals);
  const rawBpm = med === null ? null : 60 / med;
  const warnings = [];
  if (glitch.dropped > 0) warnings.push('glitch_beats_removed');
  const rawIndices = downbeats.map(t => beats.indexOf(t));
  const bars = intervals(rawIndices);
  const twoBeatRatio = bars.length ? bars.filter(n => n === 2).length / bars.length : null;
  const eightBeatRatio = bars.length ? bars.filter(n => n === 8).length / bars.length : null;
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
  // 템포 두 배/절반은 BPM 범위(110~290)만으로 정하지 않는다 — 모델 자신의 마디 증거가 있어야 한다.
  // 실측 2026-09-11 GTZAN 재즈 83곡(정답 있음): 범위만 보던 옛 규칙이 33곡을 두 배로 만들었는데
  // 그중 27곡은 모델 템포가 이미 정답이었고(규칙이 망침), 진짜 절반 템포였던 5곡은 모두 모델 마디가
  // 2박(twoBeatRatio 0.61~0.96)이었다. 즉 "느린데 마디가 2박" = 모델 박 층이 2분음표 → 두 배가 맞고,
  // "느린데 마디가 4박" = 그냥 느린 곡 → 건드리면 안 된다. 절반도 같은 논리(마디가 8박일 때만).
  // 수업곡 12곡은 전부 범위 안이라 이 규칙에 걸린 적이 없다(변화 없음).
  // 최소 증거: 마디 간격 4개 이상(codex 2026-09-11 반례 — 다운비트 2개, 간격 1개짜리 비율 1.0으로 곡 전체를 두 배로 만들 수 있었다).
  // 0.6은 원칙이 아니라 GTZAN 83곡에서 고른 경험 임계다(같은 곡셋에서 골라 재서 독립 검증 아님). 대조군(자동 변환 전부 끔):
  // 곡별 위상 65 vs 62로 3곡 유리하지만 박별 A4 recall 67.8 vs 71.5%·coverage 85.7 vs 88.8%·tempo_ok 66 vs 68로 불리 —
  // 곡별 위상 잣대는 절반 속도로 세도 1/5만 정답 1에 얹히면 통과하는 맹점이 있어 박별 잣대를 우선했다(판단, 가설).
  // 2박(또는 8박) 마디가 곡의 박 간격 절반 이상을 실제로 덮어야 한다 — 비율·최소 개수·첫~끝 span만으로는
  // 앞 5초에만 몰린 2박 마디 4개 + 끝에 다운비트 1개([0,2,4,6,8,63])가 전곡을 두 배로 만들었다(codex 3차 반례).
  // 30%는 앞 30%에만 2박 마디가 있는 [0,2,…,30,100]을 못 막았다(codex 4차) → 50%. GTZAN 실측: 두 배가 맞는 곡의
  // 커버리지 0.76~0.94, 오발동 2곡은 0.50·0.93 — 임계로 오발동을 가를 수는 없고, 국소 오검출만 막는 가드다.
  const TEMPO_EVIDENCE = 0.6, TEMPO_MIN_BARS = 4, TEMPO_MIN_COVERAGE = 0.5;
  const spanOf = n => beats.length > 1 ? n * bars.filter(b => b === n).length / (beats.length - 1) : 0;
  const twoBeatCoverage = spanOf(2), eightBeatCoverage = spanOf(8);
  let tempoFactor = 1;
  if (rawBpm !== null && rawBpm < 110 && rawBpm * 2 >= 110 && rawBpm * 2 <= 290 &&
      bars.length >= TEMPO_MIN_BARS && twoBeatRatio >= TEMPO_EVIDENCE && twoBeatCoverage >= TEMPO_MIN_COVERAGE) {
    // Inserted midpoints are synthetic, not model output — say so out loud.
    tempoFactor = 2;
    warnings.push('tempo_doubled');
    beats = beats.flatMap((t, i) => i + 1 < beats.length ? [t, (t + beats[i + 1]) / 2] : [t]);
  } else if (rawBpm !== null && rawBpm > 290 && rawBpm / 2 >= 110 && rawBpm / 2 <= 290 &&
             bars.length >= TEMPO_MIN_BARS && eightBeatRatio >= TEMPO_EVIDENCE && eightBeatCoverage >= TEMPO_MIN_COVERAGE) {
    // 살아남을 홀/짝은 '첫 다운비트'가 아니라 다운비트 다수의 홀짝으로 고른다 — 첫 다운비트만 따르면
    // 첫 마디가 9박인 곡에서 다운비트 12개 중 11개를 버렸다(codex 2026-09-11, 옛 테스트가 그 위험을 보여주고 있었다).
    tempoFactor = 0.5;
    warnings.push('tempo_halved');
    const odd = rawIndices.filter(i => i % 2 === 1).length;
    const parity = odd > rawIndices.length - odd ? 1 : 0; // 동률이면 짝수(첫 박 보존)
    beats = beats.filter((_, i) => i % 2 === parity);
  } else if (rawBpm !== null && (rawBpm < 110 || rawBpm > 290)) {
    warnings.push('tempo_out_of_range');
  }
  // 옥타브 주의: 220 BPM을 넘는 격자는 모델이 절반 템포(110~145)의 곡을 두 배로 들었을 가능성이 있다.
  // GTZAN 실측 2026-09-11: 앱 230~250 BPM인 9곡의 정답이 전부 115~126 BPM(모델 자신은 4박 마디로 일관해
  // 증거 게이트로는 못 가름). 카운트는 바꾸지 않고 배지로만 알린다 — 정답은 춤 감각(반 템포 버튼)이 정한다.
  const gridBpm = rawBpm === null ? null : rawBpm * tempoFactor;
  if (gridBpm !== null && gridBpm > 220) warnings.push('tempo_fast_review');
  const correctedSet = new Set(beats);
  const keptDownbeats = downbeats.filter(t => correctedSet.has(t));
  // 다운비트 최빈 위상으로 격자 시작(1)을 고른다 — 스윙 백비트 착각 자동교정(phaseVoteOffset).
  // ★ 같은 함수를 런타임 effectiveGrid(songmap.js)도 반드시 써야 실제 화면 카운트가 교정된다
  //   (여기 diagnostics 전용이 아니다 — 2026-09-10 reviewer가 런타임 미연결/경고억제 회귀를 잡음).
  const offset = phaseVoteOffset(beats, keptDownbeats);
  if (offset === null) {
    if (beats.length) warnings.push('no_downbeat');
  } else if (keptDownbeats.length && offset !== beats.indexOf(keptDownbeats[0])) {
    warnings.push('downbeat_phase_corrected');
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
  // 문턱 0.05→0.25 (2026-09-12): GTZAN 정답 대조에서 0.05는 위상이 맞는 곡 59개 중 33개(56%)에 경고를 냈고 틀린 9곡 중 6개를
  // 잡았다 — 거의 모든 곡에 「틀릴 수 있어요」를 띄우는 양치기. 맞는 곡의 어긋난 다운비트는 대부분 모델의 구간별 반마디 착각
  // (연속 어긋남이 위상 2였다가 복귀)이라 카운트 오류가 아니다. 0.25면 맞는 곡 16/59(27%)·틀린 곡 5/9. 수업곡 12곡은 9→2곡만.
  if (misalignedDownbeatRatio > 0.25) warnings.push('count_drift_needs_review');
  const local = intervals(beats);
  return {
    engine: GRID_ENGINE,
    sr, duration, firstOnset, beats, downbeats: keptDownbeats,
    // The engine's recorded proposal for 1 (provenance; the model cannot
    // resolve musical 1 vs 5). Runtime corrections live in the SongMap.
    barPhase: { offset, confidence: null },
    bpm: fittedBpm(beats),
    tempoCurve: local.map((dt, i) => ({ time: beats[i], bpm: 60 / dt })),
    tempoFactor, diagnostics: {
      rawBpm, frontBpm, backBpm, twoBeatRatio, eightBeatRatio, twoBeatCoverage, eightBeatCoverage, irregularBarRatio,
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
