// Pure views and updates over a SongMap. Updates return a new map (the stored
// analysis is never mutated), so undo and save stay trivial.
// Rules from the agreed design: markers are time-anchored names for
// navigation/loops only and never restart the count; the correction sheet
// (1 한 박 앞/뒤 · 1↔5 · 프레이즈 길이 · 반/두 배) is what moves the counting grid.
// Every correction is folded into oneAnchorTime, the moment the user's 1 sits
// on, at press time — nothing is re-interpreted at view time, so a half/double
// switch can never flip the meaning of a stored correction. A 1↔5 press
// remembers its starting moment (oneFiveReturnTime) so a second press returns
// there exactly. Moving the anchor (withOneAt, withOneShift) clears that
// return point; tempo and phrase-length changes keep it — the return point is
// a time, so "press again to go back" stays true across grid switches.
import { layoutGrid, countAt, phaseVoteOffset, GRID_ENGINE } from '../analysis/analyze.js';
import { migrateSongMap, createSongMap, MARKER_EPSILON } from './schema.js';

function tempoBeats(analysis, manualTempo) {
  let beats = analysis.beats;
  let downbeats = analysis.downbeats;
  if (manualTempo === 'double') {
    beats = beats.flatMap((t, i) => i + 1 < beats.length ? [t, (t + beats[i + 1]) / 2] : [t]);
  } else if (manualTempo === 'half' && beats.length) {
    // 살아남을 홀/짝은 다운비트 다수결(자동 절반과 같은 규칙). 첫 다운비트만 따르면 첫 마디가 9박인 곡에서
    // 다운비트 15개 중 14개를 버리고 첫 1이 옮겨졌다(astra 2026-09-11 재현). 동률이면 짝수.
    const idx = downbeats.map(t => beats.indexOf(t)).filter(i => i >= 0);
    const odd = idx.filter(i => i % 2 === 1).length;
    const parity = odd > idx.length - odd ? 1 : 0;
    beats = beats.filter((_, i) => i % 2 === parity);
    const kept = new Set(beats);
    downbeats = downbeats.filter(t => kept.has(t));
  }
  return { beats, downbeats };
}

function nearestIndex(beats, time) {
  let best = 0;
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(beats[i] - time) < Math.abs(beats[best] - time)) best = i;
  }
  return best;
}

// The counting grid after user corrections, shaped for layoutGrid.
export function effectiveGrid(map) {
  const { beats, downbeats } = tempoBeats(map.analysis, map.corrections.manualTempo);
  const anchor = map.corrections.oneAnchorTime;
  let offset = null;
  if (beats.length && anchor !== null) {
    offset = nearestIndex(beats, anchor);
  } else if (downbeats.length) {
    // 첫 다운비트가 아니라 '다운비트 최빈 위상'을 격자 시작으로 — 스윙 백비트 착각 자동교정.
    // buildGrid와 같은 함수를 써야 화면 카운트가 실제로 교정된다(2026-09-10 reviewer 치명결함 수리).
    offset = phaseVoteOffset(beats, downbeats);
  }
  return { beats, downbeats, duration: map.song.duration, barPhase: { offset } };
}

// Counting restarts at 1 at every section anchor (구간별 「여기부터 1」).
// Segments are numbered as one continuous piece: a restart begins a NEW eight
// (the broken eight before it stays partial), and phrases follow the global
// eight numbers. Totals gain `sections`; endingCounts describes the last segment.
export function layout(map) {
  const grid = effectiveGrid(map);
  const { beats, duration, barPhase: { offset } } = grid;
  const sectionIdx = offset === null ? [] : [...new Set(
    map.corrections.sectionOnes.map(t => nearestIndex(beats, t)).filter(i => i > offset)
  )].sort((a, b) => a - b);
  if (!sectionIdx.length) return layoutGrid(grid, map.phraseLen);

  const starts = [offset, ...sectionIdx];
  const counts = [];
  let eightsBefore = 0;
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : beats.length;
    const segBeats = beats.slice(from, to);
    const segDuration = k + 1 < starts.length ? beats[starts[k + 1]] : duration;
    const seg = layoutGrid(
      { beats: segBeats, duration: segDuration, barPhase: { offset: 0 } },
      map.phraseLen);
    for (const c of seg.counts) {
      const eight = eightsBefore + c.eight;
      counts.push({ ...c, beat: c.beat + from, eight,
        phrase: Math.floor((eight - 1) / map.phraseLen) + 1 });
    }
    eightsBefore += Math.ceil(seg.counts.length / 8);
  }
  const fullEights = counts.filter(c => c.count === 8).length;
  return {
    counts,
    totals: {
      beats: beats.length,
      pickupBeats: offset ?? beats.length,
      fullEights,
      fullPhrases: Math.floor(fullEights / map.phraseLen),
      endingCounts: counts.length % (map.phraseLen * 8),
      sections: starts.length,
    },
  };
}

// 곡별 신뢰 배지 — 앱이 '자기가 맞는지' 스스로 표시한다(귀 없는 사용자용).
// ★정직: 정답(사람 탭/공개 데이터셋)이 없으면 '검증됨(초록)'은 절대 못 준다 —
//   서로 다른 자동도구도 스윙 백비트를 함께 착각할 수 있어 자기인증이 불가능하기 때문
//   (2026-09-11 codex+deep-reasoner 교차검증 결론). 그래서 여기선 앱이 아는 위험신호
//   (저장된 warnings)로 '확신/불확신'만 정직히 낸다. 어떤 곡이든 앱 내부값만으로 계산.
// 사용자 앵커(직접 맞춘 1·구간 1)가 지금 격자의 박 위에 있지 않은가 — 재분석·반/두 배 전환 뒤 생길 수 있다.
// 저장 경고가 아니라 볼 때마다 계산한다: 사용자가 「한 박」으로 다시 맞추면 앵커가 박 위에 얹혀 저절로 풀린다
// (codex 3차: 저장 경고는 해제 경로가 없었다). 판정은 앵커 옆 국소 박간격의 1/4(전곡 중앙값이면 국소 빠른 구간을 놓친다).
export function anchorsOffGrid(map, beats = effectiveGrid(map).beats) {
  const c = map.corrections ?? {};
  const anchors = [c.oneAnchorTime, ...(c.sectionOnes ?? [])].filter(t => t !== null && t !== undefined);
  if (!anchors.length) return false;
  if (beats.length < 2) return true; // 얹힐 격자가 없다
  return anchors.some(t => {
    const i = nearestIndex(beats, t);
    // 국소 간격 = 앵커가 실제로 든 구간(codex 4차: 반대쪽 긴 간격을 쓰면 [0,1,1.4,1.8]의 1.12를 놓친다)
    const after = i + 1 < beats.length ? beats[i + 1] - beats[i] : null;
    const before = i > 0 ? beats[i] - beats[i - 1] : null;
    const local = t >= beats[i] ? (after ?? before) : (before ?? after);
    return Math.abs(beats[i] - t) > 0.25 * local;
  });
}

// ── 사람 확인(정답 탭) — 귀 없이 "앱이 맞다"를 확인하는 유일한 정직한 길 (2026-09-11 하네스 설계·astra·sol 1순위) ──
// 사람 탭은 소리보다 20~50ms 이르거나 ~100ms 늦을 수 있다. 탭이 든 '구간'이 아니라 가장 가까운 카운트 시작(박)에
// 붙인다(이르면 이전 구간에 떨어져 한 박 틀리게 읽힌다). 허용 0.12초 = 최소 스윙 박간격(0.31s)의 절반 미만.
export const TAP_TOL = 0.12;

// 탭마다 "앱이 그때 몇을 세나"(count-at-tap). 실제 소비 경로(layout: 구간 1·반/두 배 포함)로 잰다.
// 희소한 탭에도 강건하고, mod-4 잣대가 못 보는 1↔5까지 잡는다.
export function countAtTaps(map, taps = map.truth?.ones ?? []) {
  const counts = layout(map).counts;
  const hist = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const byTap = [];
  let unmatched = 0;
  for (const t of taps) {
    let lo = 0, hi = counts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (counts[mid].time < t) lo = mid + 1; else hi = mid; }
    const cands = [counts[lo - 1], counts[lo]].filter(Boolean);
    const best = cands.sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t))[0];
    if (!best || Math.abs(best.time - t) > TAP_TOL) { unmatched += 1; byTap.push({ time: t, count: null }); continue; }
    hist[best.count] += 1;
    byTap.push({ time: t, count: best.count, beat: best.beat, snapped: best.time });
  }
  const n = taps.length - unmatched;
  let top = null;
  for (let c = 1; c <= 8; c++) if (top === null || hist[c] > hist[top]) top = c;
  // coverage = 곡을 에이트 길이 창으로 나눠, 맞은 탭이 든 창의 비율(분모는 곡 길이). 첫~끝 범위로 재면
  // 중간 공백(codex 10차: 탭 [1,5,33,37]이 91%)과 분석이 빠진 뒤쪽(박이 17초까지만)을 숨긴다.
  const eightDur = eightDuration(map);
  const windows = eightDur ? Math.max(1, Math.ceil(map.song.duration / eightDur)) : 0;
  const hit = new Set();
  if (eightDur) for (const b of byTap) if (b.count !== null) hit.add(Math.min(windows - 1, Math.floor(b.snapped / eightDur))); // 같은 박의 중복 탭은 한 창
  const coverage = windows ? hit.size / windows : 0;
  return { n, unmatched, total: taps.length, hist: hist.slice(1), top: n ? top : null,
    topShare: n ? hist[top] / n : 0, pct1: n ? hist[1] / n : 0,
    pct1All: taps.length ? hist[1] / taps.length : 0, coverage, byTap };
}

// 에이트(8박) 길이(초): 지금 격자 박 간격 중앙값 × 8. 박이 2개 미만이면 null.
function eightDuration(map) {
  const { beats } = effectiveGrid(map);
  if (beats.length < 2) return null;
  const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  return 8 * gaps[gaps.length >> 1];
}

// count-at-tap 히스토그램 → 사람이 읽을 판정 + 처방(tools/harness/score_beats.py verdict_from_cat와 같은 규칙).
export const TRUTH_MIN_TAPS = 4, TRUTH_MIN_PCT = 0.9, TRUTH_MAX_UNMATCHED = 0.2, TRUTH_MIN_COVERAGE = 0.7;
export function truthVerdict(cat) {
  if (!cat || cat.n === 0) return { ok: false, kind: 'unscorable', text: '탭이 앱 박에 안 맞아 채점 못 했어 — 탭을 더 정확히, 더 많이' };
  const pct = Math.round(cat.pct1 * 100);
  if (cat.unmatched / cat.total > TRUTH_MAX_UNMATCHED) {
    return { ok: false, kind: 'unscorable', text: `탭 ${cat.total}개 중 ${cat.unmatched}개가 어느 박에도 안 맞아(기기 지연 보정이 안 됐거나 탭이 흔들림) — 설정에서 「두드려 재기」 뒤 다시 기록해줘` };
  }
  if (cat.pct1 >= TRUTH_MIN_PCT) return { ok: true, kind: 'match', text: `✅ 사람 확인 — 탭 ${cat.n}개 중 ${pct}%가 카운트 1` };
  if (cat.topShare >= 0.6) {
    if (cat.top === 5) return { ok: false, kind: 'swap', text: `1과 5가 뒤바뀜(탭의 ${Math.round(cat.topShare * 100)}%가 5) — 1↔5로 고칠 수 있어` };
    const d = cat.top - 1 <= 4 ? cat.top - 1 : cat.top - 1 - 8;
    return { ok: false, kind: 'shift', delta: d, text: `전체가 한 방향으로 밀림(실제 1에서 앱은 ${cat.top}) — 「한 박 ${d > 0 ? '뒤' : '앞'}」 ${Math.abs(d)}번` };
  }
  return { ok: false, kind: 'sections', text: `중간부터 어긋남(탭이 여러 카운트에 흩어짐, 1은 ${pct}%) — 구간별 재고정 필요` };
}

export function withTruth(map, ones) {
  const clean = [...new Set(ones.map(t => +t))].filter(Number.isFinite).sort((a, b) => a - b);
  return updated(map, { truth: { ones: clean, recordedAt: new Date().toISOString() } });
}

// 되돌리기용: 이전 지도로 돌아가되 사람이 찍은 정답 탭은 잃지 않는다(codex 17차: 기록 직후 되돌리기가 탭을 지웠다).
// 지금 탭이 있으면 그대로, 지금 탭이 없으면(「지우기」 뒤) 이전 탭을 되살린다.
export function restoreKeepingTruth(prev, cur) {
  return migrateSongMap({ ...prev, truth: cur.truth ?? prev.truth ?? null });
}

export function withoutTruth(map) {
  return updated(map, { truth: null });
}

// 탭을 지금 격자의 박에 붙이고 같은 박의 중복 탭은 하나로 센다(codex 11차: 1.46·1.54는 증거 하나).
function snapTaps(map, taps) {
  const { beats } = effectiveGrid(map);
  const seen = new Map();
  for (const t of taps) {
    if (!beats.length) break;
    const i = nearestIndex(beats, t);
    if (Math.abs(beats[i] - t) <= TAP_TOL && !seen.has(i)) seen.set(i, beats[i]);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([idx, time]) => ({ idx, time }));
}

// 정답 탭으로 격자를 교정한다. 원칙: 탭은 '탭이 있는 곳'의 증거일 뿐이고, **이미 맞던 탭은 어떤 변경으로도 잃지 않는다**.
// ⓪ 첫 카운트보다 앞선 탭이 이어지는 탭(에이트 1.5개 안)으로 뒷받침되면 「여기가 1」(픽업으로 버려지던 정확한 탭, codex 11차).
// ① 기록된 구간 = 이웃 탭 간격이 에이트 1.5개 이하인 구간의 합. 없으면(희소 탭) 아무것도 바꾸지 않는다.
// ② 기록된 구간 안의 옛 구간 보정은 탭이 '반박할 때만'(빼도 맞던 탭을 하나도 잃지 않고 더 맞을 때) 지운다.
// ③ 첫 기록 구간의 첫·둘째 탭이 같은 비-1 카운트면 그 자리를 1로: 첫 에이트 안이면 곡 전체의 1, 아니면 「여기부터 1」.
// ④ 그래도 1이 아닌 탭이 (공백 없이) 연속 2개 이상이면 그 첫 탭에 「여기부터 1」. 단독 어긋남은 오탭으로 무시.
// 모든 변경(⓪③④)은 accept()를 통과해야 한다: 맞던 탭을 하나라도 잃으면 그 탭 자리에 보상 구간을 넣어 되살리고,
// 그래도 잃거나 맞는 탭이 늘지 않으면 변경을 버린다(codex 13차: 구간 5.5가 공백 뒤 37초의 정답을 깨뜨렸다).
export function applyTruth(map) {
  const taps = map.truth?.ones ?? [];
  if (taps.length < 2) return map;
  let m = withCorrections(map, { oneFiveReturnTime: null });
  let snapped = snapTaps(m, taps);
  if (snapped.length < 2) return map;
  const times = () => snapped.map(x => x.time);
  // 보존 검사와 run 판정은 사용자가 실제로 찍은 원래 탭으로 한다 — 스냅 시각은 격자가 바뀌면 다른 박에 붙어
  // 맞던 탭을 보존 대상에서 빠뜨린다(codex 14차: 0.841초가 앵커 이동 뒤 count 2로). 배지(songTrust)도 원래 탭을 쓴다.
  const onesOf = mm => new Set(countAtTaps(mm, taps).byTap.filter(b => b.count === 1).map(b => b.time));
  // ③④의 '증거'는 원래 탭이되 같은 박에 붙은 중복 탭은 하나로(codex 15차: [1.46,1.54]가 연속 증거 2개로 세어졌다).
  const distinctByBeat = byTap => { const seen = new Set(); return byTap.filter(b => b.count === null || (!seen.has(b.snapped) && seen.add(b.snapped))); };
  const eightDur = eightDuration(m) ?? Infinity;
  const accept = (cur, next) => {
    if (next === cur) return null;
    const before = onesOf(cur);
    let cand = next;
    const lost = [...before].filter(t => !onesOf(cand).has(t)).sort((a, b) => a - b);
    for (const t of lost) { const c2 = withSectionOne(cand, t); if (c2 === cand) return null; cand = c2; }
    const after = onesOf(cand);
    return [...before].every(t => after.has(t)) && after.size > before.size ? cand : null;
  };
  const linkedPairs = arr => { const out = []; for (let k = 1; k < arr.length; k++) if (arr[k] - arr[k - 1] <= 1.5 * eightDur) out.push([arr[k - 1], arr[k]]); return out; };
  {
    const first = layout(m).counts[0];
    if (first && snapped[0].time < first.time - 1e-9 && snapped[1] && snapped[1].time - snapped[0].time <= 1.5 * eightDur) {
      const next = accept(m, withOneAt(m, snapped[0].time));
      if (next) { m = next; snapped = snapTaps(m, taps); }
    }
  }
  const covered = linkedPairs(times());
  if (!covered.length) return m;
  const inCovered = t => covered.some(([a, b]) => t >= a - 1e-9 && t <= b + 1e-9);
  for (const sec of m.corrections.sectionOnes.filter(inCovered)) {
    const without = withCorrections(m, { sectionOnes: m.corrections.sectionOnes.filter(t => t !== sec) });
    const a = onesOf(m), b = onesOf(without);
    if ([...a].every(t => b.has(t)) && b.size > a.size) m = without;
  }
  {
    const byTap = distinctByBeat(countAtTaps(m, taps).byTap);
    const a = byTap.find(x => x.count !== null), b = a ? byTap[byTap.indexOf(a) + 1] : null;
    if (a && b && a.count !== 1 && b.count === a.count && Math.abs(covered[0][0] - a.snapped) < 1e-9) {
      const fc = layout(m).counts[0];
      const next = accept(m, fc && a.time <= fc.time + eightDur ? withOneAt(m, a.time) : withSectionOne(m, a.time));
      if (next) m = next;
    }
  }
  const tried = new Set();
  for (let guard = 0; guard < 16; guard++) {
    const byTap = distinctByBeat(countAtTaps(m, taps).byTap);
    let start = -1, found = null;
    for (let k = 0; k <= byTap.length; k++) {
      const off = k < byTap.length && byTap[k].count !== null && byTap[k].count !== 1 && !tried.has(byTap[k].time);
      const linked = off && start >= 0 && k > start && byTap[k].snapped - byTap[k - 1].snapped <= 1.5 * eightDur;
      if (off && start < 0) start = k;
      else if (off && !linked) { if (k - start >= 2) { found = byTap[start]; break; } start = k; }
      if (!off && start >= 0) { if (k - start >= 2) { found = byTap[start]; break; } start = -1; }
    }
    if (!found) break;
    tried.add(found.time);
    const next = accept(m, withSectionOne(m, found.time));
    if (next) m = next;
  }
  return m;
}

export function songTrust(map) {
  const w = new Set(map.analysis?.warnings ?? []);
  const { beats, barPhase: { offset } } = effectiveGrid(map);
  // 사람 확인이 있으면 그것이 최상위 근거다 — 자동 경고보다 앞선다. 정답만 초록.
  if (map.truth?.ones?.length) {
    const cat = countAtTaps(map);
    const v = truthVerdict(cat);
    const pct = Math.round(cat.pct1 * 100), cov = Math.round(cat.coverage * 100);
    if (v.ok && cat.n >= TRUTH_MIN_TAPS && cat.coverage >= TRUTH_MIN_COVERAGE) {
      return { level: 'verified', label: `✅ 사람이 확인 ${pct}%`,
        detail: `1을 아는 사람이 찍은 ${cat.n}번(곡의 ${cov}%) 중 ${pct}%가 앱의 1과 맞아요. 이 곡은 믿어도 돼요.` };
    }
    if (v.ok && cat.n >= TRUTH_MIN_TAPS) { // 앞부분만 기록 — 확인된 범위 밖은 보증 못 한다(codex 9차)
      return { level: 'partial', label: `🟡 앞부분만 확인 ${cov}%`,
        detail: `찍은 ${cat.n}번은 ${pct}% 맞지만 곡의 ${cov}%만 확인됐어요. 나머지는 아직 몰라요 — 끝까지 찍어 주세요.` };
    }
    return { level: 'caution', label: cat.n < TRUTH_MIN_TAPS && v.ok ? '🟡 더 찍어야 해요' : '🔴 찍은 1과 달라요',
      detail: cat.n < TRUTH_MIN_TAPS && v.ok ? `찍은 ${cat.n}번은 맞지만 ${TRUTH_MIN_TAPS}번 미만이라 확인으로 치지 않아요 — 더 찍어 주세요.`
        : v.text + ' — 곡 정보의 「찍은 1로 다시 맞추기」를 누르면 그 자리에 맞춰 고쳐요.' };
  }
  // 옛 엔진 분석(아직 재분석 전이거나 재분석이 실패한 곡)은 노랑 '자동'으로 보이면 안 된다(sol 2026-09-11):
  // 새 경고(예: 템포 확인)를 못 받은 상태다. 곡을 열면 다시 분석되고 이 표시는 사라진다.
  if ((map.analysis?.engine ?? null) !== GRID_ENGINE) {
    return { level: 'caution', label: '🔴 다시 확인 필요',
      detail: '박자 찾는 방법이 새로워졌는데 이 곡은 아직 옛 결과예요. 곡을 다시 열면 새로 분석해요(직접 맞춘 자리는 그대로). 방금 열었는데도 이 표시면 새 분석이 실패한 거예요.' };
  }
  if (w.has('manual_tempo_clamped')) {
    return { level: 'caution', label: '🔴 빠르기 다시 골라요',
      detail: '박자 찾는 방법이 새로워지면서 고른 반/두 배를 그대로 옮길 수 없었어요. 곡 정보에서 빠르기를 다시 골라 주세요 — 고르면 이 표시는 사라져요.' };
  }
  if (anchorsOffGrid(map, beats)) {
    return { level: 'caution', label: '🔴 맞춘 자리 확인',
      detail: '직접 맞춘 자리가 지금 박 위에 있지 않아요(새로 분석했거나 반/두 배를 바꿨을 때 생겨요). 숫자를 보며 「한 박」으로 다시 맞춰 주세요.' };
  }
  // 템포 확인은 저장 경고가 아니라 지금 격자의 실제 BPM으로 본다(astra: 240에서 「두 배」를 누르면 480인데 '자동'이 됐다).
  // 290 초과면 어떤 선택이든 확인, 220 초과는 사용자가 반/두 배를 아직 안 골랐을 때만.
  const bpm = tempoBpm(map);
  if (bpm !== null && (bpm > 290 || (bpm > 220 && map.corrections?.manualTempo === null))) {
    return { level: 'caution', label: '🔴 빠르기 확인',
      detail: bpm > 290
        ? `숫자가 1분에 ${bpm}번 — 춤출 수 있는 빠르기가 아니에요. 곡 정보에서 「반으로」를 눌러 보세요.`
        : '숫자가 두 배 빠를 수 있어요(느린 곡을 두 배로 들은 것). 곡 정보에서 「반으로」를 눌러 비교해 보세요.' };
  }
  if (map.corrections?.oneAnchorTime != null) {
    return { level: 'manual', label: '✋ 내가 맞춤',
      detail: '「한 박」이나 「여기가 1」로 직접 맞춘 곡이에요. 앱이 확인한 건 아니에요.' };
  }
  if (offset === null || beats.length < 2 || w.has('no_downbeat') || w.has('insufficient_beats')) {
    return { level: 'none', label: '🔴 1을 못 찾았어요',
      detail: '앱이 이 곡의 박자를 제대로 못 찾았어요. 다른 곡으로 연습하거나, 곡 정보에서 박자를 아는 사람과 맞춰 주세요.' };
  }
  if (w.has('bar_alignment_needs_review') || w.has('count_drift_needs_review')) {
    return { level: 'caution', label: '🔴 틀릴 수 있어요',
      detail: '박자가 들쭉날쭉하거나 중간부터 어긋날 수 있어요. 숫자를 보며 「한 박」으로 맞추거나, 박자를 아는 사람과 맞춰 주세요.' };
  }
  const corrected = w.has('downbeat_phase_corrected');
  return { level: 'auto', label: corrected ? '🟡 앱이 찾아 고침 · 확인 전' : '🟡 앱이 찾음 · 확인 전',
    detail: '앱이 자동으로 맞췄어요. 대체로 잘 맞지만 사람이 확인한 건 아니에요 — 어긋나 보이면 「한 박」으로 맞춰 주세요.' };
}

export function posOf(map, time) {
  return countAt(layout(map), time);
}

// 표시용 BPM: 보정 뒤 그리드의 박 간격 중앙값. 곡 정보 시트·목록이 쓴다.
export function tempoBpm(map) {
  const { beats } = effectiveGrid(map);
  if (beats.length < 2) return null;
  const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.round(60 / med);
}

export function timeOf(map, beatIndex) {
  const { beats } = effectiveGrid(map);
  return beats[beatIndex] ?? null;
}

function updated(map, patch) {
  return migrateSongMap({ ...map, ...patch });
}

function withCorrections(map, corrections) {
  return updated(map, { corrections: { ...map.corrections, ...corrections } });
}

// 여기가 1: anchor the count to the beat nearest this moment. This is also the
// recovery path for a song whose analysis produced no downbeat at all.
export function withOneAt(map, time) {
  if (!Number.isFinite(time)) throw new TypeError('Anchor time must be finite');
  const { beats } = effectiveGrid(map);
  if (!beats.length) return map;
  return withCorrections(map, {
    oneAnchorTime: beats[nearestIndex(beats, time)],
    oneFiveReturnTime: null,
  });
}

// Moving the 1 stores the target beat's time. Out-of-range is a no-op.
export function withOneShift(map, delta) {
  if (delta !== 1 && delta !== -1) throw new RangeError('One-shift moves one beat at a time');
  const { beats, barPhase: { offset } } = effectiveGrid(map);
  if (offset === null) return map;
  const next = offset + delta;
  if (next < 0 || next >= beats.length) return map;
  return withCorrections(map, { oneAnchorTime: beats[next], oneFiveReturnTime: null });
}

// 1↔5: jump half an eight in the CURRENT grid, folded into the anchor at press
// time. A second press restores the exact starting moment.
export function withOneFiveSwap(map) {
  if (map.corrections.oneFiveReturnTime !== null) {
    return withCorrections(map, {
      oneAnchorTime: map.corrections.oneFiveReturnTime,
      oneFiveReturnTime: null,
    });
  }
  const { beats, barPhase: { offset } } = effectiveGrid(map);
  if (offset === null) return map; // nothing to swap without a proposed 1
  const swapped = offset >= 4 ? offset - 4 : offset + 4;
  if (swapped < 0 || swapped >= beats.length) return map;
  return withCorrections(map, {
    oneAnchorTime: beats[swapped],
    oneFiveReturnTime: beats[offset],
  });
}

// The anchor is a time, so switching half/double and back recovers the exact
// user correction; the visible 1 snaps to the nearest beat of the new grid.
export function withManualTempo(map, manualTempo) {
  const clamped = map.analysis.warnings.includes('manual_tempo_clamped');
  if (manualTempo === map.corrections.manualTempo && !clamped) return map;
  // 'manual_tempo_clamped'는 분석이 아니라 보정에 대한 경고라, 사용자가 반/두 배를 (같은 값이라도) 다시 고르면
  // 여기서 지운다(analysis.warnings를 편집하는 유일한 예외 — codex 4·5차: 해제 경로가 없었다).
  const warnings = map.analysis.warnings.filter(w => w !== 'manual_tempo_clamped');
  return updated(map, { analysis: { ...map.analysis, warnings }, corrections: { ...map.corrections, manualTempo } });
}

export function withPhraseLen(map, phraseLen) {
  return updated(map, { phraseLen });
}

// 여기부터 1: counting restarts at the beat nearest this moment. This is the
// repair for a mid-song count break (one odd-length bar shifts every later
// count — measured on 11/12 real songs); the global 1 cannot fix it.
export function withSectionOne(map, time) {
  if (!Number.isFinite(time)) throw new TypeError('Section time must be finite');
  const { beats, barPhase: { offset } } = effectiveGrid(map);
  if (offset === null) return map; // a section restart needs a primary 1 first
  const idx = nearestIndex(beats, time);
  const snapped = beats[idx];
  if (snapped <= beats[offset]) return map;
  // 같은 박에 얹히는 옛 구간 앵커(재분석 뒤 격자에서 벗어난 시각 포함)는 새 앵커로 대체한다 —
  // 시각만 비교하면 10.25(이탈)와 10.0(새로 찍음)이 둘 다 남아 「확인 필요」가 안 풀린다(codex 4차).
  const sectionOnes = [
    ...map.corrections.sectionOnes.filter(t => Math.abs(t - snapped) >= MARKER_EPSILON && nearestIndex(beats, t) !== idx),
    snapped,
  ];
  return withCorrections(map, { sectionOnes });
}

export function withoutSectionOne(map, time) {
  return withCorrections(map, {
    sectionOnes: map.corrections.sectionOnes.filter(t => Math.abs(t - time) >= MARKER_EPSILON),
  });
}

function sameMarkerTime(a, b) {
  return Math.abs(a - b) < MARKER_EPSILON;
}

export function withMarker(map, time, name) {
  const markers = [...map.markers.filter(m => !sameMarkerTime(m.time, time)), { time, name }];
  return updated(map, { markers });
}

export function withoutMarker(map, time) {
  return updated(map, { markers: map.markers.filter(m => !sameMarkerTime(m.time, time)) });
}

// ── 저장된 곡을 새 엔진으로 다시 분석한 결과를 입힌다 (codex 2026-09-11 1차 Q5·2차 P1-2/P1-3) ──
// 분석(analysis)만 교체하고 사용자의 판단(직접 맞춘 1·구간 1·마커·프레이즈·강세·속도·루프·지연)은 그대로 둔다.
// ① 수동 반/두 배는 '옛 격자 기준 상대 배율'이라 그대로 복사하면 틀린다(옛 자동 2배 + 수동 half = 정답 96을,
//    새 자동 1배에 half를 또 적용하면 48). 사용자가 실제로 맞춘 박 층 = 옛 자동배율×수동배율을 새 자동배율 아래서 유지한다.
// ② 앵커는 시각으로 저장되니 살아남지만, 앵커가 얹혀 있던 박이 새 격자에 없으면(합성 박·글리치 박) 가장 가까운 박으로
//    옮겨진다 — 그 거리가 국소 박간격의 1/4을 넘으면 songTrust(anchorsOffGrid)가 볼 때마다 「확인 필요」를 띄운다.
const MANUAL_FACTOR = { half: 0.5, double: 2 };
function manualTempoFor(factor) { return factor === 2 ? 'double' : factor === 0.5 ? 'half' : null; }

export function refreshAnalysis(map, grid) {
  const built = createSongMap(map.song, grid);
  const warnings = [...built.analysis.warnings];
  // 재조준은 사용자가 반/두 배를 '직접 눌렀을 때만'. 무보정 곡에 옛 자동 배율을 되살리면 새 엔진이 고친
  // 오판(옛 자동 2배)을 수동 double로 부활시킨다(codex 3차 P1: 96 BPM 곡이 재분석 뒤 192).
  let manualTempo = null;
  if (map.corrections.manualTempo !== null) {
    const wanted = (map.analysis.tempoFactor ?? 1) * MANUAL_FACTOR[map.corrections.manualTempo]
      / (built.analysis.tempoFactor ?? 1);
    manualTempo = wanted === 1 ? null : manualTempoFor(wanted);
    if (wanted !== 1 && manualTempo === null) { // 1/4·4배는 표현 불가 — 가장 가까운 쪽으로 두고 알린다
      manualTempo = wanted > 1 ? 'double' : 'half';
      warnings.push('manual_tempo_clamped');
    }
  }
  const next = migrateSongMap({
    ...built,
    analysis: { ...built.analysis, warnings },
    corrections: { ...map.corrections, manualTempo },
    truth: map.truth === null ? null : { ...map.truth, ones: [...map.truth.ones] },
    markers: [...map.markers],
    phraseLen: map.phraseLen, accent: map.accent, rate: map.rate,
    loop: map.loop === null ? null : { ...map.loop },
    latency: { ...map.latency },
  });
  // 앵커 이탈은 저장 경고가 아니다 — songTrust가 anchorsOffGrid로 볼 때마다 계산한다(다시 맞추면 풀림).
  // oneFiveReturnTime은 시각이라 그대로 두며, 다시 누르면 새 격자의 가장 가까운 박에 얹힌다.
  // 사람 확인 탭이 있으면 새 격자에도 다시 적용해 검수된 카운트맵을 유지한다(엔진이 바뀌어도 정답이 앞선다).
  return next.truth ? applyTruth(next) : next;
}
