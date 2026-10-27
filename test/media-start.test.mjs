import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as decoder from '../audio/decode.js';
import { songKey } from '../core/songmap/schema.js';
import { inspectSignal } from '../core/analysis/signal.js';

const start = async bytes => (await import('../audio/media-start.js')).audioStartSeconds(bytes);
function box(type, payload = Buffer.alloc(0), size = 32) {
  const header = Buffer.alloc(size === 64 ? 16 : 8);
  header.writeUInt32BE(size === 64 ? 1 : size === 0 ? 0 : header.length + payload.length);
  header.write(type, 4, 4, 'ascii');
  if (size === 64) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}
const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'binary'));
function edits(entries, version = 0, size = 32) {
  const width = version === 1 ? 20 : 12, data = Buffer.alloc(8 + entries.length * width);
  data[0] = version; data.writeUInt32BE(entries.length, 4);
  entries.forEach(([duration, time], i) => {
    const p = 8 + i * width;
    if (version === 1) { data.writeBigUInt64BE(BigInt(duration), p); data.writeBigInt64BE(BigInt(time), p + 8); }
    else { data.writeUInt32BE(duration, p); data.writeInt32BE(time, p + 4); }
    data.writeInt16BE(1, p + width - 4);
  });
  return box('elst', data, size);
}
function track(kind = 'soun', entries = [[300, -1], [1000, 1024]], version = 0, size = 32) {
  const h = Buffer.alloc(24); h.write(kind, 8);
  const edts = entries === null ? Buffer.alloc(0) : box('edts', edits(entries, version, size), size);
  return box('trak', Buffer.concat([edts, box('mdia', box('hdlr', h), size)]), size);
}
function movie(tracks = [track()], { scale = 1000, version = 0, size = 32, prefix = ftyp } = {}) {
  const h = Buffer.alloc(version === 1 ? 32 : 20);
  h[0] = version; h.writeUInt32BE(scale, version === 1 ? 20 : 12);
  return Buffer.concat([prefix, box('moov', Buffer.concat([box('mvhd', h), ...tracks]), size)]);
}
async function decode(bytes, source = new Float32Array(22050)) {
  const previous = globalThis.OfflineAudioContext, buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let reads = 0, passed;
  globalThis.OfflineAudioContext = class {
    async decodeAudioData(data) {
      passed = data;
      structuredClone(data, { transfer: [data] }); // Browser decoder may detach immediately.
      return { duration: source.length / decoder.MODEL_SR };
    }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { duration: source.length / decoder.MODEL_SR, getChannelData: () => source }; }
  };
  try {
    const out = await decoder.decodeToModelRate({ async arrayBuffer() { reads++; return buffer; } });
    assert.equal(reads, 1); assert.equal(passed, buffer); assert.equal(buffer.byteLength, 0);
    return out;
  } finally { globalThis.OfflineAudioContext = previous; }
}

test('MS01 decode prepends 6615 silent samples before detached-buffer decoding', async () => {
  const source = new Float32Array(22050); source[0] = 0.25; source[1] = -0.5;
  const bytes = movie(), out = await decode(bytes, source);
  assert.equal(out.samples.length, source.length + 6615, 'sound empty edit must add 0.3 seconds of PCM');
  assert.ok(out.samples.subarray(0, 6615).every(x => x === 0));
  assert.deepEqual(Buffer.from(out.samples.subarray(6615).buffer, 6615 * 4), Buffer.from(source.buffer));
  assert.equal(out.duration, 1.3); assert.equal(out.startOffset, 0.3); assert.equal(out.sr, 22050);
  assert.notEqual(songKey({ name: 'delayed.mp4', size: bytes.length, duration: out.duration }),
    songKey({ name: 'delayed.mp4', size: bytes.length, duration: 1 }));
});
test('MS02 v0: sum only leading sound empty edits; ignore AAC priming and later gaps', async () => {
  assert.equal(await start(movie([track('soun', [[100, -1], [200, -1], [1000, 1024], [500, -1]])])), 0.3);
  assert.equal(await start(movie([track('soun', [[1000, 1024]])])), 0);
});
test('MS03 no elst, no sound track, or video-only empty edits yield zero', async () => {
  assert.equal(await start(movie([track('soun', null)])), 0);
  assert.equal(await start(movie([])), 0);
  assert.equal(await start(movie([track('vide')])), 0);
  assert.equal(await start(movie([track('vide'), track('soun', [[1000, 0]])])), 0);
  assert.equal(await start(movie([track('vide', [[900, -1]]), track()])), 0.3);
});
test('MS04 v1 elst, v1 mvhd and 64-bit boxes including durations above uint32', async () => {
  assert.equal(await start(movie([track('soun', [[300, -1], [1000, 1024]], 1, 64)],
    { version: 1, size: 64 })), 0.3);
  assert.equal(await start(movie([track('soun', [[5000000000n, -1], [1000, 2n ** 54n]], 1, 64)],
    { scale: 100000000, version: 1, size: 64 })), 50);
});
test('MS05 no ftyp required; skip mdat payload, accept size zero and nonzero view offset', async () => {
  const data = movie([], { prefix: Buffer.alloc(0) }); // Only used as opaque mdat payload.
  for (const type of ['wide', 'free', 'mdat', 'skip']) {
    assert.equal(await start(movie([track()], { prefix: box(type, data) })), 0.3);
  }
  const bytes = movie([track()], { prefix: Buffer.alloc(0), size: 0 });
  assert.equal(await start(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), 0.3);
  const wrapped = Buffer.concat([Buffer.alloc(7, 255), bytes, Buffer.alloc(11, 255)]);
  assert.equal(await start(new Uint8Array(wrapped.buffer, wrapped.byteOffset + 7, bytes.length)), 0.3);
  assert.equal(await start(Buffer.concat([box('mdat', bytes, 0)])), 0);
});
test('MS06 truncated or malformed boxes and non-BMFF inputs return zero without throwing', async () => {
  const bytes = movie();
  for (let n = 0; n < bytes.length; n++) assert.equal(await start(bytes.subarray(0, n)), 0, 'prefix ' + n);
  for (const input of [null, undefined, {}, new ArrayBuffer(0),
    Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'binary'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])]) {
    assert.equal(await start(input), 0);
  }
  const badSize = Buffer.from(bytes); badSize.writeUInt32BE(4, ftyp.length);
  const hugeSize = Buffer.alloc(16); hugeSize.writeUInt32BE(1); hugeSize.write('free', 4);
  hugeSize.writeBigUInt64BE(2n ** 60n, 8);
  const badVersion = Buffer.from(bytes); badVersion[bytes.indexOf('elst') + 4] = 2;
  const badCount = Buffer.from(bytes); badCount.writeUInt32BE(100, bytes.indexOf('elst') + 8);
  const shortHdlr = Buffer.from(bytes); shortHdlr.writeUInt32BE(8, bytes.indexOf('hdlr') - 4);
  for (const input of [badSize, hugeSize, hugeSize.subarray(0, 12), badVersion, badCount, shortHdlr,
    movie([track()], { scale: 0 }), movie([track()], { version: 2 })]) assert.equal(await start(input), 0);
  let seed = 7;
  for (let i = 0; i < 100; i++) {
    const junk = Buffer.alloc(40);
    for (let j = 0; j < junk.length; j++) { seed = (1664525 * seed + 1013904223) >>> 0; junk[j] = seed >>> 24; }
    junk.write('ftyp', 4); assert.equal(await start(junk), 0);
  }
});
test('MS07 invalid negative media time, excessive or unsafe duration yield zero; 60 seconds is allowed', async () => {
  for (const version of [0, 1]) {
    assert.equal(await start(movie([track('soun', [[300, -2]], version)])), 0);
    assert.equal(await start(movie([track('soun', [[60001, -1]], version)])), 0);
    assert.equal(await start(movie([track('soun', [[60000, -1]], version)])), 60);
  }
  assert.equal(await start(movie([track('soun', [[2n ** 60n, -1]], 1)])), 0);
});
test('MS08 padStart preserves zero-offset bytes and copies unchanged PCM after rounded silence', () => {
  const bits = new Uint32Array([0x80000000, 0x3e800000, 0x7fc00001]);
  const source = new Float32Array(bits.buffer), before = Buffer.from(new Uint8Array(bits.buffer));
  for (const sec of [0, -0, -1, 61, NaN, Infinity]) assert.equal(decoder.padStart(source, 22050, sec), source);
  const padded = decoder.padStart(source, 22050, 0.30001), n = Math.round(22050 * 0.30001);
  assert.equal(padded.length, source.length + n);
  assert.ok(padded.subarray(0, n).every(x => x === 0));
  assert.deepEqual(Buffer.from(padded.buffer, n * 4), before);
  assert.deepEqual(Buffer.from(source.buffer), before);
});
test('MS09 zero-offset WAV, WebM and AAC/m4a keep decoded samples, duration and songKey exactly', async () => {
  const source = new Float32Array(22050); source[0] = -0; source[1] = 0.25;
  const before = Buffer.from(source.buffer).toString('hex');
  for (const [name, bytes] of [['zero.wav', Buffer.from('RIFF\0\0\0\0WAVE', 'binary')],
    ['zero.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    ['zero.m4a', movie([track('soun', [[1000, 1024]])])]]) {
    const out = await decode(bytes, source);
    assert.equal(out.samples, source); assert.equal(out.duration, 1); assert.equal(out.startOffset, 0);
    assert.equal(Buffer.from(out.samples.buffer).toString('hex'), before);
    assert.equal(songKey({ name, size: bytes.length, duration: out.duration }),
      name + '\0' + bytes.length + '\0' + '1.000');
  }
});
test('MS10 padded PCM moves the signal onset and waveform to the same presentation clock', async () => {
  const source = new Float32Array(22050); source.fill(0.5, 0, 64);
  const out = await decode(movie(), source), signal = inspectSignal(out.samples, out.sr, 13);
  assert.equal(signal.firstOnset, 0.3); assert.equal(signal.duration, out.duration);
  assert.ok(signal.waveform.slice(0, 3).every(b => b.min === 0 && b.max === 0));
  assert.equal(signal.waveform[3].max, 0.5);
});
const measurements = '/private/tmp/claude-501/-Users-minu/0f760238-4d52-41f8-a787-2e12d7dec348/scratchpad/synctest/';
for (const [name, expected] of [['phone.mp4', 0], ['delayed.mp4', 0.2768], ['delayed.mov', 0.2768], ['vdelayed.mp4', 0]]) {
  test('MS11 lead measurement ' + name, async t => {
    let bytes;
    try { bytes = readFileSync(measurements + name); }
    catch (err) { if (err.code === 'ENOENT' || err.code === 'EACCES') { t.skip('measurement unavailable: ' + err.code); return; } throw err; }
    const actual = await start(bytes);
    if (expected === 0) assert.equal(actual, 0);
    else assert.ok(Math.abs(actual - expected) <= 0.01, String(actual));
    t.diagnostic(name + ': ' + actual + ' seconds');
  });
}
