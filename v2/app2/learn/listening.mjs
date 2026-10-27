import { learningInput, KIND_LAYERS, spanReference, referenceSummary } from './eligibility.mjs';
// 청음(듣기 검사) — BAT(Iversen & Patel 2008)·H-BAT의 지각 하위검사를 단순화한 것.
// 음악 2에이트 위에 카운트음을 「맞게」 또는 「어긋나게」 얹고 맞아요/틀려요를 고른다.
// 움직임이 필요 없어 「1을 못 듣는」 문제의 출발점이 된다(설계 §5).
// 어긋남 종류: 반 박자(halfbeat) · 시간 밀림(offset, 200→120→60ms로 점점 미세하게)
// · 1이 한 카운트 옆(onecount) · 1과 5가 바뀜(onefive, 후반에만).
// 카운트음은 1이 가장 크고 5가 중간(ONE_FIVE)이라 1의 위치 오류가 귀에 들린다.
// 순수 계산: 오디오·화면을 모른다.
import { fullWindows, pickWindow } from './windows.mjs';

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

// EngineResult plus explicit layer/source conditions; no raw display arrays.
export function makeListeningQuiz(engine, conditions = {}, n = 10, rng = Math.random) {
  if (!Number.isInteger(n) || n < 2) throw new RangeError('A quiz needs at least 2 questions');
  const { counts } = learningInput(engine, conditions);
  const byLayer = Object.fromEntries(['beat', 'eight'].map(layer =>
    [layer, fullWindows(engine, WINDOW_COUNTS, conditions, layer)]));
  if (!byLayer.beat.length) return [];
  const wrongAt = shuffledPositions(n, Math.floor(n / 2), rng);
  const questions = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    let spec = { kind: 'aligned' };
    if (wrongAt.has(i)) spec = WRONG_ORDER[w++ % WRONG_ORDER.length];
    if (!byLayer[KIND_LAYERS[spec.kind]].length) spec = WRONG_ORDER[0];
    const win = pickWindow(byLayer[KIND_LAYERS[spec.kind]], rng);
    let clicks = clicksFor(win, counts, spec, rng);
    // Preserve v1 RNG calls as well as its second-half 1/5 rule.
    if (spec.kind === 'onefive' && i < n / 2) {
      spec = WRONG_ORDER[0];
      clicks = clicksFor(win, counts, spec, rng);
    }
    const layer = KIND_LAYERS[spec.kind];
    if (layer === 'beat' && !spanReference(engine, win.start, win.end, 'eight', conditions)) {
      clicks = clicks.map(c => ({ ...c, count: null }));
    }
    const span = cs => {
      const last = Math.max(...cs.map(c => c.time));
      const e = Math.max(win.end, last + Number.EPSILON * Math.max(1, Math.abs(last)));
      return { end: e, reference: spanReference(engine, Math.min(win.start, ...cs.map(c => c.time)), e, layer, conditions) };
    };
    let { end, reference } = span(clicks);
    if (!reference && spec.kind === 'offset') { // mirror the shift (no RNG use) before giving up
      clicks = clicks.map((c, k) => ({ ...c, time: 2 * counts[win.index + k].time - c.time }));
      ({ end, reference } = span(clicks));
    }
    if (!reference) continue; // A shifted click must not enter an excluded interval.
    questions.push({
      index: i, kind: spec.kind, shiftMs: spec.shiftMs ?? null,
      start: Math.max(0, win.start - LEAD_SECONDS, reference.start),
      end, windowStart: win.start, clicks,
      answer: spec.kind === 'aligned' ? 'yes' : 'no',
      layer, reference, engineVersion: engine.engineVersion,
    });
  }
  return questions;
}

export function demoPair(engine, conditions = {}) {
  const { counts } = learningInput(engine, conditions);
  const windows = fullWindows(engine, WINDOW_COUNTS, conditions, 'beat');
  if (!windows.length) return null;
  const win = windows[0];
  const reference = spanReference(engine, win.start, win.end, 'beat', conditions);
  const numbered = spanReference(engine, win.start, win.end, 'eight', conditions);
  const base = counts.slice(win.index, win.index + WINDOW_COUNTS);
  const wrap = clicks => ({
    start: Math.max(0, win.start - LEAD_SECONDS, reference.start),
    end: win.end, windowStart: win.start, clicks, reference,
  });
  return {
    aligned: wrap(base.map(c => ({ time: c.time, count: numbered ? c.count : null }))),
    wrong: wrap(base.map(c => ({ time: c.time + (c.end - c.time) / 2, count: numbered ? c.count : null }))),
  };
}

// Recheck the current engine at scoring time; excluded questions are not misses.
export function scoreListening(questions, answers, engine, conditions = {}) {
  learningInput(engine, conditions);
  const missed = [], references = [];
  let correct = 0, total = 0;
  questions.forEach((q, i) => {
    const layer = KIND_LAYERS[q.kind];
    if (!layer || q.engineVersion !== engine.engineVersion) return;
    if (q.clicks.some(c => c.count !== null) &&
        !spanReference(engine, q.windowStart, q.end, 'eight', conditions)) return;
    const lastClick = Math.max(...q.clicks.map(c => c.time));
    const reference = spanReference(engine, Math.min(q.windowStart, ...q.clicks.map(c => c.time)),
      Math.max(q.end, lastClick + Number.EPSILON * Math.max(1, Math.abs(lastClick))), layer, conditions);
    if (!reference) return;
    total++;
    references.push(reference);
    if (answers[i] === q.answer) correct++;
    else missed.push({ index: i, kind: q.kind, shiftMs: q.shiftMs });
  });
  return { total, correct, accuracy: total ? correct / total : 0, missed, ...referenceSummary(references) };
}
