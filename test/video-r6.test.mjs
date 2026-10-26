// R6: a music-only seek while the video plays (0.1 s / 1 s buttons, speed, recommendation) gets the same start check as a play start.
// Runs on a virtual clock (vclock.mjs) so CPU load cannot change the timing; VMedia models seek latency and start latency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, advance, settle } from './vclock.mjs';
import { VMedia } from './vmedia.mjs';
install();
import { createVideoSession } from '../audio/video.js';
class El extends EventTarget { constructor() { super(); this.hidden = false; this.value = ''; this.textContent = ''; this.disabled = false; } click() {} }
async function make(t, { music = {}, video = {}, ratio = 1 } = {}) {
  const previous = globalThis.document; globalThis.document = { hidden: false };
  const v = new VMedia('v', { duration: 120, seekLatency: 0.02, ...video });
  const m = new VMedia('m', { duration: 100, seekLatency: 0.03, startLatency: 0.02, ...music });
  const nodes = { video: v, replacementAudio: m }, $ = id => nodes[id] ||= new El();
  const s = createVideoSession({ $, blob: new Blob(['x'], { type: 'video/mp4' }), pcm: new Float32Array(2205 * 120),
    videoMap: { song: { duration: 120 } }, onChange() {}, onClockChange() {}, ensureCtx() {},
    analyzeMusic: async () => ({ pcm: new Float32Array(2205 * 100), m: { song: { duration: 100 } } }) });
  t.after(() => { s.dispose(); globalThis.document = previous; });
  await settle(Promise.resolve($('musicInput').onchange({ target: { files: [Object.assign(new Blob(['m'], { type: 'audio/wav' }), { name: 'm.wav' })], value: '' } })));
  await advance(100);
  s.transport.currentTime = 5; await advance(200);
  s.transport.play().catch(() => {}); await advance(4000);
  const warn = () => /못 따라와요/.test($('videoStatus').textContent);
  return { s, v, m, $, warn };
}
// Offset-corrected lag in ms: how far the music is behind where the (shifted, scaled) video says it should be.
const lagOf = (h, offset, ratio = 1) => (((h.v._clean() - offset) * ratio - h.m._clean()) / ratio) * 1000;
const trimOn = (h, ratio = 1) => Math.abs(h.m._req - h.v._req * ratio) > 1e-9;
async function watch(h, offset, ratio = 1, ms = 8000) {
  const out = { warnedMs: 0, worstAfter3s: 0, firstAbove: null };
  for (let t = 0; t < ms; t += 10) {
    await advance(10);
    if (h.warn()) out.warnedMs += 10;
    if (t >= 3000) out.worstAfter3s = Math.max(out.worstAfter3s, Math.abs(lagOf(h, offset, ratio)));
  }
  out.final = Math.abs(lagOf(h, offset, ratio)); out.rateIsFit = !trimOn(h, ratio);
  return out;
}
for (const L of [50, 75, 150]) {
  test(`R6 offset +0.1s while playing, music seek ${L} ms: no false warning, <=30 ms within 3 s, <=15 ms at the end, speed = fit`, async t => {
    const h = await make(t, { music: { seekLatency: L / 1000 } });
    const seeks0 = h.m.seeks;
    h.$('offsetLater').onclick();
    const r = await watch(h, 0.1);
    assert.equal(r.warnedMs, 0, 'warning visible ' + r.warnedMs + ' ms');
    assert.ok(r.worstAfter3s <= 30, 'worst lag after 3 s ' + r.worstAfter3s);
    assert.ok(r.final <= 15, 'final lag ' + r.final);
    assert.equal(r.rateIsFit, true);
    assert.ok(h.m.seeks - seeks0 <= (L <= 75 ? 1 : 2), 'music seeks ' + (h.m.seeks - seeks0));
  });
}
test('R6 other music-only seeks while playing: -1 s button and speed change are also quiet and converge', async t => {
  for (const [name, act, offset, ratio] of [
    ['offset -1s', h => h.$('offsetEarlierLarge').onclick(), -1, 1],
    ['speed 0.98', h => { h.$('syncRatio').value = '0.98'; h.$('syncRatio').onchange({ target: h.$('syncRatio') }); }, 0, 0.98],
  ]) {
    const h = await make(t, { music: { seekLatency: 0.075 } });
    act(h);
    const r = await watch(h, offset, ratio);
    assert.equal(r.warnedMs, 0, name + ' warning ' + r.warnedMs);
    assert.ok(r.worstAfter3s <= 30, name + ' worst ' + r.worstAfter3s);
    assert.ok(r.final <= 15, name + ' final ' + r.final);
    assert.equal(r.rateIsFit, true, name);
    h.s.dispose();
  }
});
test('R6 a gap beyond 80 ms right after a nudge is still sought and resolved (no silent hold)', async t => {
  const h = await make(t, { music: { seekLatency: 0.05 } });
  const seeks0 = h.m.seeks;
  h.$('offsetLater').onclick(); await advance(100);
  h.m._freeze(); h.m._pos -= 0.5;
  const r = await watch(h, 0.1);
  assert.ok(h.m.seeks - seeks0 >= 2, 'a second seek must happen, seeks ' + (h.m.seeks - seeks0));
  assert.ok(r.final <= 15, 'final ' + r.final);
  assert.equal(r.rateIsFit, true);
});
test('R6 a music that really cannot follow still gets the warning', async t => {
  const h = await make(t, { music: { seekLatency: 1.5 } });
  h.$('offsetLater').onclick();
  const r = await watch(h, 0.1, 1, 12000);
  assert.ok(r.warnedMs > 0, 'warning never shown');
});
test('R6 play-start behaviour is unchanged: no music seek, <=30 ms in 3 s, speed = fit', async t => {
  const h = await make(t, { music: { startLatency: 0.05 } });
  h.s.transport.pause(); await advance(100);
  h.s.transport.currentTime = 20; await advance(300);
  const seeks0 = h.m.seeks;
  h.s.transport.play().catch(() => {}); await advance(100);
  const r = await watch(h, 0);
  assert.equal(h.m.seeks - seeks0, 0);
  assert.equal(r.warnedMs, 0);
  assert.ok(r.worstAfter3s <= 30 && r.final <= 15 && r.rateIsFit, JSON.stringify(r));
});
