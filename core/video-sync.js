// musicTime = (videoTime - offset) * ratio; times are seconds.
export const VIDEO_LIMIT = 300000000;
export function isVideoFile(file) {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('audio/')) return false;
  return type.startsWith('video/') ||
    ((!type || type === 'application/octet-stream') && /\.(mp4|mov|webm)$/i.test(file.name || ''));
}
export function checkVideoSize(file) {
  if (file.size > VIDEO_LIMIT) throw new RangeError('동영상은 300MB 이하로 골라 주세요');
}
function checkFit(fit) {
  if (!Number.isFinite(fit.offset) || !Number.isFinite(fit.ratio) || fit.ratio <= 0)
    throw new RangeError('Invalid alignment');
}
export function videoToMusic(time, fit) { checkFit(fit); return (time - fit.offset) * fit.ratio; }
export function musicToVideo(time, fit) { checkFit(fit); return fit.offset + time / fit.ratio; }
export function needsResync(videoTime, musicTime, fit) {
  return Math.abs(musicToVideo(musicTime, fit) - videoTime) > 0.080 + 1e-9;
}
export function musicPosition(videoTime, duration, fit) {
  const time = videoToMusic(videoTime, fit);
  return { time: Math.max(0, Math.min(duration, time)), active: time >= 0 && time < duration };
}
export function projectLayout(base, fit, duration) {
  const counts = base.counts.map(c => ({ ...c,
    time: musicToVideo(c.time, fit), end: Math.min(duration, musicToVideo(c.end, fit)),
  })).filter(c => c.time >= 0 && c.time < duration && c.end > c.time);
  // Preserve original count/eight labels when the video crops the song.
  const phraseLen = base.phraseLen || 4;
  const groups = key => new Set(counts.map(c => c[key]));
  const full = (key, size) => [...groups(key)].filter(n => counts.filter(c => c[key] === n).length === size).length;
  const fullEights = full('eight', 8), fullPhrases = full('phrase', phraseLen * 8);
  return { ...base, counts, totals: { ...base.totals, beats: counts.length, pickupBeats: 0,
    fullEights, fullPhrases, endingCounts: counts.length - fullPhrases * phraseLen * 8,
    sections: counts.length ? 1 + counts.filter((c, i) => i > 0 && c.count === 1 && counts[i - 1].count !== 8).length : 0 } };
}
export function onsetCurve(pcm, sr, hz = 100) {
  if (!(pcm instanceof Float32Array) || !(sr >= hz) || !Number.isFinite(sr))
    throw new TypeError('Expected mono PCM and sample rate');
  const out = new Float32Array(Math.floor(pcm.length / sr * hz));
  let previous = 0;
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * sr / hz), to = Math.floor((i + 1) * sr / hz);
    let energy = 0;
    for (let j = from; j < to; j++) {
      if (!Number.isFinite(pcm[j])) throw new TypeError('Non-finite PCM');
      energy += pcm[j] * pcm[j];
    }
    const rms = Math.sqrt(energy / (to - from));
    out[i] = Math.sqrt(Math.max(0, rms - previous));
    previous = rms;
  }
  return out;
}
function sample(a, x) {
  const i = Math.floor(x), f = x - i;
  return i < 0 || i >= a.length ? 0 : a[i] * (1 - f) + (a[i + 1] || 0) * f;
}
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / len, cr = Math.cos(angle), ci = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const br = re[b] * wr - im[b] * wi, bi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - br; im[b] = im[a] - bi; re[a] += br; im[a] += bi;
        const next = wr * cr - wi * ci; wi = wr * ci + wi * cr; wr = next;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function correlation(a, b) {
  let n = 1;
  while (n < a.length + b.length) n *= 2;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a);
  for (let i = 0; i < b.length; i++) br[i] = b[b.length - 1 - i];
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r;
  }
  fft(ar, ai, true); return ar;
}
function sums(a) {
  const s = new Float64Array(a.length + 1), q = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) { s[i + 1] = s[i] + a[i]; q[i + 1] = q[i] + a[i] * a[i]; }
  return { s, q };
}
function pearson(xy, sx, sy, xx, yy, n) {
  const den = Math.sqrt(Math.max(0, xx - sx * sx / n) * Math.max(0, yy - sy * sy / n));
  return den > 1e-10 ? (xy - sx * sy / n) / den : -1;
}
function coarseCurve(curve, hz) {
  const n = Math.floor(curve.length * 10 / hz), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = Math.floor(i * hz / 10); j < Math.floor((i + 1) * hz / 10); j++)
      out[i] += curve[j] / (Math.floor((i + 1) * hz / 10) - Math.floor(i * hz / 10));
  }
  return out;
}
function fineScore(video, music, hz, offset, ratio, minSeconds) {
  const lo = Math.max(0, Math.ceil(offset * hz));
  const hi = Math.min(video.length, Math.floor((offset + music.length / hz / ratio) * hz));
  if ((hi - lo) / hz + 1e-9 < Math.max(minSeconds, Math.min(video.length, music.length / ratio) / hz / 2)) return -1;
  let sx = 0, sy = 0, xx = 0, yy = 0, xy = 0, n = 0;
  const step = Math.max(1, Math.floor((hi - lo) / 12000));
  for (let i = lo; i < hi; i += step) {
    const x = video[i], y = sample(music, (i / hz - offset) * ratio * hz);
    sx += x; sy += y; xx += x * x; yy += y * y; xy += x * y; n++;
  }
  return pearson(xy, sx, sy, xx, yy, n);
}
// Heuristic confidence, not a calibrated probability. Repeated music may be ambiguous.
function* alignmentSteps(video, music, hz) {
  if (hz < 10 || !Number.isFinite(hz)) throw new RangeError('Invalid curve rate');
  const fail = { offset: 0, ratio: 1, score: 0, confidence: 0, matched: false };
  const a = coarseCurve(video, hz), m = coarseCurve(music, hz);
  const minSeconds = Math.max(30, Math.min(a.length, m.length) / 20);
  if (Math.min(a.length, m.length) < minSeconds * 10) return fail;
  const A = sums(a), candidates = [];
  for (let k = 0; k <= 40; k++) {
    const ratio = 0.8 + k * 0.005;
    const b = Float32Array.from({ length: Math.floor(m.length / ratio) }, (_, i) => sample(m, i * ratio));
    const B = sums(b), corr = correlation(a, b), peaks = [];
    for (let lag = -b.length + Math.ceil(minSeconds * 10); lag <= a.length - minSeconds * 10; lag++) {
      const lo = Math.max(0, lag), hi = Math.min(a.length, lag + b.length), n = hi - lo;
      if (n < Math.max(300, Math.min(a.length, b.length) / 2)) continue;
      const j = lo - lag, end = hi - lag;
      const score = pearson(corr[lag + b.length - 1], A.s[hi] - A.s[lo], B.s[end] - B.s[j],
        A.q[hi] - A.q[lo], B.q[end] - B.q[j], n);
      const near = peaks.findIndex(p => Math.abs(p.offset - lag / 10) < 0.4);
      if (near >= 0 && peaks[near].score >= score) continue;
      if (near >= 0) peaks.splice(near, 1);
      peaks.push({ offset: lag / 10, ratio, score });
      peaks.sort((x, y) => y.score - x.score);
      if (peaks.length > 24) peaks.pop();
    }
    candidates.push(...peaks);
    yield;
  }
  candidates.sort((x, y) => y.score - x.score);
  let best = { ...fail, score: -1 };
  // Refine several peaks, because an ambiguous coarse grid must not choose the wrong half.
  const seeds = [];
  for (const c of candidates) {
    if (seeds.every(s => Math.abs(s.offset - c.offset) > 0.4 || Math.abs(s.ratio - c.ratio) > 0.015)) seeds.push(c);
    if (seeds.length === 24) break;
  }
  const refined = [];
  for (const seed of seeds) {
    let local = { ...seed, score: -1 };
    for (let k = -6; k <= 6; k++) {
      const ratio = Math.max(0.8, Math.min(1, seed.ratio + k * 0.001));
      for (let j = -25; j <= 25; j++) {
        const offset = seed.offset + j * 0.005;
        const score = fineScore(video, music, hz, offset, ratio, minSeconds);
        if (score > local.score) local = { offset, ratio, score };
      }
      yield;
    }
    refined.push(local);
    if (local.score > best.score) best = local;
  }
  if (best.score < 0) return fail;
  const rival = Math.max(0, ...refined.filter(c =>
    Math.abs(c.offset - best.offset) > 0.4 || Math.abs(c.ratio - best.ratio) > 0.015).map(c => c.score));
  const margin = best.score - rival;
  const confidence = Math.max(0, Math.min(1, best.score) * Math.min(1, Math.max(0, margin) / 0.12));
  return { ...best, confidence, matched: best.score >= 0.55 && margin >= 0.05 };
}

export function estimateAlignment(video, music, hz = 100) {
  const steps = alignmentSteps(video, music, hz);
  let next;
  do { next = steps.next(); } while (!next.done);
  return next.value;
}
export async function estimateAlignmentAsync(video, music, hz = 100, signal) {
  // Each step is one coarse ratio or one fine ratio, with the same ordering and scores.
  const steps = alignmentSteps(video, music, hz);
  await new Promise(resolve => setTimeout(resolve, 0));
  let deadline = performance.now() + 12;
  for (;;) {
    if (signal?.aborted) { steps.return(); throw new DOMException('맞춤을 취소했어요', 'AbortError'); }
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() >= deadline) {
      await new Promise(resolve => setTimeout(resolve, 0));
      deadline = performance.now() + 12;
    }
  }
}
