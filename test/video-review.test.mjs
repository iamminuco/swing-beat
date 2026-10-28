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
// R08 replaces the obsolete contract that deliberately discarded video bytes.
function videoSaveEnv(save, extra = {}) {
  const m = { song: { name: 'clip.mp4', size: 4, duration: 60 }, corrections: { oneAnchorTime: 2 } };
  const ctx = {
    isVideoFile, checkVideoSize() {}, hasVideoTrack: async () => true,
    audioOnlyBlobs: new WeakSet(), sessionVideos: new Map(), videoSaves: new Map(),
    decodeToModelRate: async () => ({ samples: new Float32Array(1), duration: 60 }),
    loadSongMap: () => m, refreshIfStale: async m => ({ m }),
    localStorage: { setItem() {} }, songKey: s => s.name,
    saveAudio: save, toast: assert.fail, renderList() {}, ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(extract('async function analyzeAndSave(', '\n// 재생 화면') + '\nthis.run = analyzeAndSave;', ctx);
  return ctx;
}
const drainSaves = async ctx => { await Promise.all(ctx.videoSaves.values()); await Promise.resolve(); };

test('VS01: video saving starts in background and never delays opening', async () => {
  let saves = 0, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ctx = videoSaveEnv(() => { saves++; return pending; });
  const file = Object.assign(new Blob(['clip'], { type: 'video/mp4' }), { name: 'clip.mp4' });
  const result = await ctx.run(file, () => {});
  assert.equal(saves, 1, 'confirmed video must reach the existing byte store');
  assert.equal(ctx.sessionVideos.get('clip.mp4'), file);
  assert.equal(result.m.corrections.oneAnchorTime, 2);
  assert.equal(ctx.videoSaves.size, 1, 'opening must finish before storage finishes');
  finish(true); await drainSaves(ctx);
  assert.equal(ctx.videoSaves.size, 0);
});

test('VS02: quota failure is quiet and preserves the session video', async () => {
  const ctx = videoSaveEnv(async () => { throw new DOMException('full', 'QuotaExceededError'); });
  const file = { type: 'video/mp4', name: 'clip.mp4', size: 4 };
  const result = await ctx.run(file, () => {});
  await drainSaves(ctx);
  assert.equal(ctx.sessionVideos.get('clip.mp4'), file);
  assert.ok(!result.failed);
});

function videoDb(t) {
  const previous = globalThis.indexedDB, records = new Map();
  const state = { fail: false, lose: false };
  const request = value => {
    const req = {};
    queueMicrotask(() => { req.result = value(); req.onsuccess?.(); });
    return req;
  };
  const db = {
    transaction() {
      const tx = {};
      tx.objectStore = () => ({
        put(raw, key) {
          queueMicrotask(() => {
            if (state.fail) { tx.error = new DOMException('full', 'QuotaExceededError'); tx.onabort?.(); }
            else { if (!state.lose) records.set(key, structuredClone(raw)); tx.oncomplete?.(); }
          });
        },
        get: key => request(() => records.get(key)),
        getAllKeys: () => request(() => [...records.keys()]),
        delete(key) { queueMicrotask(() => { records.delete(key); tx.oncomplete?.(); }); },
      });
      return tx;
    },
  };
  globalThis.indexedDB = { open: () => request(() => db) };
  t.after(() => { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; });
  return { records, state };
}
function videoMemoryStorage() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i],
    getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}

test('VS03: v2 video bytes verify, reload, list and delete; quota and lost writes return false', async t => {
  const db = videoDb(t);
  const { saveAudio, loadAudio, listAudioKeys, deleteAudio } = await import('../storage/audiostore.js');
  const blob = Object.assign(new Blob(['movie bytes'], { type: 'video/mp4' }), { name: 'clip.mp4' });
  assert.equal(await saveAudio('v', blob), true);
  const raw = db.records.get('v');
  assert.ok(raw.buf instanceof ArrayBuffer); assert.equal(raw.type, 'video/mp4'); assert.equal(raw.name, 'clip.mp4');
  const back = await loadAudio('v');
  assert.equal(await back.text(), 'movie bytes'); assert.equal(back.type, blob.type);
  assert.deepEqual(await listAudioKeys(), ['v']);
  assert.equal(await deleteAudio('v'), true); assert.equal(await loadAudio('v'), null);
  db.state.fail = true; assert.equal(await saveAudio('quota', blob), false);
  db.state.fail = false; db.state.lose = true; assert.equal(await saveAudio('lost', blob), false);
});

test('VS04: reload restores LAST_SONG video, saved first count and corrections without a track probe', async t => {
  videoDb(t);
  const { saveAudio, loadAudio, listAudioKeys } = await import('../storage/audiostore.js');
  const { createSongMap, songKey } = await import('../core/songmap/schema.js');
  const { saveSongMap, loadSongMap, listSongMaps } = await import('../storage/songstore.js');
  const { withOneAt, withSectionOne, layout, effectiveGrid } = await import('../core/songmap/songmap.js');
  const storage = videoMemoryStorage(), file = Object.assign(new Blob(['clip'], { type: 'video/mp4' }), { name: 'clip.mp4' });
  let m = createSongMap({ name: file.name, size: file.size, duration: 60 }, {
    sr: 22050, duration: 60, firstOnset: 0, beats: Array.from({ length: 120 }, (_, i) => i / 2),
    downbeats: [0, 2, 4], barPhase: { offset: 0, confidence: 1 }, tempoFactor: 1, diagnostics: { warnings: [] },
  });
  m = withSectionOne(withOneAt(m, 2), 10);
  saveSongMap(m, storage);
  const key = songKey(m.song);
  const writer = videoSaveEnv(saveAudio, {
    songKey, localStorage: storage, loadSongMap: () => loadSongMap(m.song, storage),
  });
  await writer.run(file, () => {}); await drainSaves(writer);
  const nodes = {}, native = { pause() {}, removeAttribute() {}, load() {} };
  let probes = 0, videoMounts = 0;
  const ctx = {
    localStorage: storage, LAST_SONG: 'beatapp_last_song', songKey, isVideoFile, loadAudio, listAudioKeys,
    sessionVideos: new Map(), audioOnlyBlobs: new WeakSet(), openSeq: 0, videoSession: null,
    listSongMaps: () => listSongMaps(storage), loadSongMap: s => loadSongMap(s, storage),
    decodeToModelRate: async () => ({ samples: new Float32Array(1) }),
    refreshIfStale: async m => ({ m }), hasVideoTrack() { probes++; throw Error('must not probe restored bytes'); },
    clearTimeout() {}, countInTimer: null, queue: [], undoStack: [], objectUrl: null, au: native,
    URL: { createObjectURL: () => 'blob:video' }, ensureCtx() {}, bindPlayback() {},
    createVideoSession({ videoMap }) {
      videoMounts++; assert.deepEqual(videoMap.corrections, m.corrections);
      return { transport: {}, layout: x => x };
    },
    $: id => nodes[id] ||= {}, switchTab() {}, baseName: x => x, toast() {},
    layout, effectiveGrid,
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function isVideoSong(', '\nfunction primeVideo(') +
    extract('function mediaBlob(', '\n\nlet map =') +
    extract('function withPickupCounts(', '\nfunction rebuild(') +
    extract('function mountSong(', '\nasync function openFile(') +
    extract('async function openStored(', '\nwindow.addEventListener') +
    '\nthis.mount = mountSong; this.restore = restoreLastSong;' +
    '\nfunction rebuild() { this.firstCount = withPickupCounts(layout(map)).counts[0].count; }', ctx);
  ctx.mount(m, new Float32Array(1), file);
  assert.equal(storage.getItem('beatapp_last_song'), key, 'mount must remember a video');
  ctx.videoSession = null; ctx.au = native; ctx.sessionVideos.clear(); videoMounts = 0;
  await ctx.restore();
  assert.equal(videoMounts, 1); assert.equal(probes, 0); assert.equal(ctx.firstCount, 5);
  assert.equal(ctx.map.corrections.oneAnchorTime, 2);
  assert.deepEqual(ctx.map.corrections.sectionOnes, [10]);
});

test('VS05: persisted video is available in list and queue with an empty session cache', async () => {
  const m = { song: { name: 'clip.mp4', duration: 60 } }, blob = new Blob(['clip'], { type: 'video/mp4' });
  const nodes = {}, rows = [];
  const node = () => ({ hidden: false, classList: { toggle() {} }, querySelector: () => node(), appendChild: r => rows.push(r) });
  const ctx = {
    $: id => nodes[id] ||= node(), document: { createElement: node },
    listSongMaps: () => [m], listAudioKeys: async () => ['v'], songKey: () => 'v',
    isVideoSong: () => true, sessionVideos: new Map(), loadAudio: async () => blob,
    analyzing: new Set(), selected: new Set(), tempoBpm: () => 120, fmtTime: () => '1:00', baseName: x => x,
    paintListActions() {}, attachDelete: row => row, ensureCtx() {}, primeVideo() {},
    au: { src: 'old' }, openSeq: 0, queue: [], loopOn: false, playQueued() {}, toast: assert.fail,
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function mediaBlob(', '\n\nlet map =') +
    extract('async function renderList()', '\n// 곡 지우기:') +
    extract('async function startQueue(', "\n$('btnPlayAll')") +
    '\nthis.render = renderList; this.start = startQueue; this.get = mediaBlob;', ctx);
  await ctx.render(); assert.equal(rows[0].className, 'songRow');
  await ctx.start([m]); assert.equal(ctx.queue.length, 1); assert.equal(await ctx.get(m), blob);
});

test('VS06: delete waits for an unfinished video save, then removes the bytes', async () => {
  let finish, exists = false, deleted = false;
  const ctx = videoSaveEnv(() => new Promise(resolve => {
    finish = () => { exists = true; resolve(true); };
  }));
  await ctx.run({ name: 'clip.mp4', type: 'video/mp4', size: 4 }, () => {});
  const node = () => ({ classList: { toggle() {} }, style: {}, addEventListener() {}, append(...children) { this.children = children; } });
  Object.assign(ctx, {
    document: { createElement: node }, window: { addEventListener() {} }, DEL_W: 84,
    removeSongMap() {}, deleteAudio: async () => { exists = false; deleted = true; },
    localStorage: videoMemoryStorage(), LAST_SONG: 'last', selected: new Set(), baseName: x => x, toast() {},
  });
  vm.runInContext(extract('function attachDelete(', '\nfunction paintListActions(') + '\nthis.attach = attachDelete;', ctx);
  const wrap = ctx.attach(node(), { song: { name: 'clip.mp4' } }, 'clip.mp4');
  const removing = wrap.children[0].onclick({ stopPropagation() {} });
  assert.equal(deleted, false, 'delete cannot run before the in-flight write');
  finish(); await removing;
  assert.equal(deleted, true); assert.equal(exists, false); assert.equal(ctx.sessionVideos.size, 0);
});

test('VS07: delayed fallback lookup cannot replace a newer selection', async () => {
  let finish, mounted = 0;
  const ctx = { localStorage: { getItem: () => null }, LAST_SONG: 'last', openSeq: 0,
    listSongMaps: () => [{ song: { name: 'clip.mp4' } }], songKey: s => s.name,
    listAudioKeys: () => new Promise(resolve => { finish = resolve; }), isVideoSong: () => true,
    mediaBlob: async () => new Blob(['v']), loadAudio: async () => new Blob(['v']),
    openStored: async () => { mounted++; return { ok: true }; }, toast() {}, baseName: x => x };
  vm.createContext(ctx);
  vm.runInContext(extract('async function restoreLastSong()', '\nwindow.addEventListener') + '\nthis.run = restoreLastSong;', ctx);
  const pending = ctx.run(); ctx.openSeq++; finish(['clip.mp4']); await pending;
  assert.equal(mounted, 0);
});

class ReplayMedia extends EventTarget {
  constructor() { super(); Object.assign(this, { paused: true, muted: false, currentTime: 0, playbackRate: 1, duration: 60, readyState: 4, src: '' }); }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  load() {}
  removeAttribute() { this.src = ''; }
}
function replayEnv(t) {
  const previous = globalThis.document; globalThis.document = { hidden: false };
  t.after(() => { globalThis.document = previous; });
  const nodes = { video: new ReplayMedia(), replacementAudio: new ReplayMedia() }, $ = id => nodes[id] ||= new El();
  const ctx = { state: 'running', resumes: 0, sources: 0, destination: {},
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); },
    createGain: () => ({ gain: { value: 1, cancelScheduledValues() {} }, connect() {} }),
    createMediaElementSource() { this.sources++; return { connect: g => g }; } };
  const scope = { audioCtx: ctx, ctxGraphBound: true, dbg: null };
  vm.createContext(scope);
  vm.runInContext(extract('function ensureCtx()', '// iOS:') + '\nthis.ensure = ensureCtx;', scope);
  const make = () => {
    const s = createVideoSession({ $, blob: new Blob(['clip']), pcm: new Float32Array(1),
      videoMap: { song: { duration: 60 } }, ensureCtx: scope.ensure,
      analyzeMusic: async () => ({ pcm: new Float32Array(1), m: { song: { duration: 60 } } }),
      onChange() {}, onClockChange() {} });
    t.after(() => s.dispose()); return s;
  };
  return { $, ctx, make };
}
for (const state of ['suspended', 'interrupted']) test('VS08: graph-bound A -> B -> A resumes ' + state + ' context before playback', async t => {
  const e = replayEnv(t), a = e.make(), gain = a.ensureMediaGraph(e.ctx);
  await a.transport.play(); gain.gain.value = 0; a.dispose();
  const b = e.make(); await b.transport.play(); b.dispose();
  const again = e.make(); e.ctx.state = state; const before = e.ctx.resumes;
  await again.transport.play();
  assert.equal(e.$('video').paused, false);
  assert.equal(e.ctx.state, 'running', 'video moving with a non-running graph has no sound');
  assert.equal(e.ctx.resumes, before + 1); assert.equal(e.ctx.sources, 1);
  assert.equal(gain.gain.value, 1); assert.equal(e.$('video').muted, false);
});

test('VS09: disposal clears both mute flags and gain; ordinary replay creates no media graph', async t => {
  const e = replayEnv(t), a = e.make();
  await a.transport.play(); assert.equal(e.ctx.sources, 0);
  e.$('video').muted = true; e.$('replacementAudio').muted = true;
  a.dispose();
  assert.equal(e.$('video').muted, false); assert.equal(e.$('replacementAudio').muted, false);
  const again = e.make(); await again.transport.play();
  assert.equal(e.ctx.sources, 0); assert.equal(e.$('video').muted, false);
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

// 10/28 사용자 "백그라운드 갔다 오면 노래 안 나와": 굳은(interrupted) 소리엔진은 같은 엔진을 되살린다(새로 만들면 청음 등이
// 쥐고 있는 옛 시계로 예약이 어긋난다 — Sol 검토 P1). 숨을 때 멈추는 것은 영상이 있고 음악이 엔진에 안 묶였을 때만.
test('CTX01: interrupted context is resumed in place, never replaced', () => {
  const src = extract('function ensureCtx()', '// iOS:') + '\nthis.ensure = ensureCtx;';
  const stuck = { state: 'interrupted', resumes: 0, resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); } };
  const scope = { audioCtx: stuck, dbg: null, window: { AudioContext: class {} } };
  vm.createContext(scope); vm.runInContext(src, scope);
  assert.equal(scope.ensure(), stuck); assert.equal(stuck.resumes, 1); assert.equal(stuck.state, 'running');
});
test('CTX02: hiding suspends the engine only for a video with no bound media graph', () => {
  const body = player.slice(player.indexOf("document.addEventListener('visibilitychange'"), player.indexOf("document.addEventListener('pointerdown'"));
  for (const [videoSession, ctxGraphBound, expect] of [[{}, false, 1], [null, false, 0], [{}, true, 0]]) {
    let handler = null;
    const ctx = { state: 'running', suspends: 0, suspend() { this.suspends++; this.state = 'suspended'; return Promise.resolve(); } };
    const scope = { audioCtx: ctx, ctxGraphBound, dbg: null, countInTimer: null, learning: true, clearTimeout() {}, resync() {}, ensureCtx() {},
      engine: { cancelPending() {} }, document: { hidden: true, addEventListener: (_, fn) => { handler = fn; } },
      videoSession: videoSession && { transport: { pause() {} }, resetGain() {} } };
    vm.createContext(scope); vm.runInContext(body, scope); handler();
    assert.equal(ctx.suspends, expect, JSON.stringify({ video: !!videoSession, ctxGraphBound }));
  }
});
