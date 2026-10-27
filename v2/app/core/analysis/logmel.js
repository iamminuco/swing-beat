import { fft, hannWindow, reflectIndex } from './stft.js';
// Log-mel spectrogram matching beat_this.preprocessing.LogMelSpect exactly:
// STFT(n_fft 1024, hop 441, periodic hann, center+reflect pad, magnitude,
// normalized by 1/sqrt(n_fft)) → mel filterbank (torchaudio slaney, norm=None,
// 30..11000 Hz, 128 mels — shipped as an exported asset so the numbers are the
// SAME floats torchaudio produced, not a reimplementation) → log1p(1000·x).
// Pure: Float32Array in, Float32Array out. Parity is pinned by test vectors in
// research/beat_tests/js_port/ (max abs diff asserted in tests).
export const SAMPLE_RATE = 22050;
export const N_FFT = 1024;
export const HOP = 441;
export const N_MELS = 128;
export const N_FREQS = N_FFT / 2 + 1;
export const FPS = SAMPLE_RATE / HOP; // 50 model frames per second

const STFT_NORM = 1 / Math.sqrt(N_FFT); // torchaudio normalized="frame_length"

// The exported (513×128) matrix is mostly zeros; precompute each mel's nonzero
// band once so a frame costs ~2 taps per (mel, bin) instead of a full matmul.
export function prepareFilterbank(fbFloats) {
  if (!(fbFloats instanceof Float32Array) || fbFloats.length !== N_FREQS * N_MELS) {
    throw new RangeError(`Filterbank must be ${N_FREQS}x${N_MELS} float32`);
  }
  const bands = [];
  for (let m = 0; m < N_MELS; m++) {
    let start = -1, end = -1;
    for (let k = 0; k < N_FREQS; k++) {
      if (fbFloats[k * N_MELS + m] !== 0) {
        if (start === -1) start = k;
        end = k + 1;
      }
    }
    if (start === -1) { start = 0; end = 0; }
    const weights = new Float32Array(end - start);
    for (let k = start; k < end; k++) weights[k - start] = fbFloats[k * N_MELS + m];
    bands.push({ start, weights });
  }
  return bands;
}

// In-place iterative radix-2 FFT over interleaved [re, im] pairs, length N_FFT.
// samples: mono Float32Array at 22050 Hz. Returns {frames, data} where data is
// frames×128 log-mel values, row-major — the model's expected input layout.
export function logMelSpect(samples, filterbankBands) {
  const frames = 1 + Math.floor(samples.length / HOP);
  const data = new Float32Array(frames * N_MELS);
  const window = hannWindow(N_FFT);
  const buf = new Float64Array(N_FFT * 2);
  const half = N_FFT / 2;
  const mags = new Float64Array(N_FREQS);
  for (let t = 0; t < frames; t++) {
    const startSample = t * HOP - half; // center=true: frame t centered at t*HOP
    for (let i = 0; i < N_FFT; i++) {
      buf[i * 2] = samples[reflectIndex(startSample + i, samples.length)] * window[i];
      buf[i * 2 + 1] = 0;
    }
    fft(buf);
    for (let k = 0; k < N_FREQS; k++) {
      mags[k] = Math.hypot(buf[k * 2], buf[k * 2 + 1]) * STFT_NORM;
    }
    const row = t * N_MELS;
    for (let m = 0; m < N_MELS; m++) {
      const { start, weights } = filterbankBands[m];
      let acc = 0;
      for (let w = 0; w < weights.length; w++) acc += mags[start + w] * weights[w];
      data[row + m] = Math.log1p(1000 * acc);
    }
  }
  return { frames, data };
}
