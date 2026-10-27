import { fft, hannWindow } from './stft.js';

export const ACCENTS_VERSION = 2;
export const ACCENTS_METHOD = 'spectral-prominence-v1';

export function accentsCurrent(analysis) {
  return analysis.accents?.version === ACCENTS_VERSION && analysis.accents?.method === ACCENTS_METHOD;
}

function median(values) {
  const a = [...values].sort((x, y) => x - y), n = a.length;
  return n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// Acoustic accent candidates: unusually strong spectral attacks relative to
// nearby attacks. These are estimates of sound prominence, not metrical labels
// or calibrated probabilities. Neither beat positions nor a fixed even-count
// pattern enter the detector. Quiet/steady passages can have no candidates.
function* analyzeAccents(samples, sr) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(sr) || sr <= 0) {
    throw new TypeError('Expected mono Float32Array and positive sample rate');
  }
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i % 262144 === 0) yield;
    const x = samples[i];
    if (!Number.isFinite(x)) throw new TypeError('Non-finite PCM sample');
    peak = Math.max(peak, Math.abs(x));
  }
  const result = { version: ACCENTS_VERSION, method: ACCENTS_METHOD, status: 'estimated', events: [] };
  if (peak < 1e-5 || !samples.length) return result;
  const size = 1024, hop = Math.max(1, Math.round(sr * .01));
  const frames = Math.ceil(samples.length / hop), window = hannWindow(size);
  const buf = new Float64Array(size * 2), previous = new Float64Array(size / 2 + 1);
  const flux = new Float64Array(frames), rms = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    if (t % 256 === 0) yield;
    let energy = 0;
    for (let j = 0; j < size; j++) {
      const pos = t * hop + j - size / 2;
      const x = pos >= 0 && pos < samples.length ? samples[pos] : 0;
      energy += x * x;
      buf[j * 2] = x * window[j]; buf[j * 2 + 1] = 0;
    }
    rms[t] = Math.sqrt(energy / size);
    fft(buf);
    for (let k = 1; k < previous.length; k++) {
      const mag = Math.hypot(buf[k * 2], buf[k * 2 + 1]) / size;
      flux[t] += Math.max(0, mag - previous[k]);
      previous[k] = mag;
    }
    // Seed from complete windows. Padding at a cropped start/end is not a hit.
    if ((t - 1) * hop < size / 2 || t * hop + size / 2 > samples.length) flux[t] = 0;
  }
  const prefix = new Float64Array(frames + 1);
  for (let t = 0; t < frames; t++) prefix[t + 1] = prefix[t] + flux[t];
  const radius = Math.max(1, Math.round(sr / hop)), peaks = [];
  for (let t = 0; t < frames; t++) {
    if (t % 4096 === 0) yield;
    if (rms[t] < Math.max(1e-5, peak * .001)) continue;
    const left = Math.max(0, t - radius), right = Math.min(frames, t + radius + 1);
    const mean = (prefix[right] - prefix[left]) / (right - left);
    if (flux[t] <= Math.max(1e-8, mean * 1.5)) continue;
    let localMax = true;
    for (let j = Math.max(0, t - 3); j <= Math.min(frames - 1, t + 3); j++) {
      if (flux[j] > flux[t] || (j < t && flux[j] === flux[t])) { localMax = false; break; }
    }
    if (localMax) peaks.push({ time: t * hop / sr, flux: flux[t] });
  }
  let leftPeak = 0, rightPeak = 0;
  for (const p of peaks) {
    while (peaks[leftPeak].time < p.time - 4) leftPeak++;
    while (rightPeak < peaks.length && peaks[rightPeak].time <= p.time + 4) rightPeak++;
    const nearby = peaks.slice(leftPeak, rightPeak).map(q => q.flux);
    const typical = median(nearby);
    const aboveTypicalDb = 20 * Math.log10(p.flux / Math.max(typical, 1e-12));
    // 3 dB above the local median attack is a candidate; 12 dB maps to full
    // display strength. Strength expresses contrast, not certainty of truth.
    if (aboveTypicalDb >= 3) result.events.push({ time: p.time, strength: Math.min(1, aboveTypicalDb / 12) });
  }
  return result;
}

// Both entry points consume the same detector; the player yields between slices.
export function detectAccents(samples, sr) {
  const work = analyzeAccents(samples, sr);
  for (;;) { const step = work.next(); if (step.done) return step.value; }
}
export async function detectAccentsAsync(samples, sr, isCurrent = () => true) {
  const work = analyzeAccents(samples, sr);
  for (;;) {
    if (!isCurrent()) return null;
    const step = work.next();
    if (step.done) return step.value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

// Lookup by media time also works for off-beat accents, seeking and rate changes.
export function accentAt(accents, time) {
  if (!accents || !Number.isFinite(time)) return null;
  const events = accents.events;
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (events[mid].time <= time) lo = mid + 1; else hi = mid; }
  const event = events[lo - 1];
  return event && time - event.time < .12 ? event : null;
}
