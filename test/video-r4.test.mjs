import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { SpecMedia } from './specmedia.mjs';
import { createVideoSession } from '../audio/video.js';
import { estimateAlignmentAsync, isVideoFile } from '../core/video-sync.js';
const player = readFileSync(new URL('../ui/player.js', import.meta.url), 'utf8');
const extract = (a, b) => player.slice(player.indexOf(a), player.indexOf(b, player.indexOf(a)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class El extends EventTarget {
  constructor() { super(); this.hidden = false; this.value = ''; this.textContent = ''; }
  click() {}
}
function sessionEnv(t, analyzeMusic) {
  const previous = globalThis.document;
  globalThis.document = { hidden: false };
  const v = new SpecMedia('v', { duration: 60 }), m = new SpecMedia('m', { duration: 50 });
  const nodes = { video: v, replacementAudio: m }, $ = id => nodes[id] ||= new El();
  const session = createVideoSession({ $, blob: new Blob(['v']), pcm: new Float32Array(22050 * 60),
    videoMap: { song: { duration: 60 } }, ensureCtx() {}, onChange() {}, onClockChange() {},
    analyzeMusic: analyzeMusic || (async () => ({ pcm: new Float32Array(22050), m: { song: { duration: 50 } } })) });
  t.after(() => { session.dispose(); globalThis.document = previous; });
  const choose = name => $('musicInput').onchange({ target: { files: [Object.assign(new Blob(['m']), { name })], value: '' } });
  return { $, v, m, session, choose };
}
test('R4 recovery: one button tap while video is running or paused clears denial and plays music', async t => {
  for (const paused of [false, true]) {
    const e = sessionEnv(t); await e.choose('music.wav');
    let inTap = false, unlocked = false;
    const native = e.m.play.bind(e.m);
    e.m.play = () => {
      if (inTap) unlocked = true;
      return unlocked ? native() : Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    };
    await e.session.transport.play(); await sleep(60);
    assert.equal(e.$('videoStatus').textContent, '▶를 한 번 더 눌러 주세요');
    if (paused) { e.session.transport.pause(); await sleep(30); }
    const ctx = { $: e.$, countInTimer: null, au: e.session.transport, videoSession: e.session, play: () => e.session.transport.play() };
    vm.createContext(ctx); vm.runInContext(extract("$('btnPlay').onclick =", '// 이전/다음'), ctx);
    inTap = true; e.$('btnPlay').onclick(); inTap = false;
    await sleep(120);
    assert.equal(e.v.paused, false); assert.equal(e.m.paused, false);
    assert.doesNotMatch(e.$('videoStatus').textContent, /▶를 한 번 더 눌러 주세요/);
    e.session.dispose();
  }
});
test('R4 cancellation: abort is observed at the next alignment chunk', async () => {
  const c = new AbortController();
  const curve = Float32Array.from({ length: 6000 }, (_, i) => 1 + Math.sin(i * .31));
  const pending = estimateAlignmentAsync(curve, curve, 100, c.signal);
  setTimeout(() => c.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
});
for (const action of ['change', 'close', 'openFile', 'openStored']) test('R4 cancellation during matching: ' + action, async t => {
  const Native = globalThis.AbortController, controllers = [];
  globalThis.AbortController = class extends Native { constructor() { super(); controllers.push(this); } };
  t.after(() => { globalThis.AbortController = Native; });
  let release;
  const e = sessionEnv(t, async file => file.name === 'old.wav'
    ? { pcm: Float32Array.from({ length: 22050 * 60 }, (_, i) => Math.sin(i * .1) * (i % 10000 < 200 ? 1 : .01)), m: { song: { name: 'old.wav', duration: 60 } } }
    : new Promise(resolve => { release = resolve; }));
  const pending = e.choose('old.wav');
  while (e.$('videoStatus').textContent !== '맞추는 중…') await sleep(1);
  await sleep(25);
  let newer;
  if (action === 'change') newer = e.choose('new.wav');
  else if (action === 'close') e.session.dispose();
  else {
    const ctx = { videoSession: e.session, openSeq: 0, $: e.$, analyzing: new Set(),
      analyzeAndSave: () => new Promise(() => {}), decodeToModelRate: () => new Promise(() => {}) };
    const end = action === 'openFile' ? '\n// 여러 곡:' : '\nasync function restoreLastSong(';
    vm.createContext(ctx);
    vm.runInContext(extract('async function ' + action + '(', end) + '\nthis.run = ' + action + ';', ctx);
    ctx.run(action === 'openFile' ? { name: 'new.wav' } : { song: { name: 'saved.wav' } }, {});
  }
  assert.equal(controllers[0].signal.aborted, true);
  assert.equal(await Promise.race([pending.then(() => true), sleep(180).then(() => false)]), true);
  if (newer) {
    release({ pcm: new Float32Array(22050), m: { song: { name: 'new.wav', duration: 1 } } });
    await newer; assert.equal(e.session.basisMap.song.name, 'new.wav');
  } else if (action === 'close') assert.equal(e.$('videoPanel').hidden, true);
});
test('R4 N8: unknown metadata writes no audio, map, media flag or restore key, including later edits', async () => {
  for (const cached of [false, true]) {
    let writes = 0;
    const file = { name: 'clip.mp4', type: 'video/mp4', size: 1 }, m = { song: { name: file.name, size: 1, duration: 60 } };
    const ctx = { isVideoFile, checkVideoSize() {}, hasVideoTrack: async () => { throw Error('metadata'); },
      audioOnlyBlobs: new WeakSet(), sessionVideos: new Map(),
      decodeToModelRate: async () => ({ samples: new Float32Array(1), duration: 60 }),
      loadSongMap: () => cached ? m : null, ensureModel: async () => {}, analyseSamples: async () => ({}),
      analyze: () => ({}), MODEL_SR: 22050, createSongMap: () => m, applyStructureHint: x => x, structureHintFor: () => null,
      saveSongMap: x => { writes++; return x; }, saveAudio: async () => { writes++; return true; },
      refreshIfStale: async x => { writes++; return { m: x }; },
      localStorage: { setItem() { writes++; } }, songKey: () => 'clip', toast() {} };
    vm.createContext(ctx);
    vm.runInContext(extract('async function analyzeAndSave(', '\n// 재생 화면') + '\nthis.run = analyzeAndSave;', ctx);
    const result = await ctx.run(file, () => {});
    assert.equal(writes, 0); assert.equal(result.videoFallback, true);
    Object.assign(ctx, { clearTimeout() {}, countInTimer: null, queue: [], undoStack: [], objectUrl: null,
      videoSession: null, au: {}, isVideoSong: () => false, URL: { createObjectURL: () => 'blob:audio' },
      LAST_SONG: 'last', baseName: x => x, $: () => ({}), switchTab() {}, rebuild() {}, resync() {}, loopOn: false, pushUndo() {} });
    vm.runInContext(extract('function mountSong(', '\nasync function openFile(') + '\nthis.mount = mountSong;', ctx);
    ctx.mount(result.m, result.pcm, file, result.videoFallback);
    assert.equal(ctx.unsavedSong, true);
    vm.runInContext(extract('function applyMap(', '\nfunction rebuild(') + '\nthis.edit = applyMap;', ctx);
    ctx.edit({ ...m, accent: 'EVEN' });
    assert.equal(writes, 0); assert.equal(ctx.sessionVideos.size, 0);
  }
});
test('R4 N8: confirmed audio-only container still saves normally', async () => {
  let saves = 0;
  const m = { song: { name: 'audio.mp4' } }, file = { name: 'audio.mp4', type: 'video/mp4' };
  const ctx = { isVideoFile, checkVideoSize() {}, hasVideoTrack: async () => false, audioOnlyBlobs: new WeakSet(),
    decodeToModelRate: async () => ({ samples: new Float32Array(1), duration: 60 }), loadSongMap: () => m,
    refreshIfStale: async m => ({ m }), localStorage: { setItem() {} }, songKey: () => 'a', sessionVideos: new Map(),
    saveAudio: async () => { saves++; return true; }, toast() {} };
  vm.createContext(ctx); vm.runInContext(extract('async function analyzeAndSave(', '\n// 재생 화면') + '\nthis.run = analyzeAndSave;', ctx);
  await ctx.run(file, () => {}); assert.equal(saves, 1); assert.equal(ctx.audioOnlyBlobs.has(file), true);
});
async function clockCase(latency, intro = false, phaseMs = 26, ratio = 1, videoRate = 1, seekRestart = false, steadyError = 0) {
  let now = 0, tick, intervalMs;
  const previous = { document: globalThis.document, performance: globalThis.performance, interval: globalThis.setInterval };
  globalThis.document = { hidden: false }; globalThis.performance = { now: () => now * 1000 };
  globalThis.setInterval = (fn, ms) => { tick = fn; intervalMs = ms; return previous.interval(() => {}, 1000000); };
  class ClockMedia extends El {
    constructor(delay = 0) { super(); Object.assign(this, { delay, duration: 60, paused: true, seeking: false, readyState: 4,
      pos: 0, at: 0, startAt: 0, rate: 1, seeks: 0, muted: false, preservesPitch: true }); }
    get currentTime() { return this.paused ? this.pos : this.pos + Math.max(0, now - Math.max(this.at, this.startAt)) * this.rate; }
    set currentTime(value) { this.pos = value; this.at = now; this.startAt = now + (this.paused ? 0 : this.delay); this.seeks++;
      queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
    get playbackRate() { return this.rate; }
    set playbackRate(value) { this.pos = this.currentTime; this.at = now; this.rate = value; }
    play() { if (this.paused) { this.paused = false; this.at = now; this.startAt = now + this.delay; this.dispatchEvent(new Event('playing')); } return Promise.resolve(); }
    pause() { if (!this.paused) { this.pos = this.currentTime; this.paused = true; this.dispatchEvent(new Event('pause')); } }
    load() {} removeAttribute() { this.src = ''; }
  }
  const v = new ClockMedia(), m = new ClockMedia(latency / 1000), nodes = { video: v, replacementAudio: m }, notices = [];
  const $ = id => nodes[id] ||= new El();
  Object.defineProperty($('videoStatus'), 'textContent', { set(s) { notices.push(s); }, get() { return notices.at(-1); } });
  let session;
  try {
    session = createVideoSession({ $, blob: new Blob(['v']), pcm: new Float32Array(1), videoMap: { song: { duration: 60 } },
      ensureCtx() {}, onChange() {}, onClockChange() {},
      analyzeMusic: async () => ({ pcm: new Float32Array(1), m: { song: { duration: 60 } } }) });
    globalThis.setInterval = previous.interval;
    await $('musicInput').onchange({ target: { files: [new Blob(['m'])], value: '' } });
    if (intro) { $('offsetLaterLarge').onclick(); $('offsetLaterLarge').onclick(); }
    $('syncRatio').value = String(ratio); $('syncRatio').onchange({ target: $('syncRatio') });
    session.transport.playbackRate = videoRate; session.transport.currentTime = intro ? 0 : 5;
    await Promise.resolve(); await Promise.resolve(); await session.transport.play();
    if (seekRestart) { session.transport.currentTime = 8; await Promise.resolve(); await Promise.resolve(); }
    const seeks = m.seeks, activeAt = intro ? 2 / videoRate : 0;
    let atThree, maxTrim = 0, nextTick = phaseMs;
    const error = () => Math.abs(v.currentTime - (intro ? 2 : 0) - m.currentTime / ratio);
    for (let ms = 0; ms <= Math.ceil((activeAt + 6) * 1000); ms++) {
      now = ms / 1000;
      if (ms >= nextTick) { tick(); nextTick += intervalMs; await Promise.resolve(); await Promise.resolve(); }
      maxTrim = Math.max(maxTrim, Math.abs(m.playbackRate / (videoRate * ratio) - 1));
      if (ms === Math.round((activeAt + 3) * 1000)) atThree = error();
    }
    if (steadyError) {
      m.pos = m.currentTime - steadyError * ratio; m.at = now; m.startAt = now;
      for (let i = 0; i < 400; i++) { now += .02; tick(); await Promise.resolve(); await Promise.resolve();
        maxTrim = Math.max(maxTrim, Math.abs(m.playbackRate / (videoRate * ratio) - 1)); }
    }
    return { atThree, error: error(), seeks: m.seeks - seeks, maxTrim, rate: m.playbackRate, base: videoRate * ratio,
      warning: notices.some(s => /못 따라와요/.test(s)) };
  } finally { session?.dispose(); globalThis.document = previous.document; globalThis.performance = previous.performance; globalThis.setInterval = previous.interval; }
}
for (const intro of [false, true]) for (const latency of [20, 50, 75]) test('R4 delayed start: 3s/30ms, final/15ms, ' + latency + 'ms, intro=' + intro, async () => {
  const results = [];
  for (const phase of [0, 19, 26, 39]) results.push(await clockCase(latency, intro, phase));
  console.log('R4 clock', latency, 'intro', intro, 'at3sMs', results.map(r => (r.atThree * 1000).toFixed(1)).join(','),
    'finalMs', results.map(r => (r.error * 1000).toFixed(1)).join(','), 'rates', results.map(r => r.rate).join(','));
  for (const r of results) {
    assert.ok(r.atThree <= .030 + 1e-9, '3s error ms=' + r.atThree * 1000);
    assert.ok(r.error <= .015 + 1e-9, 'final error ms=' + r.error * 1000);
    assert.equal(r.rate, r.base); assert.equal(r.seeks, 0); assert.ok(r.maxTrim <= .030000001); assert.equal(r.warning, false);
  }
});
test('R4 delayed start after seek and non-unit fit restores the exact base rate', async () => {
  const r = await clockCase(75, false, 26, .85, .75, true);
  assert.ok(r.error <= .015); assert.equal(r.rate, .75 * .85); assert.equal(r.seeks, 0);
  assert.ok(r.maxTrim <= .030000001); assert.equal(r.warning, false);
});
for (const error of [-.05, .05]) test('R4 steady 50ms drift trims without seek or warning: ' + error, async () => {
  const r = await clockCase(0, false, 26, .85, 1, false, error);
  assert.ok(r.error <= .010 + 1e-9); assert.equal(r.rate, r.base); assert.equal(r.seeks, 0);
  assert.ok(r.maxTrim <= .030000001); assert.equal(r.warning, false);
});
test('R4 steady drift above 80ms still seeks', async () => {
  const r = await clockCase(0, false, 26, 1, 1, false, .2);
  assert.ok(r.seeks > 0 && r.seeks <= 2); assert.ok(r.error <= .030); assert.equal(r.rate, r.base);
});
