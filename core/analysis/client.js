// Keep the original PCM for playback, learning and video alignment.
let worker = null, nextId = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  const current = worker = new Worker(new URL('./worker.js', import.meta.url));
  const drop = message => {
    if (worker !== current) return;
    current.terminate(); worker = null;
    for (const job of pending.values()) { job.stop(); job.reject(new Error(message)); }
    pending.clear();
  };
  current.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (typeof data.progress === 'string') { job.report(data.progress); return; }
    pending.delete(data.id); job.stop();
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
    if (data.reset) drop('박자 분석 도구를 다시 준비해야 해요. 파일을 다시 골라 주세요'); // ORT cannot retry a failed init inside the same worker
  };
  current.onerror = current.onmessageerror = () => drop('박자 분석 도구가 멈췄어요. 파일을 다시 골라 주세요');
  return worker;
}
function request(kind, pcm, progress = () => {}) {
  return new Promise((resolve, reject) => {
    const w = getWorker(), id = ++nextId;
    let phase = kind === 'prepare' ? '박자 찾는 도구 준비 중…' : '분석 대기 중…', seconds = 0;
    progress(phase);
    const timer = setInterval(() => progress(phase + ' (' + ++seconds + '초)', true), 1000); // 2nd arg marks a heartbeat tick
    pending.set(id, { resolve, reject, report(text) { phase = text; progress(text); }, stop() { clearInterval(timer); } });
    try {
      const copy = pcm?.slice();
      w.postMessage({ id, kind, pcm: copy }, copy ? [copy.buffer] : []);
    } catch (err) { pending.get(id).stop(); pending.delete(id); reject(err); }
  });
}
export const prepareAnalysis = progress => request('prepare', null, progress);
export const analyseGrid = (pcm, progress) => request('analyse', pcm, progress);
