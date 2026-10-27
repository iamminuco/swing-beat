import test from 'node:test';
import assert from 'node:assert/strict';
let serial = 0;
async function environment(t) {
  const original = { Worker: globalThis.Worker, setInterval, clearInterval };
  const workers = [], timers = new Map(); let nextTimer = 0;
  class Worker {
    constructor(url) { this.url = url; this.messages = []; workers.push(this); }
    postMessage(data, transfer) { if (this.broken) throw new Error('send failed'); this.messages.push(structuredClone(data, { transfer })); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
  }
  globalThis.Worker = Worker;
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 1000); timers.set(++nextTimer, fn); return nextTimer; };
  globalThis.clearInterval = id => timers.delete(id);
  t.after(() => Object.assign(globalThis, original));
  const client = await import('../core/analysis/client.js?test=' + ++serial);
  return { ...client, workers, timers, tick() { for (const fn of timers.values()) fn(); } };
}
test('analysis sends a transferred COPY to a worker and keeps the source PCM usable', async t => {
  const e = await environment(t), pcm = new Float32Array([0.25, -0.5]), progress = [];
  const job = e.analyseGrid(pcm, text => progress.push(text)), w = e.workers[0];
  assert.equal(w.url.pathname.endsWith('/core/analysis/worker.js'), true);
  assert.deepEqual(pcm, new Float32Array([0.25, -0.5]));
  assert.deepEqual(w.messages[0].pcm, pcm);
  const id = w.messages[0].id, result = { beats: [0.2], counts: [1] };
  w.reply({ id, progress: 'chunk 1/2' }); e.tick(); e.tick();
  assert.equal(progress.at(-2), 'chunk 1/2 (1초)'); assert.equal(progress.at(-1), 'chunk 1/2 (2초)');
  w.reply({ id, result }); assert.deepEqual(await job, result); assert.equal(e.timers.size, 0);
});
test('overlapping requests keep their own progress and result, using one worker', async t => {
  const e = await environment(t), a = [], b = [];
  const first = e.analyseGrid(new Float32Array(2), text => a.push(text));
  const second = e.prepareAnalysis(text => b.push(text));
  assert.equal(e.workers.length, 1); const w = e.workers[0], [x, y] = w.messages;
  w.reply({ id: y.id, progress: 'loading' }); assert.equal(a.includes('loading'), false);
  w.reply({ id: y.id, result: null }); w.reply({ id: x.id, result: { beats: [1] } });
  assert.equal(await second, null); assert.deepEqual(await first, { beats: [1] }); assert.equal(e.timers.size, 0);
});
test('a failed analysis clears its heartbeat and does not poison the next job', async t => {
  const e = await environment(t), job = e.analyseGrid(new Float32Array(1)), w = e.workers[0];
  const rejected = assert.rejects(job, /too short/); w.reply({ id: w.messages[0].id, error: 'too short' }); await rejected;
  assert.equal(e.timers.size, 0); const next = e.prepareAnalysis(); w.reply({ id: w.messages[1].id, result: null }); await next;
});
test('worker crash rejects all jobs, stops heartbeats, and allows a fresh worker', async t => {
  const e = await environment(t), a = e.prepareAnalysis(), b = e.analyseGrid(new Float32Array(2));
  const rejected = Promise.all([assert.rejects(a, /파일을 다시/), assert.rejects(b, /파일을 다시/)]);
  const w = e.workers[0]; w.onerror(); await rejected; assert.equal(w.terminated, true); assert.equal(e.timers.size, 0);
  const next = e.prepareAnalysis(), fresh = e.workers[1]; w.onerror(); assert.equal(fresh.terminated, undefined); fresh.reply({ id: fresh.messages[0].id, result: null }); await next;
});
test('a message decode failure is recoverable and clears all timers', async t => {
  const e = await environment(t), p = e.prepareAnalysis(), rejected = assert.rejects(p, /분석 도구/);
  e.workers[0].onmessageerror(); await rejected; assert.equal(e.timers.size, 0);
});
test('a failed postMessage does not leave a heartbeat running', async t => {
  const e = await environment(t), p = e.prepareAnalysis(), w = e.workers[0]; w.reply({ id: w.messages[0].id, result: null }); await p;
  w.broken = true; await assert.rejects(e.analyseGrid(new Float32Array(2)), /send failed/); assert.equal(e.timers.size, 0);
});
test('a reset reply recycles the worker so the next job gets a fresh one', async t => {
  const e = await environment(t), p = e.prepareAnalysis(), w = e.workers[0], rejected = assert.rejects(p, /init/);
  w.reply({ id: w.messages[0].id, error: 'init', reset: true }); await rejected;
  assert.equal(w.terminated, true); assert.equal(e.timers.size, 0);
  const next = e.prepareAnalysis(), fresh = e.workers[1]; fresh.reply({ id: fresh.messages[0].id, result: null }); await next;
});
test('heartbeat ticks are flagged so background-batch toasts can ignore them', async t => {
  const e = await environment(t), calls = [], job = e.prepareAnalysis((text, tick) => calls.push([text, !!tick])), w = e.workers[0];
  e.tick(); w.reply({ id: w.messages[0].id, result: null }); await job;
  assert.deepEqual(calls[0], ['박자 찾는 도구 준비 중…', false]); assert.deepEqual(calls.at(-1), ['박자 찾는 도구 준비 중… (1초)', true]);
});
