// R8: (1) the music clock needs a while to start after a music seek ("resume delay"): a seek aims ahead by the smallest of the last 3 measured
// resume delays too, so 0.1 s / 1 s buttons, rate changes and video seeks settle instead of re-seeking forever;
// (2) a music that is slow to start at all (play start, intro) settles after the 4 s start-up deadline without a seek loop;
// (3) the lasting "cannot follow" warning ends when the music has recovered. Virtual clock (vclock.mjs); VMedia startLatency = resume delay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, advance, settle } from './vclock.mjs';
import { VMedia } from './vmedia.mjs';
install();
import { createVideoSession } from '../audio/video.js';
class El extends EventTarget { constructor() { super(); this.hidden = false; this.value = ''; this.textContent = ''; this.disabled = false; } click() {} }
async function make(t, { music = {}, play = true } = {}) {
  const previous = globalThis.document; globalThis.document = { hidden: false };
  const v = new VMedia('v', { duration: 120, seekLatency: 0.02 });
  const m = new VMedia('m', { duration: 100, seekLatency: 0.03, startLatency: 0.02, ...music });
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
  return { s, v, m, $, warn, fit: { offset: 0, ratio: 1 } };
}
// Music position error in ms, in video time, for the fit the test has applied.
const lagOf = h => (((h.v._clean() - h.fit.offset) * h.fit.ratio - h.m._clean()) / h.fit.ratio) * 1000;
const actions = {
  '0.1 s button': h => { h.$('offsetLater').onclick(); h.fit.offset += 0.1; },
  '1 s button': h => { h.$('offsetLaterLarge').onclick(); h.fit.offset += 1; },
  'rate change': h => { h.$('syncRatio').value = '0.95'; h.$('syncRatio').onchange({ target: h.$('syncRatio') }); h.fit.ratio = 0.95; },
  'video seek': h => { h.s.transport.currentTime = 20; },
};
// Runs 12 virtual seconds after the action: seeks, ms with the warning visible, last time |lag| > 30 ms, |lag| at the end.
async function after(h, action) {
  await advance(4000); // let a slow play start settle first (it ends at the 4 s deadline); the action comes during steady play
  const seeks0 = h.m.seeks; actions[action](h);
  let warned = 0, lastBad = 0;
  for (let ms = 10; ms <= 12000; ms += 10) {
    await advance(10); if (Math.abs(lagOf(h)) > 30) lastBad = ms; if (h.warn()) warned += 10;
  }
  return { seeks: h.m.seeks - seeks0, warned, lastBad, final: Math.abs(lagOf(h)) };
}

// ---- 1: resume delay after a seek ----
for (const action of Object.keys(actions)) for (const resume of [85, 100, 200, 300]) {
  test(`R8 resume delay ${resume} ms after ${action}: <=30 ms within 3 s, final <=15 ms, <=3 seeks, no warning`, async t => {
    const h = await make(t, { music: { startLatency: resume / 1000 } });
    const r = await after(h, action);
    assert.ok(r.lastBad <= 3000, 'out of the 30 ms band until ' + r.lastBad + ' ms');
    assert.ok(r.final <= 15, 'final lag ' + r.final);
    assert.ok(r.seeks <= 3, 'seeks ' + r.seeks);
    assert.equal(r.warned, 0, 'warning visible ' + r.warned + ' ms');
  });
}
// Normal devices (resume delay 0-20 ms) keep the r7 behaviour: one seek, no warning, settled at once.
for (const action of Object.keys(actions)) for (const resume of [0, 20]) {
  test(`R8 normal device (resume delay ${resume} ms) after ${action}: one seek, no warning, <=30 ms within 1 s, final <=12 ms`, async t => {
    const h = await make(t, { music: { startLatency: resume / 1000 } });
    const r = await after(h, action);
    assert.equal(r.seeks, 1);
    assert.equal(r.warned, 0);
    assert.ok(r.lastBad <= 1000, 'out of band until ' + r.lastBad + ' ms');
    assert.ok(r.final <= 12, 'final lag ' + r.final);
  });
}
test('R8 resume delay 200 ms: the music never ends up ahead of the video by more than 30 ms after the seek has landed', async t => {
  const h = await make(t, { music: { startLatency: 0.2 } });
  await advance(4000); actions['0.1 s button'](h);
  let ahead = 0;
  for (let ms = 10; ms <= 5000; ms += 10) { await advance(10); if (h.m._advancing()) ahead = Math.min(ahead, lagOf(h)); }
  assert.ok(ahead >= -30, 'music ahead by ' + ahead + ' ms');
});

// ---- 2: music that is slow to start (play start inside the range, intro entry) ----
for (const resume of [190, 200, 300]) {
  test(`R8 music starts ${resume} ms after play (inside the range): settles after the 4 s start-up deadline, <=3 seeks, no warning at the end`, async t => {
    const h = await make(t, { music: { startLatency: resume / 1000 }, play: false });
    const seeks0 = h.m.seeks; h.s.transport.play().catch(() => {});
    let lastBad = 0, warned = 0;
    for (let ms = 10; ms <= 30000; ms += 10) {
      await advance(10); if (ms > 300 && Math.abs(lagOf(h)) > 30) lastBad = ms; if (h.warn()) warned += 10;
    }
    t.diagnostic(`music start ${resume} ms: last >30 ms at ${(lastBad / 1000).toFixed(2)} s, seeks ${h.m.seeks - seeks0}, warning ${warned} ms`);
    assert.ok(h.m.seeks - seeks0 <= 3, 'seeks ' + (h.m.seeks - seeks0));
    assert.ok(lastBad <= 8000, 'out of band until ' + lastBad + ' ms');
    assert.ok(Math.abs(lagOf(h)) <= 15, 'final lag ' + lagOf(h));
    assert.equal(h.warn(), false);
    assert.equal(warned, 0, 'warning visible ' + warned + ' ms');
  });
}

// ---- 3: the lasting warning ends after recovery ----
test('R8 a transient slowdown (music clock 10% slow for 5 s): the warning shows, then ends within 10 s of the recovery, final <=15 ms', async t => {
  const h = await make(t);
  const slow = pct => { h.m._freeze(); h.m.drift = pct / 100; h.m._rate = h.m._req * (1 - h.m.drift); };
  slow(10);
  let first = null;
  for (let ms = 0; ms < 5000; ms += 10) { await advance(10); if (h.warn() && first === null) first = ms; }
  assert.ok(first !== null, 'the warning never showed');
  slow(0);
  let off = null;
  for (let ms = 10; ms <= 20000; ms += 10) { await advance(10); if (!h.warn() && off === null) off = ms; if (h.warn()) off = null; }
  assert.ok(off !== null && off <= 10000, 'warning ended at ' + off + ' ms after the recovery');
  assert.ok(Math.abs(lagOf(h)) <= 15, 'final lag ' + lagOf(h));
  assert.equal(h.m.drift, 0);
});
test('R8 after the warning ended the normal 10 ms settle rule is back (a trim of 20 ms is corrected again)', async t => {
  const h = await make(t);
  const slow = pct => { h.m._freeze(); h.m.drift = pct / 100; h.m._rate = h.m._req * (1 - h.m.drift); };
  slow(10); await advance(5000); slow(0); await advance(15000);
  assert.equal(h.warn(), false);
  // A new small drift episode (0.5% slow for 2 s = about 10 ms) must be pulled back to the 10 ms rule, not left at up to 30 ms.
  slow(1); await advance(3000); slow(0); await advance(5000);
  assert.ok(Math.abs(lagOf(h)) <= 12, 'lag ' + lagOf(h));
  assert.equal(h.warn(), false);
});
test('R8 a music that keeps failing keeps the warning (no clearing while it is outside the 30 ms band)', async t => {
  const h = await make(t);
  h.m._freeze(); h.m.drift = 0.15; h.m._rate = h.m._req * (1 - h.m.drift);
  let first = null, gap = false;
  for (let ms = 0; ms < 30000; ms += 10) {
    await advance(10); if (h.warn()) first ??= ms; else if (first !== null) gap = true;
  }
  assert.ok(first !== null && first <= 4000, 'first warning ' + first);
  assert.equal(gap, false, 'warning disappeared');
});
