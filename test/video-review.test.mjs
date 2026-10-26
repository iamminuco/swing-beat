import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { SpecMedia } from './specmedia.mjs';
import { createVideoSession, hasVideoTrack } from '../audio/video.js';
import { projectLayout, onsetCurve, estimateAlignment, isVideoFile } from '../core/video-sync.js';
import { decodeToModelRate } from '../audio/decode.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
class El extends EventTarget {
  constructor() { super(); this.hidden = false; this.value = ''; this.textContent = ''; }
  click() { this.clicked = true; }
}
async function env(t, latency = 30) {
  const previous = globalThis.document;
  globalThis.document = { hidden: false };
  const v = new SpecMedia('v', { duration: 60, seekLatency: .02 });
  const m = new SpecMedia('m', { duration: 8, seekLatency: latency / 1000 });
  const nodes = { video: v, replacementAudio: m }, $ = id => nodes[id] ||= new El();
  const session = createVideoSession({ $, blob: new Blob(['v']), pcm: new Float32Array(22050),
    videoMap: { song: { duration: 60 } }, ensureCtx: () => ({}), onChange() {}, onClockChange() {},
    analyzeMusic: async () => ({ pcm: new Float32Array(22050), m: { song: { duration: 8 } } }) });
  t.after(() => { session.dispose(); globalThis.document = previous; });
  session.transport.addEventListener('play', () => session.sync(true));
  await $('musicInput').onchange({ target: { files: [new Blob(['m'])], value: '' } });
  return { $, v, m, session };
}
test('R01 p1: intro starts music on entry; outro restart keeps video running', async t => {
  const e = await env(t);
  e.$('offsetLaterLarge').onclick();
  await e.session.transport.play();
  assert.equal(e.v.paused, false); assert.ok(e.m.playCalls >= 1); assert.equal(e.m.paused, true);
  await sleep(1150);
  assert.equal(e.v.paused, false); assert.ok(e.m.playCalls > 1); assert.equal(e.m.paused, false);
  e.session.transport.pause(); e.session.transport.currentTime = 20; await sleep(80);
  const calls = e.m.playCalls;
  await e.session.transport.play(); await sleep(100);
  assert.equal(e.v.paused, false); assert.equal(e.m.playCalls, calls + 1); assert.equal(e.m.paused, true);
});
test('R02: follower play rejection reports music trouble without rejecting or pausing video', async t => {
  const e = await env(t);
  e.m.play = () => Promise.reject(Object.assign(new Error('pending interrupted'), { name: 'AbortError' }));
  await e.session.transport.play(); await sleep(20);
  assert.equal(e.v.paused, false);
  assert.match(e.$('videoStatus').textContent, /음악이 영상을 못 따라와요/);
});
test('R03 p2: delayed seeks converge or notify, never reseek while seeking, trim <=3%', async t => {
  for (const ms of [10, 50, 75, 150]) {
    await t.test(String(ms), async t => {
      const e = await env(t, ms);
      e.session.transport.currentTime = 5; await sleep(100);
      let overlapping = 0;
      const descriptor = Object.getOwnPropertyDescriptor(SpecMedia.prototype, 'currentTime');
      Object.defineProperty(e.m, 'currentTime', { get() { return descriptor.get.call(this); },
        set(x) { if (this.seeking) overlapping++; descriptor.set.call(this, x); } });
      await e.session.transport.play();
      await sleep(400);
      e.m.currentTime = e.v.currentTime - .2;
      const before = e.m.seeks;
      await sleep(2400);
      const lag = Math.abs(e.v.currentTime - e.m.currentTime);
      const notice = /음악이 영상을 못 따라와요/.test(e.$('videoStatus').textContent);
      console.log('p2', ms, 'seeks', e.m.seeks - before, 'lagMs', Math.round(lag * 1000), 'notice', notice);
      assert.ok(lag <= .030 || notice);
      assert.equal(overlapping, 0); assert.ok(e.m.seeks - before <= 2);
      assert.ok(Math.abs(e.m.playbackRate - 1) <= .030000001);
      assert.equal(e.v.paused, false); assert.ok(e.m.playCalls > 0);
    });
  }
});
test('R04: force leaves <=30ms alone and does not seek an already seeking follower', async t => {
  const e = await env(t);
  e.v._pos = 2; e.m._pos = 1.98;
  const before = e.m.seeks;
  e.session.sync(true); e.session.sync(true);
  assert.equal(e.m.seeks, before);
  e.m.currentTime = 1; const seeking = e.m.seeks;
  e.session.sync(true); e.session.sync(true);
  assert.equal(e.m.seeks, seeking);
});
const player = readFileSync(new URL('../ui/player.js', import.meta.url), 'utf8');
const extract = (a, b) => player.slice(player.indexOf(a), player.indexOf(b, player.indexOf(a)));
test('R05: display resync does not seek music; only video clock protects learning cues', () => {
  let seeks = 0, canceled = 0;
  const ctx = { learning: false, videoSession: { resetGain() {}, sync() { seeks++; } },
    lay: { counts: [] }, au: { currentTime: 0 }, clickState: {}, accentState: {}, lastKey: null,
    engine: { cancelPending() { canceled++; } }, accentGain: null };
  vm.createContext(ctx);
  vm.runInContext(extract('function resync()', '\nfunction currentPhrase()') + '\nresync();', ctx);
  assert.equal(seeks, 0); assert.equal(canceled, 1);
  ctx.learning = true; vm.runInContext('resync()', ctx);
  assert.equal(canceled, 2);
  assert.match(player, /onClockChange: \(\) => \{ if \(!learning\) resync\(\); \}/);
});
test('R06: cropped totals reflect visible counts and complete phrases', () => {
  const base = { phraseLen: 4, counts: Array.from({ length: 96 }, (_, i) =>
    ({ time: i, end: i + 1, count: i % 8 + 1, eight: Math.floor(i / 8) + 1, phrase: Math.floor(i / 32) + 1 })),
    totals: { beats: 96, fullPhrases: 3 } };
  const result = projectLayout(base, { offset: -32, ratio: 1 }, 40);
  assert.equal(result.counts.length, 40);
  assert.equal(result.totals.beats, 40); assert.equal(result.totals.fullEights, 5);
  assert.equal(result.totals.fullPhrases, 1); assert.equal(result.totals.endingCounts, 8);
  assert.equal(base.totals.beats, 96);
});
test('R07: metadata without a video track falls back and cleans up its URL', async () => {
  const previous = globalThis.document; let el;
  globalThis.document = { createElement() { return el = {
    videoWidth: 0, src: '', load() { if (this.src) queueMicrotask(() => this.onloadedmetadata?.()); },
    removeAttribute() { this.src = ''; } }; } };
  try {
    assert.equal(await hasVideoTrack(new Blob(['audio mp4'])), false);
    assert.equal(el.src, '');
    assert.match(player, /candidate && !hasTrack\) audioOnlyBlobs\.add\(file\)/);
    assert.match(player, /!audioOnlyBlobs\.has\(blob\)/);
    const blob = { type: 'video/mp4' }, audioOnlyBlobs = new WeakSet([blob]); let videos = 0;
    const mount = { clearTimeout() {}, countInTimer: null, queue: [], map: null, samples: null,
      loadSongMap: () => null, undoStack: [], objectUrl: null,
      videoSession: null, audioOnlyBlobs, isVideoFile, isVideoSong: () => false,
      createVideoSession() { videos++; }, au: {}, URL: { createObjectURL: () => 'blob:audio' },
      localStorage: { setItem() {} }, LAST_SONG: 'last', songKey: () => 'a', baseName: x => x,
      $: () => ({}), switchTab() {}, rebuild() {} };
    vm.createContext(mount);
    vm.runInContext(extract('function mountSong(', '\nasync function openFile(') + '\nthis.run = mountSong;', mount);
    mount.run({ song: { name: 'audio.mp4' } }, new Float32Array(0), blob);
    assert.equal(videos, 0); assert.equal(mount.au.src, 'blob:audio');
  } finally { globalThis.document = previous; }
});
test('R08: video save skips audio bytes; restore returns before reading a video; list and queue prime before awaits', async () => {
  let saves = 0;
  const ctx = { isVideoFile, checkVideoSize() {}, hasVideoTrack: async () => true, audioOnlyBlobs: new WeakSet(),
    decodeToModelRate: async () => ({ samples: new Float32Array(0), duration: 60 }),
    loadSongMap: () => ({ song: { name: 'clip.mp4', size: 1, duration: 60 } }),
    refreshIfStale: async m => ({ m, refreshed: false, failed: false }),
    localStorage: { setItem() {} }, saveSongMap: m => m, saveAudio: async () => { saves++; return true; },
    songKey: () => 'v', sessionVideos: new Map(), toast() {} };
  vm.createContext(ctx);
  vm.runInContext(extract('async function analyzeAndSave(', '\n// 재생 화면') + '\nthis.run = analyzeAndSave;', ctx);
  const blob = { type: 'video/mp4', name: 'clip.mp4', size: 1 };
  await ctx.run(blob, () => {});
  assert.equal(saves, 0); assert.equal(ctx.sessionVideos.get('v'), blob);
  let reads = 0;
  const restore = { localStorage: { getItem: () => 'v' }, LAST_SONG: 'last',
    listSongMaps: () => [{ song: { mediaType: 'video/mp4' } }], songKey: () => 'v',
    isVideoSong: () => true, loadAudio: async () => { reads++; }, openSeq: 0 };
  vm.createContext(restore);
  vm.runInContext(extract('async function restoreLastSong()', '\nwindow.addEventListener') + '\nthis.run = restoreLastSong;', restore);
  await restore.run(); assert.equal(reads, 0);
  assert.match(player, /영상은 다시 넣어야 해요/);
  assert.match(player, /if \(isVideoSong\(m\)\) primeVideo\(\);[\s\S]*?await mediaBlob\(m\)/);
  assert.match(player, /if \(maps.some\(isVideoSong\)\) primeVideo\(\);[\s\S]*?await listAudioKeys\(\)/);
});
test('R09: decoder hands the original buffer directly to decodeAudioData', async () => {
  const previous = globalThis.OfflineAudioContext, buffer = new ArrayBuffer(8); let passed;
  globalThis.OfflineAudioContext = class {
    async decodeAudioData(x) { passed = x; return { duration: 1 }; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { duration: 1, getChannelData: () => new Float32Array(1) }; }
  };
  try { await decodeToModelRate({ arrayBuffer: async () => buffer }); assert.equal(passed, buffer); }
  finally { globalThis.OfflineAudioContext = previous; }
});
const SR = 4000;
function rng(seed) { let n = seed >>> 0; return () => { n = (1664525 * n + 1013904223) >>> 0; return n / 4294967296; }; }
function song(seed, bpm, seconds, melodyRate, melAmp) {
  const r = rng(seed), ev = [], beat = 60 / bpm;
  for (let i = 0; i * beat < seconds; i++) { const t = i * beat;
    ev.push({ t, amp: i % 2 === 0 ? 1 : .8, tau: i % 2 === 0 ? .06 : .08 }); ev.push({ t, amp: .3, tau: .02 }); ev.push({ t: t + beat * 2 / 3, amp: .25, tau: .02 });
    if (r() < .08) ev.push({ t: t + beat / 3, amp: .7, tau: .05 }); }
  for (let t = 0; t < seconds; t += -Math.log(1 - r()) / melodyRate) ev.push({ t, amp: .1 + melAmp * r(), tau: .15 });
  return ev;
}
function render(ev, total, offset = 0, ratio = 1, seed = 7) {
  const out = new Float32Array(Math.round(total * SR)), r = rng(seed);
  for (const e of ev) { const i0 = Math.round((offset + e.t / ratio) * SR); if (i0 < 0 || i0 >= out.length) continue;
    const len = Math.round(e.tau * 5 * SR / ratio);
    for (let j = 0; j < len && i0 + j < out.length; j++) out[i0 + j] += e.amp * Math.exp(-j / (e.tau * SR / ratio)) * (r() * 2 - 1); }
  return out;
}
function room(x, noise, reverb, seed = 99) {
  const r = rng(seed), y = new Float32Array(x.length); let acc = 0; const a = reverb ? Math.exp(-1 / (reverb * SR)) : 0;
  for (let i = 0; i < x.length; i++) { acc = x[i] + a * acc; y[i] = x[i] + (reverb ? acc * (1 - a) * 2 : 0) + noise * (r() * 2 - 1); }
  return y;
}

test('R10 p6: fixed beat-dominated sweep accepts 5 same songs and rejects 5 different songs', () => {
  let correct = 0, wrong = 0;
  for (let k = 0; k < 5; k++) {
    const offset = 3 + k * 1.37, ratio = [1, .95, .9, .85, .8][k];
    const A = song(300 + k, 120, 90, 2, .5), B = song(400 + k, 118 + k * 3, 90, 2, .5);
    const video = onsetCurve(room(render(A, 100, offset, ratio), .02, .12), SR);
    const same = estimateAlignment(video, onsetCurve(render(A, 90), SR));
    const other = estimateAlignment(video, onsetCurve(render(B, 90), SR));
    if (same.matched && Math.abs(same.offset - offset) <= .02 && Math.abs(same.ratio / ratio - 1) <= .01) correct++;
    if (other.matched) wrong++;
  }
  console.log('p6 same', correct, '/5 wrong', wrong, '/5');
  assert.equal(correct, 5); assert.equal(wrong, 0);
});
test('R11: a low-confidence alignment keeps a one-click recommendation and +/-1s controls', async t => {
  const previous = globalThis.document; globalThis.document = { hidden: false };
  const nodes = {}, $ = id => nodes[id] ||= new El();
  nodes.video = new SpecMedia('v', { duration: 40 });
  nodes.replacementAudio = new SpecMedia('m', { duration: 40 });
  const periodic = Float32Array.from({ length: 22050 * 40 }, (_, i) => i % 11025 < 100 ? Math.sin(i) : 0);
  const session = createVideoSession({ $, blob: new Blob(['v']), pcm: periodic,
    videoMap: { song: { duration: 40 } }, analyzeMusic: async () => ({ pcm: periodic, m: { song: { duration: 40 } } }),
    ensureCtx: () => ({}), onChange() {}, onClockChange() {} });
  t.after(() => { session.dispose(); globalThis.document = previous; });
  await $('musicInput').onchange({ target: { files: [new Blob(['m'])], value: '' } });
  assert.match($('videoStatus').textContent, /자동으로 못 맞췄어요/);
  assert.equal($('applyRecommendation').hidden, false);
  assert.match($('recommendedFit').textContent, /추천값/);
  $('offsetLaterLarge').onclick(); assert.equal($('syncOffset').textContent, '1.00초');
  $('applyRecommendation').onclick();
  assert.equal($('syncOffset').textContent, /음악 시작 (-?[\d.]+)초/.exec($('recommendedFit').textContent)[1] + '초');
});
test('R12: less than 30 seconds or half the shorter source cannot be auto matched', () => {
  const a = Float32Array.from({ length: 2900 }, (_, i) => Math.sin(i * .71) ** 2);
  assert.equal(estimateAlignment(a, a).matched, false);
  let n = 123;
  const music = Float32Array.from({ length: 10000 }, () => { n = (1664525 * n + 1013904223) >>> 0; return n / 4294967296; });
  const video = new Float32Array(10000); video.set(music.subarray(0, 3000), 7000);
  assert.equal(estimateAlignment(video, music).matched, false);
});
