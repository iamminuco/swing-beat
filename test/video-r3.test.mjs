import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SpecMedia } from './specmedia.mjs';
import * as video from '../audio/video.js';
import * as alignment from '../core/video-sync.js';
const player = readFileSync(new URL('../ui/player.js', import.meta.url), 'utf8');
const extract = (a, b) => player.slice(player.indexOf(a), player.indexOf(b, player.indexOf(a)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class El extends EventTarget {
  constructor() { super(); this.hidden = false; this.value = ''; this.textContent = ''; }
  set textContent(value) { this.text = value; (this.messages ||= []).push(value); }
  get textContent() { return this.text; }
  click() {}
}
async function env(t, latency = .02) {
  const previous = globalThis.document;
  globalThis.document = { hidden: false };
  const v = new SpecMedia('v', { duration: 60, seekLatency: .02 });
  const m = new SpecMedia('m', { duration: 40, seekLatency: latency });
  const nodes = { video: v, replacementAudio: m }, $ = id => nodes[id] ||= new El();
  const session = video.createVideoSession({ $, blob: new Blob(['v']), pcm: new Float32Array(22050),
    videoMap: { song: { duration: 60 } }, ensureCtx() {}, onChange() {}, onClockChange() {},
    analyzeMusic: async () => ({ pcm: new Float32Array(22050), m: { song: { duration: 40 } } }) });
  t.after(() => { session.dispose(); globalThis.document = previous; });
  await $('musicInput').onchange({ target: { files: [new Blob(['m'])], value: '' } });
  return { $, v, m, session };
}
test('N1: intro tap primes music, late denial prompts another tap and retry succeeds', async t => {
  const e = await env(t); e.$('offsetLaterLarge').onclick();
  const native = e.m.play.bind(e.m);
  let inTap = false, inside = 0;
  e.m.play = () => {
    if (inTap) { inside++; return native(); }
    return Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
  };
  const muted = e.m.muted, position = e.m.currentTime;
  inTap = true; const first = e.session.transport.play(); inTap = false;
  assert.ok(inside >= 1); assert.equal(e.m.muted, muted);
  assert.equal(e.m.paused, true); assert.equal(e.m.currentTime, position);
  await first; await sleep(60);
  e.v._pos = 2; e.session.sync(); await sleep(100);
  assert.equal(e.$('videoStatus').textContent, '▶를 한 번 더 눌러 주세요');
  assert.equal(e.v.paused, false);
  e.session.transport.pause(); await sleep(30);
  inTap = true; const retry = e.session.transport.play(); inTap = false;
  await retry; await sleep(100);
  assert.ok(inside >= 2); assert.equal(e.v.paused, false); assert.equal(e.m.paused, false);
});
test('N1: list and both queue buttons prime the music element before asynchronous work', () => {
  let calls = 0;
  const music = { src: '', paused: true, muted: false, currentTime: 3,
    play() { calls++; this.paused = false; return Promise.reject(Object.assign(new Error(), { name: 'AbortError' })); },
    pause() { this.paused = true; } };
  const ctx = { $: id => id === 'replacementAudio' ? music : { src: 'existing' }, primeMedia: video.primeMedia };
  vm.createContext(ctx);
  vm.runInContext(extract('function primeVideo()', '\nfunction mediaBlob(') + '\nprimeVideo();', ctx);
  assert.equal(calls, 1); assert.equal(music.muted, false); assert.equal(music.currentTime, 3);
  assert.match(player, /if \(isVideoSong\(m\)\) primeVideo\(\);[\s\S]*?await mediaBlob\(m\)/);
  assert.match(player, /if \(maps.some\(isVideoSong\)\) primeVideo\(\);[\s\S]*?await listAudioKeys\(\)/);
});
test('N2: audio learning seek/play keeps legacy cancellation and count index', () => {
  let canceled = 0;
  const ctx = { learning: true, videoSession: null, lay: { counts: [{ time: 1 }, { time: 2 }] },
    au: { currentTime: 1.5 }, clickState: { nextIdx: 0 }, accentState: {}, lastKey: 'old',
    engine: { cancelPending() { canceled++; } }, accentGain: null };
  vm.createContext(ctx);
  vm.runInContext(extract('function resync()', '\nfunction currentPhrase(') + '\nresync();', ctx);
  assert.equal(canceled, 1); assert.equal(ctx.clickState.nextIdx, 1);
  assert.match(player, /onClockChange: \(\) => \{ if \(!learning\) resync\(\); \}/);
});
test('N3: stored mp4/webm/mov are playable, restorable and included in continuous playback', async () => {
  for (const name of ['track.mp4', 'live.webm', 'track.mov']) {
    const m = { song: { name, size: 1 } }, blob = { type: 'video/mp4' };
    let opened = 0, queued = 0, reads = 0;
    const ctx = { isVideoFile: alignment.isVideoFile, sessionVideos: new Map(), songKey: s => s.name,
      localStorage: { getItem: k => k === 'last' ? name : null }, LAST_SONG: 'last',
      loadAudio: async () => { reads++; return blob; }, openSeq: 0,
      listSongMaps: () => [m], listAudioKeys: async () => [name],
      openStored: async () => { opened++; return { ok: true }; },
      playQueued: () => { queued++; }, ensureCtx() {}, primeVideo() {},
      au: { src: 'audio' }, queue: [], loopOn: false, toast() {}, baseName: x => x };
    vm.createContext(ctx);
    vm.runInContext(extract('function isVideoSong(', '\nfunction primeVideo(') +
      extract('function mediaBlob(', '\n\nlet map =') +
      '\nthis.kind = isVideoSong; this.get = mediaBlob;', ctx);
    assert.equal(ctx.kind(m), false);
    assert.equal(await ctx.get(m), blob);
    vm.runInContext(extract('async function restoreLastSong()', '\nwindow.addEventListener') +
      '\nthis.restore = restoreLastSong;', ctx);
    await ctx.restore(); assert.equal(opened, 1);
    vm.runInContext(extract('async function startQueue(', "\n$('btnPlayAll')") + '\nthis.queueAll = startQueue;', ctx);
    await ctx.queueAll([m]); assert.equal(ctx.queue.length, 1); assert.equal(queued, 1);
    assert.ok(reads >= 2);
  }
});
test('N4: music selection exposes matching progress', async t => {
  const e = await env(t);
  assert.ok(e.$('videoStatus').messages.includes('맞추는 중…'));
});
test('N5: three equal-rate UI rebuilds with 47ms error cause zero seeks', async t => {
  const e = await env(t);
  e.v._pos = 10; e.m._pos = 9.953;
  const before = e.m.seeks;
  for (let i = 0; i < 3; i++) e.session.transport.playbackRate = e.session.transport.playbackRate;
  assert.equal(e.m.seeks - before, 0);
});
test('N7: settling trim clears its warning and restores the base rate', async t => {
  const e = await env(t);
  Object.defineProperty(e.m, 'currentTime', { get() { return this._pos; }, set(x) { this._pos = x; this.seeks++; } });
  e.v._pos = 10; e.m._pos = 9.8;
  e.session.sync(true); await sleep(40);
  e.m._pos = 9.8; e.session.sync(true); await sleep(40);
  e.m._pos = 9.8; e.session.sync(true);
  assert.match(e.$('videoStatus').textContent, /음악이 영상을 못 따라와요/);
  assert.ok(e.m.playbackRate > 1);
  e.m._pos = 9.98; e.session.sync();
  assert.equal(e.m.playbackRate, 1);
  assert.doesNotMatch(e.$('videoStatus').textContent, /음악이 영상을 못 따라와요/);
});
function curve(seconds) {
  let n = 5;
  const rand = () => { n = (1664525 * n + 1013904223) >>> 0; return n / 4294967296; };
  const a = new Float32Array(seconds * 100);
  for (let t = .5; t < seconds - .5; t += .25 + rand() * .5) {
    const i = Math.round(t * 100);
    for (let j = 0; j < 6; j++) a[i + j] += (.3 + rand()) * Math.exp(-j / 1.5);
  }
  return a;
}
test('N4: 10min/4min alignment yields within 200ms and preserves the exact synchronous result', async () => {
  const music = curve(240);
  const v = Float32Array.from({ length: 60000 }, (_, i) => {
    const x = (i / 100 - 7.3) * .9 * 100, k = Math.floor(x), f = x - k;
    return k < 0 || k >= music.length ? 0 : music[k] * (1 - f) + (music[k + 1] || 0) * f;
  });
  const expected = alignment.estimateAlignment(v, music);
  let last = performance.now(), longest = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; ticks++; }, 0);
  let found;
  try {
    found = await (alignment.estimateAlignmentAsync || alignment.estimateAlignment)(v, music);
    longest = Math.max(longest, performance.now() - last);
  } finally { clearInterval(timer); }
  console.log('N4 longest block ms', longest.toFixed(1), 'timer ticks', ticks,
    'offset', found.offset, 'ratio', found.ratio, 'matched', found.matched);
  assert.deepEqual(found, expected);
  assert.equal(found.matched, true); assert.ok(Math.abs(found.offset - 7.3) < 1e-8);
  assert.ok(Math.abs(found.ratio - .9) < 1e-8);
  assert.ok(ticks > 0); assert.ok(longest <= 200);
});
test('N8: metadata error and 8-second timeout decode and mount audio without saving', async () => {
  const previous = globalThis.document, nativeTimeout = globalThis.setTimeout;
  for (const mode of ['error', 'timeout']) {
    let timeoutMs, el, notices = [], saved = 0;
    globalThis.document = { createElement() { return el = { src: '', videoWidth: 0,
      load() { if (this.src && mode === 'error') queueMicrotask(() => this.onerror?.()); },
      removeAttribute() { this.src = ''; } }; } };
    globalThis.setTimeout = (fn, ms, ...args) => { timeoutMs = ms; return nativeTimeout(fn, 0, ...args); };
    const file = Object.assign(new Blob(['v'], { type: 'video/mp4' }), { name: 'clip.mp4' });
    const ctx = { isVideoFile: alignment.isVideoFile, checkVideoSize: alignment.checkVideoSize,
      hasVideoTrack: video.hasVideoTrack, audioOnlyBlobs: new WeakSet(),
      decodeToModelRate: async () => ({ samples: new Float32Array(1), duration: 60 }),
      loadSongMap: () => ({ song: { name: file.name, size: 1, duration: 60 } }),
      refreshIfStale: async m => ({ m, refreshed: false, failed: false }),
      localStorage: { setItem() {} }, songKey: () => 'a', sessionVideos: new Map(),
      saveAudio: async () => { saved++; return true; }, toast: s => notices.push(s) };
    try {
      vm.createContext(ctx);
      vm.runInContext(extract('async function analyzeAndSave(', '\n// 재생 화면') + '\nthis.run = analyzeAndSave;', ctx);
      const result = await ctx.run(file, () => {});
      assert.equal(timeoutMs, 8000); assert.equal(el.src, '');
      assert.equal(saved, 0); assert.equal(ctx.audioOnlyBlobs.has(file), true);
      assert.equal(ctx.sessionVideos.size, 0);
      assert.ok(notices.includes('영상 화면을 못 읽어 소리만 열었어요'));
      let videos = 0;
      Object.assign(ctx, { clearTimeout() {}, countInTimer: null, queue: [], undoStack: [],
        objectUrl: null, videoSession: null, isVideoSong: () => false,
        createVideoSession() { videos++; }, au: {}, URL: { createObjectURL: () => 'blob:audio' },
        LAST_SONG: 'last', baseName: x => x, $: () => ({}), switchTab() {}, rebuild() {} });
      vm.runInContext(extract('function mountSong(', '\nasync function openFile(') + '\nthis.mount = mountSong;', ctx);
      ctx.mount(result.m, result.pcm, file);
      assert.equal(videos, 0); assert.equal(ctx.au.src, 'blob:audio');
    } finally { globalThis.document = previous; globalThis.setTimeout = nativeTimeout; }
  }
});
