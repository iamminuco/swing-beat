// File → mono Float32Array at the model's 22050 Hz clock. Browser-only.
// Leading sound-track empty edits are restored in PCM so analysis and media
// playback share the presentation clock; device latency stays in the sliders.
import { audioStartSeconds } from './media-start.js';
export const MODEL_SR = 22050;

export function padStart(samples, sr, sec) {
  if (!Number.isFinite(sec) || sec <= 0 || sec > 60) return samples;
  const frames = Math.round(sr * sec);
  if (!Number.isSafeInteger(frames) || frames <= 0) return samples;
  const padded = new Float32Array(samples.length + frames);
  padded.set(samples, frames);
  return padded;
}

export async function decodeToModelRate(file) {
  const buffer = await file.arrayBuffer();
  const startOffset = audioStartSeconds(buffer); // Sync read; decodeAudioData detaches it afterwards.
  const probe = new OfflineAudioContext(1, 1, MODEL_SR);
  const decoded = await probe.decodeAudioData(buffer);
  const frames = Math.ceil(decoded.duration * MODEL_SR);
  const off = new OfflineAudioContext(1, frames, MODEL_SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const samples = padStart(rendered.getChannelData(0), MODEL_SR, startOffset);
  const duration = startOffset > 0 ? samples.length / MODEL_SR : rendered.duration;
  return { samples, sr: MODEL_SR, duration, startOffset };
}
