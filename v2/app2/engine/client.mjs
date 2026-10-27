import { validateEngineResult } from './result.mjs';

let worker = null, nextId = 0, watchdog = null;
const pending = new Map();
const stopped = '박자 분석 도구가 멈췄어요. 파일을 다시 골라 주세요';
// Silence, not total song time: slow devices may spend minutes loading or on a chunk.
const silenceMs = 180000;
function clearWatchdog() { clearTimeout(watchdog); watchdog = null; }
function dropWorker(current, message, details = {}) {
  if (worker !== current) return;
  worker = null; clearWatchdog(); current.terminate();
  const jobs = [...pending.values()]; pending.clear();
  for (const job of jobs) {
    job.stop(); job.reject(Object.assign(new Error(message), details, { openToken: job.openToken }));
  }
}
function armWatchdog(current) {
  clearWatchdog();
  if (pending.size) watchdog = setTimeout(() => dropWorker(current,
    '분석 응답이 오래 없어요. 파일을 다시 골라 주세요',
    { name: 'TimeoutError', code: 'worker_timeout' }), silenceMs);
}
function takeJob(id) {
  const job = pending.get(id);
  if (job) { pending.delete(id); job.stop(); }
  if (!pending.size) clearWatchdog();
  return job;
}
// The client alone owns cancellation and recreation. A shared worker's queued prepares
// also abort when an analysis is superseded; standalone preparation is kept warm.
export function cancelAnalysis() {
  if ([...pending.values()].some(job => job.kind === 'analyse')) dropWorker(worker,
    '새 곡을 열어 이전 분석을 취소했어요', { name: 'AbortError', code: 'superseded' });
}
function getWorker() {
  if (worker) return worker;
  // ORT 1.19.2's UMD loader uses importScripts; run.mjs is dynamically imported there.
  const current = worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'classic' });
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    const job = pending.get(data.id);
    if (!job) return;
    armWatchdog(current);
    if (typeof data.progress === 'string') { job.report(data.progress); return; }
    takeJob(data.id);
    if (data.error) job.reject(Object.assign(new Error(data.error), { openToken: job.openToken }));
    else {
      const checked = job.kind === 'prepare' ? { ok: data.result === null, errors: ['prepare result must be null'] }
        : validateEngineResult(data.result);
      if (!checked.ok) job.reject(Object.assign(new Error('Invalid EngineResult: ' + checked.errors.join('; ')), { openToken: job.openToken }));
      else job.resolve({ openToken: job.openToken, result: data.result });
    }
    if (data.reset) dropWorker(current, '박자 분석 도구를 다시 준비해야 해요. 파일을 다시 골라 주세요');
  };
  current.onerror = current.onmessageerror = () => dropWorker(current, stopped);
  return current;
}
function request(kind, pcm, options = {}) {
  return new Promise((resolve, reject) => {
    const openToken = options?.openToken;
    const fail = error => reject(Object.assign(error, { openToken }));
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return fail(new TypeError('options must be an object'));
    const { progress = () => {}, structure = false } = options;
    if (typeof progress !== 'function') return fail(new TypeError('progress must be a function'));
    if (kind === 'analyse' && !(pcm instanceof Float32Array)) return fail(new TypeError('Expected mono Float32Array at 22050 Hz'));
    if (typeof structure !== 'boolean') return fail(new TypeError('structure must be boolean'));
    if (kind === 'analyse') cancelAnalysis();
    let w; try { w = getWorker(); } catch (error) { return fail(error); }
    const id = ++nextId;
    let phase = kind === 'prepare' ? '박자 찾는 도구 준비 중…' : '분석 대기 중…', seconds = 0;
    const notify = (text, heartbeat) => {
      try { progress(text, heartbeat, openToken); }
      catch (error) {
        takeJob(id);
        dropWorker(w, stopped);
        fail(new Error(error?.message ?? String(error)));
      }
    };
    const timer = setInterval(() => notify(phase + ' (' + ++seconds + '초)', true), 1000);
    pending.set(id, { resolve, reject, kind, openToken,
      report(text) { phase = text; notify(text, false); }, stop() { clearInterval(timer); } });
    if (watchdog === null) armWatchdog(w);
    try {
      notify(phase, false);
      if (!pending.has(id)) return;
      const copy = pcm?.slice();
      // The token stays on this side (any JS value, compared by identity); the worker never needs it.
      w.postMessage({ id, kind, pcm: copy, structure }, copy ? [copy.buffer] : []);
    } catch (error) { takeJob(id); fail(error); }
  });
}

// Both resolve to { openToken, result }; prepare's result is null.
export const prepareAnalysis = options => request('prepare', null, options);
export const analyzePcmInWorker = (pcm, options) => request('analyse', pcm, options);
