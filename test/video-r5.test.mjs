import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SpecMedia } from './specmedia.mjs';
import { createVideoSession } from '../audio/video.js';
const player = readFileSync(new URL('../ui/player.js', import.meta.url), 'utf8');
const extract = (a, b) => player.slice(player.indexOf(a), player.indexOf(b, player.indexOf(a)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class El extends EventTarget {
  constructor() { super(); this.hidden = false; this.value = ''; this.textContent = ''; }
  click() {}
}
async function sessionEnv(t, vOpts = {}, mOpts = {}) {
  const previous = globalThis.document;
  globalThis.document = { hidden: false };
  const v = new SpecMedia('v', { duration: 60, ...vOpts }), m = new SpecMedia('m', { duration: 50, ...mOpts });
  const nodes = { video: v, replacementAudio: m }, $ = id => nodes[id] ||= new El();
  const session = createVideoSession({ $, blob: new Blob(['v']), pcm: new Float32Array(22050 * 60),
    videoMap: { song: { duration: 60 } }, ensureCtx() {}, onChange() {}, onClockChange() {},
    analyzeMusic: async () => ({ pcm: new Float32Array(22050), m: { song: { duration: 50 } } }) });
  t.after(() => { session.dispose(); globalThis.document = previous; });
  await $('musicInput').onchange({ target: { files: [Object.assign(new Blob(['m']), { name: 'm.wav' })], value: '' } });
  return { $, v, m, session };
}
function buttonCtx(e) {
  const ctx = { $: e.$, countInTimer: null, au: e.session.transport, videoSession: e.session, play: () => e.session.transport.play() };
  vm.createContext(ctx); vm.runInContext(extract("$('btnPlay').onclick =", '// 이전/다음'), ctx);
  return ctx;
}
test('R5 button: a music failure that a tap cannot fix does not take the tap, the video can be paused', async t => {
  const e = await sessionEnv(t);
  e.m.play = () => Promise.reject(Object.assign(new Error('The element has no supported sources.'), { name: 'NotSupportedError' }));
  e.session.transport.currentTime = 2; await sleep(60);
  e.session.transport.play().catch(() => {}); await sleep(200);
  assert.match(e.$('videoStatus').textContent, /못 따라와요/);
  assert.equal(e.v.paused, false);
  buttonCtx(e); e.$('btnPlay').onclick(); await sleep(60);
  assert.equal(e.v.paused, true);
});
test('R5 button: the touch-fixable denial (NotAllowedError) still takes the tap', async t => {
  const e = await sessionEnv(t);
  e.m.play = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  e.session.transport.play().catch(() => {}); await sleep(200);
  assert.equal(e.$('videoStatus').textContent, '▶를 한 번 더 눌러 주세요');
  assert.equal(e.session.recoverTap(), true);
  await sleep(60); e.session.dispose();
});
test('R5 stall: a video stall during a fine trim at 22 ms error neither seeks the music nor warns', async t => {
  const e = await sessionEnv(t, { seekLatency: 0.02 }, { seekLatency: 0.03 });
  const now = () => performance.now() / 1000, lag = () => (e.v.currentTime - e.m.currentTime) * 1000;
  e.session.transport.currentTime = 5; await sleep(200);
  await e.session.transport.play().catch(() => {}); await sleep(1500);
  const seeks0 = e.m.seeks;
  e.m._freeze(); e.m._pos -= 0.045;
  for (let i = 0; i < 300 && !(e.m.playbackRate > 1 && lag() <= 22); i++) await sleep(10);
  assert.ok(e.m.playbackRate > 1, 'trim must be active before the stall');
  let warned = false; const watch = setInterval(() => { if (/못 따라와요/.test(e.$('videoStatus').textContent)) warned = true; }, 5);
  e.v._freeze(); e.v.readyState = 2; e.v._fire('waiting'); await sleep(150);
  e.v.readyState = 4; e.v._t0 = now(); e.v._fire('playing');
  await sleep(2000); clearInterval(watch);
  assert.equal(e.m.seeks - seeks0, 0);
  assert.equal(warned, false);
  assert.ok(Math.abs(lag()) <= 15, 'final lag ' + lag());
});
test('R5 chatter: outside start-up a trim needs 3 consecutive ticks over 30 ms', async t => {
  const e = await sessionEnv(t);
  e.session.transport.currentTime = 5; await sleep(100);
  await e.session.transport.play().catch(() => {}); await sleep(1500);
  assert.equal(e.m.playbackRate, 1);
  let bias = 0; const real = Object.getOwnPropertyDescriptor(SpecMedia.prototype, 'currentTime').get;
  Object.defineProperty(e.m, 'currentTime', { get() { return real.call(this) - bias; }, set(x) { SpecMedia.prototype.__lookupSetter__('currentTime').call(this, x); }, configurable: true });
  const sync = e.session.sync, seeks0 = e.m.seeks;
  bias = 0.04; sync(); sync();                     // two ticks over 30 ms
  bias = 0; sync();                                 // back inside: counter resets
  bias = 0.04; sync(); sync();                      // two more: still no trim
  assert.equal(e.m.playbackRate, 1);
  sync();                                           // third consecutive tick
  assert.ok(e.m.playbackRate > 1.02, 'rate ' + e.m.playbackRate);
  assert.equal(e.m.seeks, seeks0);
});
