import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGrid, GRID_ENGINE, phaseVoteOffset } from '../core/analysis/analyze.js';

// 정속 곡의 놓친 박 채우기(fillSteadyGaps) — 2026-11-09. 합성 곡 + 실제 곡(twist.wav) 모델 출력 캡처.
// 모델 박은 20ms 단위라 같은 양자화를 쓴다.
const q = t => Math.round(t * 50) / 50;
function run(beats, downbeats = []) {
  const duration = Math.ceil(beats.at(-1)) + 5;
  return buildGrid({ sr: 22050, duration, beats, downbeats }, { sr: 22050, duration, firstOnset: 0 });
}
const lattice = (n, P = 0.35, t0 = 0.5) => Array.from({ length: n }, (_, i) => q(t0 + i * P));
const dropAt = (arr, drop) => arr.filter((_, i) => !drop.includes(i));
const bars = grid => grid.downbeats.map(t => grid.beats.indexOf(t));

test('engine version was bumped so saved songs are re-analysed', () => {
  assert.ok(GRID_ENGINE >= 6);
});

test('isolated missed beats on a steady song are interpolated and honestly flagged', () => {
  const full = lattice(160), model = dropAt(full, [20, 21, 50, 90, 91]); // 1·2개짜리 누락
  const grid = run(model);
  assert.equal(grid.diagnostics.filledBeats, 5);
  assert.ok(grid.diagnostics.warnings.includes('missing_beats_filled'));
  assert.equal(grid.beats.length, 160);
  for (let i = 0; i < 160; i++) assert.ok(Math.abs(grid.beats[i] - full[i]) <= 0.02, 'beat ' + i);
  for (const t of model) assert.ok(grid.beats.includes(t), 'model beats are never moved or dropped');
});

test('downbeats stay a subset of beats and counts are no longer shifted after a missed beat', () => {
  const full = lattice(160), downs = full.filter((_, i) => i % 4 === 1);
  const model = dropAt(full, [30, 70, 71]);
  const filled = run(model, downs.filter(t => model.includes(t)));
  assert.ok(filled.downbeats.every(t => filled.beats.includes(t)));
  assert.equal(new Set(bars(filled).map(i => i % 4)).size, 1, 'all downbeats share one mod-4 phase once filled');
  assert.ok(filled.diagnostics.filledBeats > 0);
  // 채우기 전 규칙(엔진 5)이라면 위상이 갈라졌다는 것 — 같은 입력에서 인덱스만 세면 3칸 밀림
  const naive = model.map((t, i) => i).filter((_, i) => downs.includes(model[i]));
  assert.ok(new Set(naive.map(i => i % 4)).size > 1);
});

test('leading half-time intro on an otherwise steady song is filled', () => {
  const full = lattice(170), model = full.filter((_, i) => i >= 40 || i % 2 === 0);
  const grid = run(model);
  assert.equal(grid.diagnostics.filledBeats, 20);
  assert.equal(grid.beats.length, 170);
});

test('a ritardando at the end is not filled', () => {
  const beats = lattice(120);
  let t = beats.at(-1);
  for (const d of [0.38, 0.42, 0.5, 0.6, 0.74, 0.9, 1.1]) { t += d; beats.push(q(t)); }
  const grid = run(beats);
  assert.equal(grid.diagnostics.filledBeats, 0);
  assert.deepEqual(grid.beats, beats);
  assert.equal(grid.diagnostics.warnings.includes('missing_beats_filled'), false);
});

test('a ritardando in the middle of a steady song is not filled', () => {
  const beats = lattice(60);
  let t = beats.at(-1);
  for (const d of [0.4, 0.46, 0.55, 0.68, 0.85, 1.05]) { t += d; beats.push(q(t)); }
  for (let i = 0; i < 60; i++) { t += 0.35; beats.push(q(t)); }
  assert.equal(run(beats).diagnostics.filledBeats, 0);
});

test('a missed beat in the last two intervals is left alone', () => {
  const full = lattice(100), model = dropAt(full, [98]);
  assert.equal(run(model).diagnostics.filledBeats, 0);
});

test('real tempo change (100 -> 160 BPM) is untouched', () => {
  const beats = lattice(70, 0.6);
  let t = beats.at(-1);
  for (let i = 0; i < 100; i++) { t += 0.375; beats.push(q(t)); }
  const grid = run(dropAt(beats, [100]));
  assert.equal(grid.diagnostics.filledBeats, 0);
});

test('rubato (every interval wanders +-25%) is untouched', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const beats = [0.5];
  for (let i = 0; i < 150; i++) beats.push(q(beats.at(-1) + 0.35 * (0.75 + 0.5 * rand())));
  assert.equal(run(dropAt(beats, [40, 90])).diagnostics.filledBeats, 0);
});

test('a song with no missed beats is unchanged', () => {
  const full = lattice(160);
  const grid = run(full);
  assert.deepEqual(grid.beats, full);
  assert.equal(grid.diagnostics.filledBeats, 0);
});

test('short clips (< 24 beats) are never filled', () => {
  assert.equal(run(dropAt(lattice(23), [10])).diagnostics.filledBeats, 0);
});

test('real model output of twist.wav (169.9 BPM, every other beat for 20 s, ~60 drops): count phase becomes consistent', () => {
  const model = JSON.parse(readFileSync(new URL('./fixtures/twist_model_output.json', import.meta.url), 'utf8'));
  const grid = buildGrid(model, { sr: model.sr, duration: model.duration, firstOnset: model.firstOnset });
  assert.ok(grid.diagnostics.filledBeats >= 55 && grid.diagnostics.filledBeats <= 62, String(grid.diagnostics.filledBeats));
  assert.ok(grid.diagnostics.warnings.includes('missing_beats_filled'));
  const votes = [0, 0, 0, 0];
  for (const t of grid.downbeats) votes[grid.beats.indexOf(t) % 4] += 1;
  assert.ok(Math.max(...votes) / grid.downbeats.length >= 0.8, 'phase votes ' + votes);
  assert.ok(grid.diagnostics.misalignedDownbeatRatio < 0.25);
  assert.equal(grid.diagnostics.warnings.includes('count_drift_needs_review'), false);
  assert.ok(Math.abs(grid.bpm - 169.9) < 1.5, String(grid.bpm));
  // 채운 뒤 모든 정상 간격 합이 격자 하나로: 큰 간격(>1.5 주기)이 거의 남지 않는다
  const P = 60 / 169.9, big = grid.beats.slice(1).filter((t, i) => t - grid.beats[i] > 1.5 * P).length;
  assert.ok(big <= 4, 'remaining big gaps ' + big);
  assert.ok(phaseVoteOffset(grid.beats, grid.downbeats) !== null);
});

test('tempo double/halve evidence is measured on the model beats, not on filled beats', () => {
  // 100 BPM, model bars are 2 beats long (= model beat layer is a half-note pulse) -> existing rule doubles the tempo.
  // 채우기가 2박 마디 증거를 흔들면 안 된다(채우기 전 모델 박으로 판정).
  const full = lattice(160, 0.6), downs = full.filter((_, i) => i % 2 === 0);
  const model = dropAt(full, [41, 97]);
  const withFill = run(model, downs.filter(t => model.includes(t)));
  assert.equal(withFill.tempoFactor, 2);
  assert.ok(withFill.diagnostics.warnings.includes('tempo_doubled'));
  assert.ok(withFill.diagnostics.filledBeats > 0);
  const med = [...model.slice(1).map((t, i) => t - model[i])].sort((a, b) => a - b)[Math.floor((model.length - 1) / 2)];
  assert.ok(Math.abs(withFill.diagnostics.rawBpm - 60 / med) < 1e-9, 'rawBpm is the pre-fill model median');
});

test('real GTZAN classical.00027 model output: filling 2 beats must not flip the tempo-doubling decision (it did: beat F 0.40 -> 0.03)', () => {
  const model = JSON.parse(readFileSync(new URL('./fixtures/gtzan_classical_00027_model_output.json', import.meta.url), 'utf8'));
  const grid = buildGrid(model, { sr: model.sr, duration: model.duration, firstOnset: model.firstOnset });
  assert.equal(grid.diagnostics.filledBeats, 2);
  assert.equal(grid.tempoFactor, 2);
  assert.ok(grid.diagnostics.warnings.includes('tempo_doubled'));
});
