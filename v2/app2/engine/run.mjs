import { SAMPLE_RATE, N_MELS, logMelSpect } from '../../app/core/analysis/logmel.js';
import { chunkStarts, extractChunk, aggregate } from '../../app/core/analysis/chunking.js';
import { pickBeats } from '../../app/core/analysis/postprocess.js';
import { analyze } from '../../app/core/analysis/analyze.js';
import { inferStructure } from '../../app/core/analysis/structure.js';
import { fromV1 } from './from-v1.mjs';
import { validateEngineResult } from './result.mjs';

export function validatePcm(pcm) {
  if (!(pcm instanceof Float32Array)) throw new TypeError('Expected mono Float32Array at 22050 Hz');
  for (const value of pcm) if (!Number.isFinite(value)) throw new TypeError('Non-finite PCM sample');
  if (pcm.length < SAMPLE_RATE * 30) throw new RangeError('30초보다 짧은 곡은 아직 분석할 수 없어요');
}

// No loading or shared state: the caller owns prepared filterbank bands and ORT sessions.
// structure=true is research opt-in; no filename hints, user corrections or automatic restarts.
export async function analyzePcm(pcm, { session, filterbank, ort, structure = false,
  structureSession, progress = () => {} } = {}) {
  validatePcm(pcm);
  if (typeof structure !== 'boolean') throw new TypeError('structure must be boolean');
  if (!session?.run || !ort?.Tensor || !filterbank) throw new TypeError('session, filterbank and ort.Tensor are required');
  if (structure && !structureSession?.run) throw new TypeError('structureSession is required for structure=true');
  progress('노래를 살펴보는 중…');
  const { frames, data } = logMelSpect(pcm, filterbank), starts = chunkStarts(frames);
  const beatChunks = [], downChunks = [];
  for (let i = 0; i < starts.length; i++) {
    progress(`박자 찾는 중 ${i + 1}/${starts.length}…`);
    const chunk = extractChunk(data, frames, starts[i]);
    const input = new ort.Tensor('float32', chunk, [1, chunk.length / N_MELS, N_MELS]);
    let out;
    try {
      out = await session.run({ spect: input });
      // Copy before disposing tensors; aggregation must retain earlier chunks.
      beatChunks.push(out.beat_logits.data.slice());
      downChunks.push(out.downbeat_logits.data.slice());
    } finally {
      input.dispose?.();
      if (out) for (const tensor of Object.values(out)) tensor.dispose?.();
    }
  }
  const picked = pickBeats(aggregate(beatChunks, starts, frames), aggregate(downChunks, starts, frames));
  const duration = pcm.length / SAMPLE_RATE, beats = picked.beats.filter(t => t < duration), kept = new Set(beats);
  let grid = analyze(pcm, SAMPLE_RATE, { sr: SAMPLE_RATE, duration, beats,
    downbeats: picked.downbeats.filter(t => kept.has(t)) });
  if (structure) grid = { ...grid, structure: await inferStructure(pcm, SAMPLE_RATE, grid, structureSession, ort, progress) };
  const result = fromV1(grid), validation = validateEngineResult(result);
  if (!validation.ok) throw new RangeError('Invalid EngineResult: ' + validation.errors.join('; '));
  return result;
}
