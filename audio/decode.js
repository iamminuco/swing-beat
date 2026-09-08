// File → mono Float32Array at the model's 22050 Hz clock. Browser-only.
// The SAME decoded file also feeds the <audio> element for playback, so the
// analysis clock and the playback clock come from one decoder; any remaining
// constant device offset is absorbed by the latency sliders, never by shifting
// beat timestamps.
export const MODEL_SR = 22050;

export async function decodeToModelRate(file) {
  const arrayBuf = await file.arrayBuffer();
  const probe = new OfflineAudioContext(1, 1, MODEL_SR);
  const decoded = await probe.decodeAudioData(arrayBuf.slice(0));
  const frames = Math.ceil(decoded.duration * MODEL_SR);
  const off = new OfflineAudioContext(1, frames, MODEL_SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { samples: rendered.getChannelData(0), sr: MODEL_SR, duration: rendered.duration };
}
