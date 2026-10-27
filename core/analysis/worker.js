// Classic Worker: the shipped ORT version is loaded here, never on the UI thread.
const runtime = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
let ready = null, session = null, filterbank = null;
let modules = null, queue = Promise.resolve();
function prepare(progress) {
  if (!ready) ready = (async () => {
    modules = await Promise.all([import('./logmel.js'), import('./chunking.js'), import('./postprocess.js'), import('./analyze.js')]);
    if (!globalThis.ort) importScripts(runtime + 'ort.min.js');
    ort.env.wasm.numThreads = 1; // GitHub Pages has no cross-origin isolation.
    ort.env.wasm.proxy = false; // We already own the worker.
    ort.env.wasm.wasmPaths = runtime;
    if (!filterbank) {
      const response = await fetch(new URL('../../assets/mel_filterbank_513x128.bin', self.location.href));
      if (!response.ok) throw new Error('박자 분석 필터를 받지 못했어요');
      filterbank = modules[0].prepareFilterbank(new Float32Array(await response.arrayBuffer()));
    }
    progress('박자 찾는 도구 받는 중 (9.9MB · 처음 한 번)…');
    session = await ort.InferenceSession.create(new URL('../../assets/beat_this_small0.onnx', self.location.href).href,
      { executionProviders: ['wasm'] });
  })().catch(err => { ready = null; throw err; });
  return ready;
}
async function analyse(pcm, progress) {
  await prepare(progress);
  const [{ logMelSpect }, { chunkStarts, extractChunk, aggregate, CHUNK_SIZE, MIN_FRAMES }, { pickBeats }, { analyze }] = modules;
  progress('노래를 살펴보는 중…');
  const { frames, data } = logMelSpect(pcm, filterbank);
  if (frames < MIN_FRAMES) throw new Error('30초보다 짧은 곡은 아직 분석할 수 없어요');
  const starts = chunkStarts(frames), beatChunks = [], downChunks = [];
  for (let i = 0; i < starts.length; i++) {
    progress('박자 찾는 중 ' + (i + 1) + '/' + starts.length + '…');
    const out = await session.run({ spect: new ort.Tensor('float32', extractChunk(data, frames, starts[i]), [1, CHUNK_SIZE, 128]) });
    beatChunks.push(out.beat_logits.data); downChunks.push(out.downbeat_logits.data);
  }
  const picked = pickBeats(aggregate(beatChunks, starts, frames), aggregate(downChunks, starts, frames));
  const duration = pcm.length / 22050, beats = picked.beats.filter(t => t < duration), kept = new Set(beats);
  return analyze(pcm, 22050, { sr: 22050, duration, beats, downbeats: picked.downbeats.filter(t => kept.has(t)) });
}
self.onmessage = ({ data: { id, kind, pcm } }) => {
  // One session owns inference; concurrent opens cannot interleave its jobs.
  queue = queue.then(async () => {
    const progress = text => self.postMessage({ id, progress: text });
    try {
      const result = kind === 'prepare' ? (await prepare(progress), null) : await analyse(pcm, progress);
      self.postMessage({ id, result });
    } catch (err) { self.postMessage({ id, error: err?.message || String(err), reset: !session }); }
  });
};
