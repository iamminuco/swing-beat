import { validateEngineResult } from './result.mjs';

let worker = null, nextId = 0;
const pending = new Map();
const stopped = '박자 분석 도구가 멈췄어요. 파일을 다시 골라 주세요';
function getWorker() {
  if (worker) return worker;
  // ORT 1.19.2's UMD loader uses importScripts; run.mjs is dynamically imported there.
  const current = worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'classic' });
  const drop = message => {
    if (worker !== current) return;
    worker = null; current.terminate();
    for (const job of pending.values()) {
      job.stop(); job.reject(Object.assign(new Error(message), { openToken: job.openToken }));
    }
    pending.clear();
  };
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    const job = pending.get(data.id);
    if (!job) return;
    if (typeof data.progress === 'string') { job.report(data.progress); return; }
    pending.delete(data.id); job.stop();
    if (data.error) job.reject(Object.assign(new Error(data.error), { openToken: job.openToken }));
    else {
      const checked = job.kind === 'prepare' ? { ok: data.result === null, errors: ['prepare result must be null'] }
        : validateEngineResult(data.result);
      if (!checked.ok) job.reject(Object.assign(new Error('Invalid EngineResult: ' + checked.errors.join('; ')), { openToken: job.openToken }));
      else job.resolve({ openToken: job.openToken, result: data.result });
    }
    if (data.reset) drop('박자 분석 도구를 다시 준비해야 해요. 파일을 다시 골라 주세요');
  };
  current.onerror = current.onmessageerror = () => drop(stopped);
  return current;
}
function request(kind, pcm, { openToken, progress = () => {}, structure = false } = {}) {
  return new Promise((resolve, reject) => {
    const fail = error => reject(Object.assign(error, { openToken }));
    if (kind === 'analyse' && !(pcm instanceof Float32Array)) return fail(new TypeError('Expected mono Float32Array at 22050 Hz'));
    if (typeof structure !== 'boolean') return fail(new TypeError('structure must be boolean'));
    let w; try { w = getWorker(); } catch (error) { return fail(error); }
    const id = ++nextId;
    let phase = kind === 'prepare' ? '박자 찾는 도구 준비 중…' : '분석 대기 중…', seconds = 0;
    progress(phase, false, openToken);
    const timer = setInterval(() => progress(phase + ' (' + ++seconds + '초)', true, openToken), 1000);
    pending.set(id, { resolve, reject, kind, openToken,
      report(text) { phase = text; progress(text, false, openToken); }, stop() { clearInterval(timer); } });
    try {
      const copy = pcm?.slice();
      // The token stays on this side (any JS value, compared by identity); the worker never needs it.
      w.postMessage({ id, kind, pcm: copy, structure }, copy ? [copy.buffer] : []);
    } catch (error) { pending.get(id).stop(); pending.delete(id); fail(error); }
  });
}

// Both resolve to { openToken, result }; prepare's result is null.
export const prepareAnalysis = options => request('prepare', null, options);
export const analyzePcmInWorker = (pcm, options) => request('analyse', pcm, options);
