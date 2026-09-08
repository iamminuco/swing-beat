// Ports beat_this.inference.split_piece / aggregate_prediction for the fixed
// (1,1500,128) ONNX graph. Measured 2026-09-07: padding a SHORT chunk to 1500
// changes kept-frame logits (max 7.2) and the final beats (41→30), so audio
// whose spectrogram is under CHUNK_SIZE frames is refused, never padded.
import { N_MELS } from './logmel.js';

export const CHUNK_SIZE = 1500; // 30 s of model frames
export const BORDER = 6; // frames discarded from each chunk edge
export const MIN_FRAMES = CHUNK_SIZE - 2 * BORDER; // shortest analysable piece

// Chunk start offsets in frames (may be negative for the first border pad).
export function chunkStarts(frames) {
  if (frames < MIN_FRAMES) {
    throw new RangeError(
      `Audio too short: ${frames} frames < ${MIN_FRAMES} (about 30 s) — the fixed ONNX graph cannot analyse it`);
  }
  const starts = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK_SIZE - 2 * BORDER) starts.push(s);
  starts[starts.length - 1] = frames - (CHUNK_SIZE - BORDER); // avoid_short_end
  return starts;
}

// Extract one zero-border-padded chunk as a fresh (1500×128) buffer.
export function extractChunk(spect, frames, start) {
  const chunk = new Float32Array(CHUNK_SIZE * N_MELS);
  const from = Math.max(start, 0);
  const to = Math.min(start + CHUNK_SIZE, frames);
  chunk.set(spect.subarray(from * N_MELS, to * N_MELS), (from - start) * N_MELS);
  return chunk;
}

// Stitch per-chunk framewise logits back to full length, keep_first overlap:
// written in reverse so earlier chunks overwrite later ones, as upstream does.
export function aggregate(chunkLogits, starts, frames) {
  const full = new Float32Array(frames).fill(-1000);
  for (let c = starts.length - 1; c >= 0; c--) {
    const start = starts[c], logits = chunkLogits[c];
    for (let i = BORDER; i < CHUNK_SIZE - BORDER; i++) {
      const pos = start + i;
      if (pos >= 0 && pos < frames) full[pos] = logits[i];
    }
  }
  return full;
}
