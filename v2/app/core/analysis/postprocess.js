// Ports beat_this.model.postprocessor.Postprocessor(type="minimal") exactly:
// keep framewise logits that are the maximum of their ±3-frame window, call a
// peak anything above logit 0 (probability 0.5), average adjacent peak runs
// (fractional frames allowed), convert to seconds at 50 fps, and snap each
// downbeat to the nearest beat (deduplicated). Pure arrays in and out.
import { FPS } from './logmel.js';

function peakFrames(logits) {
  const n = logits.length, frames = [];
  for (let i = 0; i < n; i++) {
    const v = logits[i];
    if (v <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
      if (logits[j] > v) { isMax = false; break; }
    }
    if (isMax) frames.push(i);
  }
  return frames;
}

// Replaces groups of adjacent peak indices (≤ width apart) by their mean.
function deduplicatePeaks(peaks, width = 1) {
  if (!peaks.length) return [];
  const result = [];
  let p = peaks[0], c = 1;
  for (let i = 1; i < peaks.length; i++) {
    if (peaks[i] - p <= width) {
      c += 1;
      p += (peaks[i] - p) / c;
    } else {
      result.push(p);
      p = peaks[i];
      c = 1;
    }
  }
  result.push(p);
  return result;
}

export function pickBeats(beatLogits, downbeatLogits) {
  const beats = deduplicatePeaks(peakFrames(beatLogits)).map(f => f / FPS);
  const rawDownbeats = deduplicatePeaks(peakFrames(downbeatLogits)).map(f => f / FPS);
  const snapped = [];
  for (const d of rawDownbeats) {
    if (!beats.length) break;
    let best = beats[0];
    for (const b of beats) if (Math.abs(b - d) < Math.abs(best - d)) best = b;
    if (!snapped.includes(best)) snapped.push(best);
  }
  snapped.sort((a, b) => a - b);
  return { beats, downbeats: snapped };
}
