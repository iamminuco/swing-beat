// Official split_piece / aggregate_prediction, including short frames + 12 inputs.
// Only the six context-border frames are padded; short audio is never padded to 1500.
import { N_MELS } from './logmel.js';

export const CHUNK_SIZE = 1500; // 30 s of model frames
export const BORDER = 6; // frames discarded from each chunk edge

// Chunk start offsets in frames (may be negative for the first border pad).
export function chunkStarts(frames) {
  if (!Number.isInteger(frames) || frames < 1) throw new RangeError('Expected positive integer frames');
  if (frames <= CHUNK_SIZE - 2 * BORDER) return [-BORDER];
  const starts = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK_SIZE - 2 * BORDER) starts.push(s);
  starts[starts.length - 1] = frames - (CHUNK_SIZE - BORDER); // avoid_short_end
  return starts;
}

// Extract one zero-border-padded chunk as a fresh (up to 1500×128) buffer.
export function extractChunk(spect, frames, start) {
  const length = Math.min(CHUNK_SIZE, frames + 2 * BORDER);
  const chunk = new Float32Array(length * N_MELS);
  const from = Math.max(start, 0);
  const to = Math.min(start + length, frames);
  chunk.set(spect.subarray(from * N_MELS, to * N_MELS), (from - start) * N_MELS);
  return chunk;
}

// Stitch per-chunk framewise logits back to full length, keep_first overlap:
// written in reverse so earlier chunks overwrite later ones, as upstream does.
export function aggregate(chunkLogits, starts, frames) {
  const full = new Float32Array(frames).fill(-1000);
  for (let c = starts.length - 1; c >= 0; c--) {
    const start = starts[c], logits = chunkLogits[c];
    for (let i = BORDER; i < logits.length - BORDER; i++) {
      const pos = start + i;
      if (pos >= 0 && pos < frames) full[pos] = logits[i];
    }
  }
  return full;
}
