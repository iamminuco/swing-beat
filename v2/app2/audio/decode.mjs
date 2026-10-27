export const MODEL_SR = 22050;

// Offline decoding never creates the realtime playback context.
export async function decodeToModelRate(file, {
  offlineFactory = (channels, frames, sr) => new globalThis.OfflineAudioContext(channels, frames, sr),
  maxDuration = 1800,
} = {}) {
  if (!Number.isFinite(maxDuration) || maxDuration <= 0) throw new RangeError('maxDuration');
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) throw new Error('Empty audio file');
  const probe = offlineFactory(1, 1, MODEL_SR);
  const decoded = await probe.decodeAudioData(bytes.slice(0));
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > maxDuration)
    throw new RangeError('Audio duration outside decode limit');
  const frames = Math.ceil(decoded.duration * MODEL_SR);
  const off = offlineFactory(1, frames, MODEL_SR);
  const source = off.createBufferSource();
  source.buffer = decoded;
  source.connect(off.destination);
  try {
    source.start();
    const rendered = await off.startRendering();
    const samples = rendered.getChannelData(0);
    if (rendered.sampleRate !== MODEL_SR || rendered.numberOfChannels !== 1 ||
        samples.length !== frames || !samples.every(Number.isFinite)) throw new Error('Invalid rendered PCM');
    return { samples, sr: MODEL_SR, duration: samples.length / MODEL_SR };
  } finally { source.disconnect(); }
}
