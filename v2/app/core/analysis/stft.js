// Shared 1024-point STFT primitives. Keep numerical behavior identical for both models.
const N_FFT = 1024;
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n)); // periodic
  return w;
}

export function fft(buf) {
  const n = N_FFT;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ir = i * 2, jr = j * 2;
      let t = buf[ir]; buf[ir] = buf[jr]; buf[jr] = t;
      t = buf[ir + 1]; buf[ir + 1] = buf[jr + 1]; buf[jr + 1] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = (i + k) * 2, b = (i + k + len / 2) * 2;
        const xr = buf[b] * cr - buf[b + 1] * ci;
        const xi = buf[b] * ci + buf[b + 1] * cr;
        buf[b] = buf[a] - xr; buf[b + 1] = buf[a + 1] - xi;
        buf[a] += xr; buf[a + 1] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export function reflectIndex(i, length) {
  if (i < 0) return -i;
  if (i >= length) return 2 * length - 2 - i;
  return i;
}

