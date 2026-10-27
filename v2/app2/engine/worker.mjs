// Classic entry point for pinned ORT's importScripts. Analysis itself is shared ESM.
const runtime = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
let modules, ready, structureReady, session, structureSession, filterbank;
let resetRequired = false, queue = Promise.resolve();
async function loadModules() {
  // The browser caches a failed module fetch for this worker's lifetime, so a load failure needs the same reset as ORT init.
  if (!modules) modules = await Promise.all([import('./run.mjs'), import('../../app/core/analysis/logmel.js')])
    .catch(error => { resetRequired = true; throw error; });
  return modules;
}
// Report received bytes only: the client remains the sole silence/timeout authority.
async function download(url, label, progress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(label + '를 받지 못했어요');
  // Fetch exposes decoded bytes; encoded lengths (possibly hidden by CORS) are not comparable.
  const encoding = response.headers?.get('Content-Encoding');
  const size = response.type !== 'cors' && (!encoding || encoding.toLowerCase() === 'identity')
    ? Number(response.headers?.get('Content-Length')) : NaN;
  const total = Number.isFinite(size) && size > 0 ? '/' + (size / 1e6).toFixed(1) : '';
  let received = 0, reported = 0, lastReport = performance.now();
  const report = () => progress(label + ' 받는 중 ' + (received / 1e6).toFixed(1) + total + 'MB (처음 한 번)…');
  if (typeof response.body?.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    received = bytes.byteLength;
    if (received) report();
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;
      chunks.push(value); received += value.byteLength;
      const now = performance.now();
      if (received - reported >= 256 * 1024 || now - lastReport >= 1000) {
        report(); reported = received; lastReport = now;
      }
    }
  } finally { reader.releaseLock(); }
  if (received > reported) report();
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function prepare(progress, structure) {
  if (resetRequired) throw new Error('박자 분석 도구를 다시 준비해야 해요. 파일을 다시 골라 주세요');
  if (!ready) ready = (async () => {
    const [, { prepareFilterbank }] = await loadModules();
    if (!globalThis.ort) importScripts(runtime + 'ort.min.js');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = runtime;
    const response = await fetch(new URL('../../app/assets/mel_filterbank_513x128.bin', self.location.href));
    if (!response.ok) throw new Error('박자 분석 필터를 받지 못했어요');
    filterbank = prepareFilterbank(new Float32Array(await response.arrayBuffer()));
    const model = await download(new URL('../../app/assets/beat_this_small0.onnx', self.location.href), '박자 찾는 도구', progress);
    // Pinned ORT 1.19.2's wasm-factory passes env.wasm.wasmBinary to the Emscripten factory.
    ort.env.wasm.wasmBinary = await download(runtime + 'ort-wasm-simd-threaded.wasm', '박자 분석 실행기', progress);
    session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  })().catch(error => { resetRequired = true; throw error; });
  await ready;
  if (structure) {
    if (!structureReady) structureReady = ort.InferenceSession.create(
      new URL('../../app/assets/metrical_tcn_v1.onnx', self.location.href).href,
      { executionProviders: ['wasm'] }).then(value => { structureSession = value; })
      .catch(error => { resetRequired = true; throw error; });
    await structureReady;
  }
}
self.onmessage = ({ data: { id, kind, pcm, openToken, structure = false } }) => {
  queue = queue.then(async () => {
    const progress = text => self.postMessage({ id, openToken, progress: text });
    try {
      if (!['prepare', 'analyse'].includes(kind)) throw new TypeError('Unknown engine request');
      if (typeof structure !== 'boolean') throw new TypeError('structure must be boolean');
      const [{ analyzePcm, validatePcm }] = await loadModules();
      if (kind === 'analyse') validatePcm(pcm);
      await prepare(progress, structure);
      const result = kind === 'prepare' ? null : await analyzePcm(pcm,
        { session, filterbank, ort, structure, structureSession, progress });
      self.postMessage({ id, openToken, result });
    } catch (error) {
      // Only the client destroys/recreates workers. Never retry sticky ORT init here.
      self.postMessage({ id, openToken, error: error?.message || String(error), reset: resetRequired });
    }
  });
};
