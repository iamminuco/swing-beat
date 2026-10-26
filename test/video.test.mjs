import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { VIDEO_LIMIT, isVideoFile, checkVideoSize, onsetCurve, estimateAlignment,
  videoToMusic, musicToVideo, needsResync, musicPosition, projectLayout } from '../core/video-sync.js';
import { createVideoSession } from '../audio/video.js';
import { createSongMap } from '../core/songmap/schema.js';

const hz = 100;
function pulses(seed, duration = 55) {
  let n = seed;
  const rand = () => { n = (1664525 * n + 1013904223) >>> 0; return n / 4294967296; };
  const a = new Float32Array(duration * hz);
  for (let t = .5; t < duration - .5; t += .2 + rand() * .7) {
    const at = Math.round(t * hz), amp = .2 + rand();
    for (let j = 0; j < 7 && at + j < a.length; j++) a[at + j] += amp * Math.exp(-j / 1.5);
  }
  return a;
}
function at(a, x) {
  const i = Math.floor(x), f = x - i;
  return i < 0 || i >= a.length ? 0 : a[i] * (1 - f) + (a[i + 1] || 0) * f;
}
function warp(music, fit, seconds = 65) {
  return Float32Array.from({ length: seconds * hz }, (_, i) => at(music, (i / hz - fit.offset) * fit.ratio * hz));
}
test('V01: 2.37 second offset and 0.85 ratio within 20ms and 1%', () => {
  const music = pulses(41), expected = { offset: 2.37, ratio: .85 };
  const result = estimateAlignment(warp(music, expected), music, hz);
  assert.equal(result.matched, true);
  assert.ok(Math.abs(result.offset - expected.offset) <= .020, JSON.stringify(result));
  assert.ok(Math.abs(result.ratio / expected.ratio - 1) <= .01);
});
test('V02: negative offset and cropped video retain the correct alignment', () => {
  const music = pulses(21), expected = { offset: -3.14, ratio: .923 };
  const result = estimateAlignment(warp(music, expected, 42), music, hz);
  assert.equal(result.matched, true, JSON.stringify(result));
  assert.ok(Math.abs(result.offset - expected.offset) <= .020, JSON.stringify(result));
  assert.ok(Math.abs(result.ratio / expected.ratio - 1) <= .01);
});
test('V03: unrelated signals, silence and periodic ambiguity are not auto matched', () => {
  const music = pulses(41), video = warp(music, { offset: 2.37, ratio: .85 });
  const unrelated = estimateAlignment(video, pulses(83), hz);
  assert.equal(unrelated.matched, false);
  assert.ok(unrelated.confidence < .3);
  assert.equal(estimateAlignment(new Float32Array(2000), new Float32Array(2000)).matched, false);
  const periodic = Float32Array.from({ length: 4000 }, (_, i) => i % 50 < 3 ? 1 : 0);
  assert.equal(estimateAlignment(periodic, periodic).matched, false);
});
test('V04: PCM onset extraction also recovers the known time warp', () => {
  const sr = 1000, curve = pulses(67, 35);
  const music = Float32Array.from({ length: sr * 35 }, (_, i) => at(curve, i / sr * hz) * Math.sin(i * .9));
  const fit = { offset: 2.37, ratio: .85 };
  const video = Float32Array.from({ length: sr * 44 }, (_, i) => at(music, (i / sr - fit.offset) * fit.ratio * sr));
  const result = estimateAlignment(onsetCurve(video, sr), onsetCurve(music, sr));
  assert.equal(result.matched, true, JSON.stringify(result));
  assert.ok(Math.abs(result.offset - fit.offset) <= .020, JSON.stringify(result));
  assert.ok(Math.abs(result.ratio / fit.ratio - 1) <= .01);
});
test('V05: round trip <= 1ms, 80ms boundary, shorter music and both ends', () => {
  for (const offset of [-8, 0, 2.37]) for (const ratio of [.8, .85, 1]) {
    const fit = { offset, ratio };
    for (const t of [0, .001, 5, 600]) assert.ok(Math.abs(musicToVideo(videoToMusic(t, fit), fit) - t) <= .001);
    assert.equal(needsResync(10, videoToMusic(10.08, fit), fit), false);
    assert.equal(needsResync(10, videoToMusic(10.08001, fit), fit), true);
    assert.equal(needsResync(10, videoToMusic(9.91999, fit), fit), true);
  }
  assert.deepEqual(musicPosition(0, 3, { offset: 2, ratio: 1 }), { time: 0, active: false });
  assert.deepEqual(musicPosition(2, 3, { offset: 2, ratio: 1 }), { time: 0, active: true });
  assert.deepEqual(musicPosition(5, 3, { offset: 2, ratio: 1 }), { time: 3, active: false });
  assert.deepEqual(musicPosition(8, 3, { offset: 2, ratio: 1 }), { time: 3, active: false });
  assert.throws(() => videoToMusic(1, { offset: 0, ratio: 0 }), RangeError);
});
test('V06: projected counts preserve their numbers and end at the video edge', () => {
  const base = { counts: [0, 1, 2, 3].map((time, i) => ({ time, end: time + 1, count: i + 1, eight: 1, phrase: 1 })), totals: {} };
  const before = JSON.stringify(base);
  const result = projectLayout(base, { offset: -1, ratio: .8 }, 2.6);
  assert.deepEqual(result.counts.map(c => c.count), [2, 3]);
  assert.ok(result.counts.every(c => c.time >= 0 && c.end <= 2.6));
  assert.equal(JSON.stringify(base), before);
});
test('V07: MIME is authoritative; only empty/binary MIME uses video suffixes', () => {
  for (const name of ['a.mp4', 'a.mov', 'a.webm']) {
    assert.equal(isVideoFile({ name, type: 'audio/mp4' }), false);
    assert.equal(isVideoFile({ name, type: '' }), true);
  }
  assert.equal(isVideoFile({ name: 'a.wav', type: '' }), false);
  assert.equal(isVideoFile({ name: 'a.mp4', type: 'text/plain' }), false);
  assert.equal(isVideoFile({ name: 'a.MOV', type: 'application/octet-stream' }), true);
  assert.equal(isVideoFile({ name: 'a', type: 'video/mp4' }), true);
  assert.doesNotThrow(() => checkVideoSize({ size: VIDEO_LIMIT }));
  assert.throws(() => checkVideoSize({ size: VIDEO_LIMIT + 1 }), /300MB/);
});

class Element extends EventTarget {
  constructor() {
    super(); this.currentTime = 0; this.playbackRate = 1; this.duration = 12;
    this.readyState = 4; this.pending = []; this.paused = true; this.seeking = false; this.ended = false;
    this.hidden = false; this.value = ''; this.src = ''; this.muted = false; this.playCalls = 0;
  }
  play() {
    this.paused = false; this.playCalls++;
    return new Promise((resolve, reject) => {
      if (this.readyState <= 2) this.pending.push({ resolve, reject });
      else { this.dispatchEvent(new Event('playing')); resolve(); }
    });
  }
  pause() {
    const was = this.paused; this.paused = true;
    for (const p of this.pending.splice(0)) p.reject(Object.assign(new Error('paused'), { name: 'AbortError' }));
    if (!was) this.dispatchEvent(new Event('pause'));
  }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  click() { this.clicked = true; }
}
function musicResult(name = 'music.wav') {
  const song = { name, size: 10, duration: 8 };
  return { pcm: new Float32Array(22050 * 8), m: createSongMap(song, {
    sr: 22050, duration: 8, firstOnset: .5,
    beats: Array.from({ length: 14 }, (_, i) => .5 + i * .5), downbeats: [.5, 2.5, 4.5, 6.5],
    barPhase: { offset: 0, confidence: .8 }, tempoFactor: 1, diagnostics: { warnings: [] },
  }) };
}
function setup(t, analyzeMusic = async () => musicResult()) {
  const nodes = {}, $ = id => nodes[id] ||= new Element();
  const previousDocument = globalThis.document, previousRevoke = URL.revokeObjectURL;
  globalThis.document = { hidden: false };
  const revoked = []; URL.revokeObjectURL = url => { revoked.push(url); previousRevoke.call(URL, url); };
  let changes = 0, clocks = 0, createdGraphs = 0;
  const ctx = { destination: {}, createGain: () => ({ gain: { value: 1, cancelScheduledValues() {} }, connect() {} }),
    createMediaElementSource: () => { createdGraphs++; return { connect: gain => gain }; } };
  const session = createVideoSession({
    $, blob: new Blob(['video'], { type: 'video/mp4' }), pcm: new Float32Array(22050 * 12),
    videoMap: { song: { duration: 12 } }, analyzeMusic,
    onChange: () => changes++, onClockChange: () => clocks++, ensureCtx: () => ctx,
  });
  t.after(() => { session.dispose(); URL.revokeObjectURL = previousRevoke; globalThis.document = previousDocument; });
  return { $, session, revoked, ctx, changes: () => changes, clocks: () => clocks, graphs: () => createdGraphs };
}
async function choose(env, name = 'music.wav') {
  return env.$('musicInput').onchange({ target: { files: [Object.assign(new Blob(['music'], { type: 'audio/wav' }), { name })], value: name } });
}
test('V08: reachable chooser, failed matching still plays, both sound choices and default map', async t => {
  const e = setup(t);
  e.$('videoSound').value = 'music'; e.$('videoSound').onchange();
  assert.equal(e.$('musicInput').clicked, true);
  await choose(e);
  assert.match(e.$('videoStatus').textContent, /자동으로 못 맞췄어요/);
  assert.equal(e.session.usesMusicMap, true);
  assert.equal(e.$('videoBasis').value, 'music');
  await e.session.transport.play();
  assert.equal(e.$('video').paused, false);
  assert.equal(e.$('replacementAudio').paused, false);
  assert.equal(e.$('video').muted, true);
  e.$('videoSound').value = 'video'; e.$('videoSound').onchange();
  assert.equal(e.$('video').muted, false);
  assert.equal(e.$('replacementAudio').paused, true);
  e.$('videoBasis').value = 'video'; e.$('videoBasis').onchange();
  assert.equal(e.session.usesMusicMap, false);
});
test('V09: pause, seek, rate, pitch, buffering and 80ms drift follow the video', async t => {
  const e = setup(t); await choose(e);
  const v = e.$('video'), m = e.$('replacementAudio');
  await e.session.transport.play();
  v.currentTime = 2; m.currentTime = 1.92; e.session.sync();
  assert.equal(m.currentTime, 1.92);
  m.currentTime = 1.9199; e.session.sync(); assert.equal(m.currentTime, 2);
  e.session.transport.currentTime = 4; assert.equal(m.currentTime, 4);
  e.$('syncRatio').value = '.85'; e.$('syncRatio').onchange({ target: e.$('syncRatio') });
  e.session.transport.playbackRate = .75;
  assert.ok(Math.abs(m.playbackRate - .6375) < 1e-9);
  e.session.transport.preservesPitch = false; assert.equal(m.preservesPitch, false);
  v.seeking = true; v.dispatchEvent(new Event('seeking')); assert.equal(m.paused, true);
  v.seeking = false; v.dispatchEvent(new Event('seeked')); assert.equal(m.paused, false);
  v.dispatchEvent(new Event('waiting')); assert.equal(m.paused, true); assert.equal(e.session.transport.seeking, true);
  v.dispatchEvent(new Event('playing')); assert.equal(m.paused, false);
  e.session.transport.pause(); assert.equal(v.paused, true); assert.equal(m.paused, true);
  assert.ok(e.clocks() > 0);
});
test('V10: +/-0.1 seconds, negative offsets, preroll and shorter music keep video running', async t => {
  const e = setup(t); await choose(e);
  e.$('offsetEarlier').onclick();
  e.session.transport.currentTime = 0; assert.ok(Math.abs(e.$('replacementAudio').currentTime - .1) < 1e-9);
  e.$('offsetLater').onclick(); e.$('offsetLater').onclick();
  await e.session.transport.play();
  assert.equal(e.$('replacementAudio').paused, true);
  assert.equal(e.$('video').paused, false);
  e.session.transport.currentTime = .2;
  assert.equal(e.$('replacementAudio').paused, false);
  e.session.transport.currentTime = 10;
  assert.equal(e.$('replacementAudio').paused, true);
  assert.equal(e.$('video').paused, false);
  assert.equal(e.$('musicRange').hidden, false);
  e.session.transport.currentTime = 2;
  assert.equal(e.$('replacementAudio').paused, false);
  e.$('video').ended = true; e.$('video').dispatchEvent(new Event('ended'));
  assert.equal(e.$('replacementAudio').paused, true);
});
test('V11: music decoder failure preserves the current source and reports it', async t => {
  let calls = 0;
  const e = setup(t, async () => { if (++calls === 2) throw new Error('unsupported codec'); return musicResult(); });
  await choose(e); const src = e.$('replacementAudio').src;
  await choose(e, 'broken.wav');
  assert.equal(e.$('replacementAudio').src, src);
  assert.match(e.$('videoStatus').textContent, /음악 분석 실패.*unsupported codec/);
  await e.session.transport.play(); assert.equal(e.$('video').paused, false);
});
test('V12: a late music request cannot overwrite a newer file or a disposed session', async t => {
  let firstResolve, lateProgress, n = 0;
  const e = setup(t, (file, progress) => {
    if (++n === 1) { lateProgress = progress; return new Promise(resolve => { firstResolve = resolve; }); }
    return Promise.resolve(musicResult('latest.wav'));
  });
  const first = choose(e, 'first.wav'); await choose(e, 'latest.wav');
  const text = e.$('videoStatus').textContent;
  lateProgress('stale'); assert.equal(e.$('videoStatus').textContent, text);
  firstResolve(musicResult('first.wav')); await first;
  assert.equal(e.session.basisMap.song.name, 'latest.wav');
  e.session.dispose();
  lateProgress('disposed'); assert.equal(e.$('videoStatus').textContent, text);
  assert.equal(e.$('video').src, ''); assert.equal(e.$('replacementAudio').src, '');
  assert.equal(e.$('videoPanel').hidden, true);
  assert.ok(e.revoked.length >= 2);
});
test('V13: media graphs are reused and file URLs are released', async t => {
  const e = setup(t);
  const vg = e.session.ensureMediaGraph(e.ctx);
  assert.equal(e.session.ensureMediaGraph(e.ctx), vg);
  await choose(e);
  const mg = e.session.ensureMediaGraph(e.ctx);
  assert.notEqual(mg, vg); assert.equal(e.graphs(), 2);
  await choose(e, 'second.wav'); assert.equal(e.graphs(), 2);
  assert.equal(e.revoked.length, 1);
  e.session.dispose();
  assert.equal(e.revoked.length, 3);
});
test('V14: media failures are visible and hidden pages do not restart the follower', async t => {
  const e = setup(t); await choose(e); await e.session.transport.play();
  document.hidden = true; e.$('replacementAudio').pause(); e.session.sync();
  assert.equal(e.$('replacementAudio').paused, true);
  e.$('video').dispatchEvent(new Event('error'));
  assert.match(e.$('videoStatus').textContent, /동영상을 재생하지 못했어요/);
});

const playerSource = readFileSync(new URL('../ui/player.js', import.meta.url), 'utf8');
function extract(start, end) { return playerSource.slice(playerSource.indexOf(start), playerSource.indexOf(end)); }
test('V15: audio mount emits the legacy byte-for-byte trace, with no video session', () => {
  const trace = [], nodes = {};
  const audio = { set src(x) { trace.push(['src', x]); } };
  const context = {
    clearTimeout: n => trace.push(['clearTimeout', n]), countInTimer: 9, queue: [], map: null, samples: null,
    loadSongMap: song => { trace.push(['load', song.name]); return null; }, undoStack: [1], objectUrl: 'blob:old',
    URL: { revokeObjectURL: x => trace.push(['revoke', x]), createObjectURL: () => { trace.push(['create']); return 'blob:new'; } },
    au: audio, videoSession: null, isVideoFile, createVideoSession: () => assert.fail('video path executed'),
    localStorage: { setItem: (k, v) => trace.push(['store', k, v]) }, LAST_SONG: 'last', songKey: () => 'key',
    baseName: s => s.replace(/\.[^.]+$/, ''), switchTab: tab => trace.push(['tab', tab]), rebuild: () => trace.push(['rebuild']),
    $: id => nodes[id] ||= { set textContent(x) { trace.push([id, 'text', x]); }, set hidden(x) { trace.push([id, 'hidden', x]); } },
  };
  vm.createContext(context);
  vm.runInContext(extract('function mountSong(', '\nasync function openFile(') +
    '\nmountSong({song:{name:"audio.mp4"}},new Float32Array([1]),{type:"audio/mp4"});', context);
  assert.equal(JSON.stringify(trace), '[["clearTimeout",9],["load","audio.mp4"],["revoke","blob:old"],["create"],["src","blob:new"],["store","last","key"],["songTitle","text","audio"],["dropZone","hidden",true],["topBar","hidden",false],["tabBar","hidden",false],["tab","play"],["rebuild"]]');
});
test('V16: oversized video stops before decode; the same audio input still reaches the legacy decoder', async () => {
  let decodes = 0;
  const context = { isVideoFile, checkVideoSize, decodeToModelRate: async () => { decodes++; throw new Error('legacy decoder reached'); } };
  vm.createContext(context);
  vm.runInContext(extract('async function analyzeAndSave(', '\n// 재생 화면') + '\nthis.run = analyzeAndSave;', context);
  await assert.rejects(context.run({ type: 'video/mp4', size: VIDEO_LIMIT + 1 }), /300MB/);
  assert.equal(decodes, 0);
  await assert.rejects(context.run({ type: 'audio/mp4', name: 'audio.mp4', size: VIDEO_LIMIT + 1 }), /legacy decoder reached/);
  assert.equal(decodes, 1);
});
test('V17: video play starts within the tap and visibility cancels pending count-in', () => {
  assert.match(playerSource, /if \(videoSession\) \{ startPlayback\(\); return; \}/);
  assert.match(playerSource, /if \(document.hidden\) \{[\s\S]*?if \(videoSession\) \{[\s\S]*?clearTimeout\(countInTimer\); countInTimer = null;[\s\S]*?videoSession.transport.pause\(\);/);
});

test('V18: a rejected old play promise cannot pause a new playback', async t => {
  const e = setup(t); await choose(e);
  const m = e.$('replacementAudio'), nativePlay = m.play.bind(m);
  let rejectOld;
  const pending = new Promise((resolve, reject) => { rejectOld = reject; });
  m.play = () => { m.paused = false; return pending; };
  const oldStart = e.session.transport.play();
  e.session.transport.pause();
  m.play = nativePlay;
  await e.session.transport.play();
  const before = e.$('videoStatus').textContent;
  rejectOld(new Error('aborted old play'));
  await oldStart;
  await Promise.resolve();
  assert.equal(e.$('video').paused, false);
  assert.equal(e.$('videoStatus').textContent, before);
});
