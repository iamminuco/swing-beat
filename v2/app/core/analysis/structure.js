import { structureFeatures } from './structure-features.js';
import { decodeStructure } from './structure-decode.js';

export const STRUCTURE_VERSION = 1;
export const STRUCTURE_MODEL = 'metrical-tcn-v1';
const CORE = 128, HALO = 40, PAD = 512, BINS = 513;

export function structureCurrent(analysis) {
  return analysis.structure?.version === STRUCTURE_VERSION && analysis.structure?.model === STRUCTURE_MODEL;
}

// Choose one global two-bar phase; irregular hierarchy boundaries never reset
// the continuous counter. Vote shares are not probabilities of correctness.
export function summarizeStructure(decoded, grid) {
  const offset = grid.barPhase.offset;
  const votes = [0, 0];
  for (const b of decoded.twoBarCandidates) {
    if (b.beat >= offset) votes[((b.beat - offset) % 8) / 4]++;
  }
  const shift = votes[1] > votes[0] ? (offset >= 4 ? -4 : 4) : 0;
  return {
    version: STRUCTURE_VERSION, model: STRUCTURE_MODEL, status: 'estimated',
    oneTime: grid.beats[offset + shift] ?? grid.beats[offset],
    bars: decoded.bars.map(({ time, level }) => ({ time, level })),
  };
}

// The caller owns the ORT session so unit tests and the browser run this same
// path. Fixed-context chunks retain the full track's feature/time coordinates.
export async function inferStructure(pcm, sr, grid, session, ort, progress = () => {}, isCurrent = () => true) {
  const { beats } = grid;
  if (grid.barPhase.offset === null || beats.length < 8) return null;
  const logp = new Float32Array(beats.length * 4 * 9);
  for (let start = 0; start < beats.length; start += CORE) {
    if (!isCurrent()) throw new Error('분석 요청이 바뀌었어요');
    const stop = Math.min(beats.length, start + CORE);
    const left = Math.max(0, start - HALO), right = Math.min(beats.length, stop + HALO);
    progress(`프레이즈 찾는 중 ${Math.floor(start / CORE) + 1}/${Math.ceil(beats.length / CORE)}…`);
    await new Promise(r => setTimeout(r));
    const features = structureFeatures(pcm, sr, beats, left, right);
    const data = new Float32Array(features.length + PAD * 2 * BINS);
    data.set(features, PAD * BINS);
    const input = new ort.Tensor('float32', data, [1, data.length / BINS, BINS]);
    let out;
    try {
      out = await session.run({ spect: input });
      const values = out.logp.data;
      if (values.length !== data.length / BINS / 8 * 9) throw new Error('구조 모델 출력 크기가 달라요');
      // Upstream tcn_audio_metrical_eval.py uses MAX_OFFSET=64 minus
      // TCNClassifier(remap_offset=20): 512/8 - 20 = 44 quarterbeat frames.
      // This preserves the published inference alignment, not a new lag fix.
      const from = (PAD / 8 - 20 + (start - left) * 4) * 9;
      logp.set(values.subarray(from, from + (stop - start) * 4 * 9), start * 4 * 9);
    } finally {
      input.dispose?.();
      if (out) for (const tensor of Object.values(out)) tensor.dispose?.();
    }
  }
  return summarizeStructure(decodeStructure(logp, beats, grid.barPhase.offset % 4), grid);
}

// Musical grouping stays separate from fixed eight-count practice groups.
export function structurePhrases(structure, duration, corrections = null) {
  if (!structure) return [];
  if (corrections) {
    const barTimes = new Set(structure.bars.map(b => b.time));
    const anchors = [corrections.oneAnchorTime, ...(corrections.sectionOnes ?? [])].filter(t => t != null);
    // A corrected beat layer or bar phase invalidates this conditional decode.
    if (corrections.manualTempo != null || anchors.some(t => !barTimes.has(t))) return [];
  }
  const boundaries = structure.bars.filter(b => b.level >= 3 && b.time > 0).map(b => b.time);
  if (!boundaries.length) return []; // No useful internal boundary: keep practice rows.
  const starts = [0, ...boundaries];
  return starts.map((time, i) => ({ time, end: starts[i + 1] ?? duration, number: i + 1 }));
}
export function structurePhraseAt(phrases, time) {
  let lo = 0, hi = phrases.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (phrases[mid].time <= time) lo = mid + 1; else hi = mid; }
  const p = phrases[lo - 1];
  return p && time < p.end ? p : null;
}
