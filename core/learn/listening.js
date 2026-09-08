// 청음(듣기 검사) — BAT(Iversen & Patel 2008)·H-BAT의 지각 하위검사를 단순화한 것.
// 음악 2에이트 위에 카운트음을 「맞게」 또는 「어긋나게」 얹고 맞아요/틀려요를 고른다.
// 움직임이 필요 없어 「1을 못 듣는」 문제의 출발점이 된다(설계 §5).
// 어긋남 종류: 반 박자(halfbeat) · 시간 밀림(offset, 200→120→60ms로 점점 미세하게)
// · 1이 한 카운트 옆(onecount) · 1과 5가 바뀜(onefive, 후반에만).
// 카운트음은 1이 가장 크고 5가 중간(ONE_FIVE)이라 1의 위치 오류가 귀에 들린다.
// 순수 계산: 오디오·화면을 모른다.
import { fullWindows, pickWindow } from './windows.js';

export const WINDOW_COUNTS = 16;
export const LEAD_SECONDS = 0.35; // 창 앞에서 살짝 먼저 재생해 첫 1이 잘리지 않게

// 틀린 문제의 종류 순서(쉬움 → 어려움). 문제 수가 많으면 순환한다.
export const WRONG_ORDER = [
  { kind: 'halfbeat' }, { kind: 'offset', shiftMs: 200 }, { kind: 'offset', shiftMs: 120 },
  { kind: 'onecount' }, { kind: 'onefive' }, { kind: 'offset', shiftMs: 60 },
];

export const KIND_TEXT = {
  aligned: '카운트음이 음악과 맞았어요',
  halfbeat: '카운트음이 반 박자 어긋나 있었어요',
  offset: '카운트음이 조금 밀려 있었어요',
  onecount: '1이 한 카운트 옆에 있었어요',
  onefive: '1과 5가 바뀌어 있었어요',
};

function shuffledPositions(n, wrongCount, rng) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { // Fisher–Yates
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return new Set(idx.slice(0, wrongCount));
}

function clicksFor(window, counts, spec, rng) {
  const base = counts.slice(window.index, window.index + WINDOW_COUNTS);
  const sign = rng() < 0.5 ? -1 : 1;
  if (spec.kind === 'aligned') return base.map(c => ({ time: c.time, count: c.count }));
  if (spec.kind === 'offset') {
    return base.map(c => ({ time: c.time + sign * spec.shiftMs / 1000, count: c.count }));
  }
  if (spec.kind === 'halfbeat') {
    return base.map(c => ({ time: c.time + (c.end - c.time) / 2, count: c.count }));
  }
  const shift = spec.kind === 'onecount' ? sign : 4; // 1↔5 = 네 카운트 옆
  return base.map(c => ({ time: c.time, count: ((c.count - 1 + shift + 8) % 8) + 1 }));
}

// n문제를 만든다. 맞는 문제 ceil(n/2), 틀린 문제는 WRONG_ORDER 순서(쉬운 것부터).
// 어느 자리가 틀린 문제인지는 무작위. 1↔5는 항상 뒤쪽 절반에 둔다.
export function makeListeningQuiz(counts, n = 10, rng = Math.random) {
  if (!Number.isInteger(n) || n < 2) throw new RangeError('A quiz needs at least 2 questions');
  const windows = fullWindows(counts, WINDOW_COUNTS);
  if (!windows.length) throw new RangeError('이 곡에는 온전한 2에이트 구간이 없어요');
  const wrongCount = Math.floor(n / 2);
  const wrongAt = shuffledPositions(n, wrongCount, rng);
  const questions = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    let spec = { kind: 'aligned' };
    if (wrongAt.has(i)) {
      spec = WRONG_ORDER[w % WRONG_ORDER.length];
      w += 1;
    }
    const win = pickWindow(windows, rng);
    let clicks = clicksFor(win, counts, spec, rng);
    // 1↔5는 후반에만: 앞쪽 절반에 걸리면 반 박자 문제로 바꾼다
    if (spec.kind === 'onefive' && i < n / 2) {
      spec = WRONG_ORDER[0];
      clicks = clicksFor(win, counts, spec, rng);
    }
    questions.push({
      index: i,
      kind: spec.kind,
      shiftMs: spec.shiftMs ?? null,
      start: Math.max(0, win.start - LEAD_SECONDS),
      end: win.end,
      windowStart: win.start,
      clicks,
      answer: spec.kind === 'aligned' ? 'yes' : 'no',
    });
  }
  return questions;
}

// 가르침용 시범 한 쌍(맞는 예시 + 크게 어긋난 예시). 첫 온전한 창에서 결정론적으로 만든다.
// 어긋남은 반 박자(가장 크고 명백)로 — 초보가 "맞다/틀리다"의 뜻을 귀로 잡게 한다.
export function demoPair(counts) {
  const windows = fullWindows(counts, WINDOW_COUNTS);
  if (!windows.length) return null;
  const win = windows[0];
  const base = counts.slice(win.index, win.index + WINDOW_COUNTS);
  const wrap = clicks => ({
    start: Math.max(0, win.start - LEAD_SECONDS), end: win.end, windowStart: win.start, clicks,
  });
  return {
    aligned: wrap(base.map(c => ({ time: c.time, count: c.count }))),
    wrong: wrap(base.map(c => ({ time: c.time + (c.end - c.time) / 2, count: c.count }))), // 반 박자 어긋남
  };
}

// answers: 'yes'(맞아요) | 'no'(틀려요), 문제 순서대로. 미응답은 undefined → 틀림.
export function scoreListening(questions, answers) {
  const missed = [];
  let correct = 0;
  questions.forEach((q, i) => {
    if (answers[i] === q.answer) correct += 1;
    else missed.push({ index: i, kind: q.kind, shiftMs: q.shiftMs });
  });
  return { total: questions.length, correct, accuracy: correct / questions.length, missed };
}
