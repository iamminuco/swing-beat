// Same decoded mono PCM and sample clock must feed analysis and playback.
export function inspectSignal(samples, sr, bins = 1024) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(sr) || sr <= 0) {
    throw new TypeError('Expected mono Float32Array and positive sample rate');
  }
  if (!Number.isInteger(bins) || bins < 1 || bins > 16384) {
    throw new RangeError('Waveform bins must be 1..16384');
  }
  let peak = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite PCM sample');
    peak = Math.max(peak, Math.abs(value));
  }
  // Silence boundary only: NOT a musical beat/downbeat detector. A tonal
  // signal passes through zero every half cycle, so a consecutive-run rule
  // wrongly calls a pure sine "silence"; count active samples in a 2 ms
  // window instead. Threshold is provisional; noisy/fading intros need hand
  // labels before claiming onset accuracy.
  const threshold = Math.max(1e-5, peak * 0.001);
  const hold = Math.max(1, Math.round(sr * 0.002));
  const need = Math.max(2, Math.round(hold / 4));
  let firstOnset = null, active = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) active += 1;
    if (i >= hold && Math.abs(samples[i - hold]) >= threshold) active -= 1;
    if (active >= need || (samples.length < need && active === samples.length)) {
      for (let j = Math.max(0, i - hold + 1); j <= i; j++) {
        if (Math.abs(samples[j]) >= threshold) { firstOnset = j / sr; break; }
      }
      break;
    }
  }
  const count = Math.min(bins, samples.length), waveform = [];
  for (let b = 0; b < count; b++) {
    const start = Math.floor(b * samples.length / count);
    const end = Math.floor((b + 1) * samples.length / count);
    let min = Infinity, max = -Infinity;
    for (let i = start; i < end; i++) {
      min = Math.min(min, samples[i]); max = Math.max(max, samples[i]);
    }
    waveform.push({ min, max });
  }
  return { sr, duration: samples.length / sr, firstOnset, waveform };
}
