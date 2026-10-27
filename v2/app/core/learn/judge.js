// 박자 맞추기(리듬게임)의 순수 판정 로직. 화면과 오디오를 모른다.
// 노트 = 그 레벨에서 탭해야 하는 카운트의 시각. 창 밖은 무시(가장 가까운 노트가
// 창 밖이면 탭 자체를 버린다 — 연타로 점수를 캘 수 없게).
//
// 판정 창은 **비대칭**이다: 사람은 소리보다 살짝 먼저 두드리는 게 정상이다
// (negative mean asynchrony, 20~50ms 선행이 정상 — Dalla Bella 2015·Manning&Schutz 2013).
// 대칭 창으로 잡으면 정상적으로 친 사람이 "자꾸 놓친다"고 느낀다. 그래서 이른(선행)
// 쪽을 더 관대하게 준다. diffMs > 0 = 늦음, < 0 = 빠름.
export const PERFECT_EARLY_MS = 60;
export const PERFECT_LATE_MS = 45;
export const GOOD_EARLY_MS = 115;
export const GOOD_LATE_MS = 90;
// 하위호환: 옛 상수를 참조하는 코드가 있으면 늦은 쪽 값을 쓴다.
export const PERFECT_MS = PERFECT_LATE_MS;
export const GOOD_MS = GOOD_LATE_MS;
const inWindow = d => d >= -GOOD_EARLY_MS && d <= GOOD_LATE_MS;
const isPerfect = d => d >= -PERFECT_EARLY_MS && d <= PERFECT_LATE_MS;

export const LEVELS = [
  { id: 'all', name: '모든 박자', desc: '들리는 박마다 탭', pick: c => true },
  { id: 'even', name: '짝수만', desc: '2 · 4 · 6 · 8에만 탭', pick: c => c.count % 2 === 0 },
  { id: 'ones', name: '1만', desc: '에이트가 시작될 때만 탭', pick: c => c.count === 1 },
  { id: 'intro', name: '5·6·7·8 들어가기', desc: '앱이 5·6·7·8을 불러 주면, 오는 1을 잡아요',
    pick: c => c.count === 1, cues: true },
  { id: 'five', name: '5 잡고 1 들어가기', desc: '귀는 5, 발은 1 — 둘 다 스스로 잡아요',
    pick: c => c.count === 5 || c.count === 1 },
];

// counts(레이아웃 산출)에서 이 레벨의 노트 목록을 만든다.
// from(초)부터 시작하고 limit개까지만 — 박자 테스트는 한 창(16박)만 친다.
export function makeChart(counts, levelId, { from = -Infinity, limit = Infinity } = {}) {
  const level = LEVELS.find(l => l.id === levelId);
  if (!level) throw new RangeError('Unknown level: ' + levelId);
  return counts.filter(c => c.time >= from && level.pick(c))
    .slice(0, limit)
    .map(c => ({ time: c.time, count: c.count }));
}

export function createGameState(chart) {
  return {
    chart,
    hit: new Array(chart.length).fill(null), // null | {judgment, diffMs}
    nextMiss: 0, // 이 인덱스 전까지는 판정이 끝났다
    combo: 0,
    maxCombo: 0,
  };
}

// 탭 한 번을 판정한다. musicTime = 귀에 들리는 시각 기준(화면 지연 보정 후).
// rate = 재생 속도. 판정 창과 오차(ms)는 사람이 겪는 실제 시간이므로 느린 재생에서는
// 음악 시간 차이를 rate로 나눠 실제 시간으로 환산한다(50%에서 80ms 늦은 탭은 80ms다).
export function judgeTap(state, musicTime, rate = 1) {
  if (!(rate > 0)) throw new RangeError('rate must be positive');
  let best = -1, bestAbs = Infinity, bestDiff = 0;
  for (let i = 0; i < state.chart.length; i++) {
    if (state.hit[i]) continue;
    const diff = (musicTime - state.chart[i].time) * 1000 / rate;
    if (Math.abs(diff) < bestAbs) { bestAbs = Math.abs(diff); best = i; bestDiff = diff; }
    // 아직 안 온 노트가 이른 관대창(GOOD_EARLY)보다 더 멀면 그 뒤는 볼 필요 없다
    if (state.chart[i].time > musicTime + GOOD_EARLY_MS * rate / 1000) break;
  }
  if (best === -1 || !inWindow(bestDiff)) return null; // 창 밖 — 버린다
  const diffMs = bestDiff;
  const judgment = isPerfect(diffMs) ? 'perfect' : 'good';
  state.hit[best] = { judgment, diffMs };
  state.combo += 1;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  return { index: best, judgment, diffMs, note: state.chart[best] };
}

// 시간이 지나 놓친 노트들을 Miss로 확정한다. 새로 놓친 목록을 돌려준다.
export function sweepMisses(state, musicTime, rate = 1) {
  const missed = [];
  while (state.nextMiss < state.chart.length) {
    const note = state.chart[state.nextMiss];
    if (state.hit[state.nextMiss]) { state.nextMiss += 1; continue; }
    if (musicTime - note.time > GOOD_LATE_MS * rate / 1000) { // 늦은 관대창을 넘겨야 놓침
      state.hit[state.nextMiss] = { judgment: 'miss', diffMs: null };
      state.combo = 0;
      missed.push({ index: state.nextMiss, note });
      state.nextMiss += 1;
    } else {
      break;
    }
  }
  return missed;
}

// 결과: 정확도 / 평균 오차(부호: +늦음 −빠름) / 흔들림(표준편차) / 콤보.
export function gameStats(state) {
  const judged = state.hit.filter(Boolean);
  const hits = judged.filter(h => h.judgment !== 'miss');
  const perfect = judged.filter(h => h.judgment === 'perfect').length;
  const diffs = hits.map(h => h.diffMs);
  const mean = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  const sd = diffs.length > 1
    ? Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1))
    : null;
  return {
    total: state.chart.length,
    judged: judged.length,
    perfect,
    good: hits.length - perfect,
    miss: judged.length - hits.length,
    accuracy: judged.length ? hits.length / judged.length : 0,
    meanMs: mean === null ? null : Math.round(mean),
    sdMs: sd === null ? null : Math.round(sd),
    maxCombo: state.maxCombo,
  };
}
