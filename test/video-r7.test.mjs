// R7: (F1) seek lead = smallest of the last 3 measured seek times, (F2) 3 automatic music seeks in 10 s raise a lasting warning,
// (P1) a play-start check that cannot reach 10 ms within 4 s ends. Virtual clock (vclock.mjs); VMedia models seek/start latency and drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, advance, settle } from './vclock.mjs';
import { VMedia } from './vmedia.mjs';
install();
import { createVideoSession } from '../audio/video.js';
class El extends EventTarget { constructor() { super(); this.hidden = false; this.value = ''; this.textContent = ''; this.disabled = false; } click() {} }
// VMedia whose consecutive seeks take the latencies of seekFn (seconds).
class SeqMedia extends VMedia {
  get currentTime() { return super.currentTime; }
  set currentTime(t) { if (this.seekFn) this.seekLatency = this.seekFn(); super.currentTime = t; }
}
async function make(t, { music = {}, seq = null, play = true } = {}) {
  const previous = globalThis.document; globalThis.document = { hidden: false };
  const v = new VMedia('v', { duration: 120, seekLatency: 0.02 });
  const m = new SeqMedia('m', { duration: 100, seekLatency: 0.03, startLatency: 0.02, ...music });
  if (seq) { let i = 0; m.seekFn = () => seq[Math.min(i++, seq.length - 1)]; }
  const nodes = { video: v, replacementAudio: m }, $ = id => nodes[id] ||= new El();
  const s = createVideoSession({ $, blob: new Blob(['x'], { type: 'video/mp4' }), pcm: new Float32Array(2205 * 120),
    videoMap: { song: { duration: 120 } }, onChange() {}, onClockChange() {}, ensureCtx() {},
    analyzeMusic: async () => ({ pcm: new Float32Array(2205 * 100), m: { song: { duration: 100 } } }) });
  t.after(() => { s.dispose(); globalThis.document = previous; });
  await settle(Promise.resolve($('musicInput').onchange({ target: { files: [Object.assign(new Blob(['m'], { type: 'audio/wav' }), { name: 'm.wav' })], value: '' } })));
  await advance(100);
  s.transport.currentTime = 5; await advance(200);
  if (play) { s.transport.play().catch(() => {}); await advance(3000); }
  const warn = () => /못 따라와요/.test($('videoStatus').textContent);
  return { s, v, m, $, warn };
}
const lagOf = (h, offset = 0) => ((h.v._clean() - offset) - h.m._clean()) * 1000;
const warnText = '음악이 영상을 못 따라와요';

// ---- F1 ----
for (const [name, act, offset] of [
  ['video seek', h => { h.s.transport.currentTime = 20; }, 0],
  ['0.1 s button', h => h.$('offsetLater').onclick(), 0.1],
]) {
  test(`R7 F1 seek times 40 -> 400 -> 40 ms (${name}): music never ahead more than 30 ms, <=30 ms within 1 s, no warning`, async t => {
    const h = await make(t, { seq: [0.04, 0.4, 0.04] });
    act(h);
    let ahead = 0, lastBad = 0, warned = 0;
    for (let ms = 10; ms <= 15000; ms += 10) {
      await advance(10);
      const l = lagOf(h, offset); if (h.m._advancing()) ahead = Math.min(ahead, l);
      if (Math.abs(l) > 30) lastBad = ms; if (h.warn()) warned += 10;
    }
    assert.ok(ahead >= -30, 'music ahead by ' + ahead);
    assert.ok(lastBad <= 1000, 'out of 30 ms band until ' + lastBad + ' ms');
    assert.equal(warned, 0);
  });
}
test('R7 F1 seek times 40 -> 400 -> 400 ms: still settles within 30 ms (warning allowed on the way)', async t => {
  const h = await make(t, { seq: [0.04, 0.4, 0.4] });
  h.s.transport.currentTime = 20;
  let lastBad = 0;
  for (let ms = 10; ms <= 25000; ms += 10) { await advance(10); if (Math.abs(lagOf(h)) > 30) lastBad = ms; }
  assert.ok(lastBad < 20000, 'last out of band at ' + lastBad + ' ms');
  assert.ok(Math.abs(lagOf(h)) <= 30);
});

// ---- F2 / P1 ----
// Returns first warning time (ms after the window starts) and whether it stayed visible until the end.
async function window(h, ms = 20000) {
  let first = null, gap = false;
  for (let t = 0; t < ms; t += 10) {
    await advance(10);
    if (h.warn()) first ??= t; else if (first !== null) gap = true;
  }
  return { first, gap };
}
const slow = (h, pct) => { h.m._freeze(); h.m.drift = pct / 100; h.m._rate = h.m._req * (1 - h.m.drift); };
for (const [pct, limit] of [[5, 10000], [10, 4000], [15, 4000]]) {
  test(`R7 F2 music clock ${pct}% slow after steady play (B): warning within ${limit / 1000} s and stays`, async t => {
    const h = await make(t);
    slow(h, pct);
    const r = await window(h);
    assert.ok(r.first !== null && r.first <= limit, 'first warning ' + r.first);
    assert.equal(r.gap, false, 'warning disappeared');
    assert.ok(h.m._clean() > 0);
  });
  test(`R7 F2 music clock ${pct}% slow, then a 0.1 s nudge (C): warning within ${limit / 1000} s and stays`, async t => {
    const h = await make(t, { music: { drift: pct / 100 } });
    h.$('offsetLater').onclick();
    const r = await window(h);
    assert.ok(r.first !== null && r.first <= limit, 'first warning ' + r.first);
    assert.equal(r.gap, false, 'warning disappeared');
  });
  test(`R7 P1 music clock ${pct}% slow from the play start (A): start check ends, warning within ${limit / 1000 + 4} s of the start and stays`, async t => {
    const h = await make(t, { music: { drift: pct / 100 }, play: false });
    h.s.transport.play().catch(() => {});
    const r = await window(h);
    assert.ok(r.first !== null && r.first <= limit + 4000, 'first warning ' + r.first);
    assert.equal(r.gap, false, 'warning disappeared');
    assert.ok(Math.abs(lagOf(h)) < 300, 'lag ' + lagOf(h));
  });
}
test('R7 F2 a user action clears the lasting warning and the 10 s window', async t => {
  const h = await make(t, { music: { drift: 0.15 } });
  h.$('offsetLater').onclick();
  const r = await window(h, 6000);
  assert.ok(r.first !== null);
  h.$('offsetLater').onclick();
  assert.equal(h.warn(), false, 'warning not cleared by the button');
  await advance(500);
  assert.equal(h.warn(), false, 'warning came back after 0.5 s');
});
test('R7 F2 normal slow seeks (150 ms) after a nudge do not raise the warning (2 automatic seeks at most)', async t => {
  const h = await make(t, { music: { seekLatency: 0.15 } });
  h.$('offsetLater').onclick();
  const r = await window(h, 8000);
  assert.equal(r.first, null);
});
