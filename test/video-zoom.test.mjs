import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, zoomAt, panBy, IDENTITY, MAX_SCALE, attachVideoZoom } from '../ui/video-zoom.js';

test('VZ1 손가락 아래 점이 확대 뒤에도 같은 자리', () => {
  const v = zoomAt(IDENTITY, 2, 100, 50, 400, 300);
  // 화면 점 (100,50)에 있던 영상 점 = (100,50) → 확대 뒤 x + 100*2 = 100
  assert.equal(v.x + 100 * v.s, 100); assert.equal(v.y + 50 * v.s, 50);
});
test('VZ2 배율 1~4로 가두고, 1배면 이동 없음', () => {
  assert.equal(zoomAt(IDENTITY, 9, 0, 0, 400, 300).s, MAX_SCALE);
  assert.deepEqual(zoomAt(IDENTITY, 0.3, 200, 150, 400, 300), { s: 1, x: 0, y: 0 });
  assert.deepEqual(panBy(IDENTITY, 50, 50, 400, 300), { s: 1, x: 0, y: 0 });
});
test('VZ3 확대 상태에서 끌어도 틀 밖 빈칸이 안 보임', () => {
  const v = zoomAt(IDENTITY, 2, 200, 150, 400, 300);
  assert.deepEqual(panBy(v, 1000, 1000, 400, 300), { s: 2, x: 0, y: 0 });
  assert.deepEqual(panBy(v, -1000, -1000, 400, 300), { s: 2, x: -400, y: -300 });
  assert.deepEqual(clampView({ s: 2, x: -100, y: -100 }, 400, 300), { s: 2, x: -100, y: -100 });
});

class Element {
  constructor(w = 400, h = 300) {
    this.clientWidth = w; this.clientHeight = h; this.style = {};
    this.videoWidth = w; this.videoHeight = h; this.handlers = new Map();
    this.hidden = false;
  }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  setPointerCapture() {}
  contains(el) { return el === this; }
  fire(type, values = {}) {
    const e = { type, pointerId: 1, clientX: 200, clientY: 150,
      target: this, timeStamp: 1000, preventDefault() {}, stopPropagation() {}, ...values };
    for (const fn of this.handlers.get(type) || []) fn(e);
  }
}
function rig(portrait = false) {
  const box = new Element(), el = new Element(), button = new Element();
  if (portrait) { el.videoWidth = 900; el.videoHeight = 1600; }
  return { box, el, button, zoom: attachVideoZoom(box, el, button) };
}
const pointer = (r, type, x, y = 150, time = 1000, id = 1) =>
  r.box.fire(type, { pointerId: id, clientX: x, clientY: y, timeStamp: time, target: r.el });
const tap = (r, x, time) => { pointer(r, 'pointerdown', x, 150, time - 20); pointer(r, 'pointerup', x, 150, time); };
const wheel = (r, scale, x = 200) => r.box.fire('wheel', { deltaY: -Math.log(scale) / .002, clientX: x });
const cases = [
  ['contain portrait: pan cannot reveal avoidable black bars', () => {
    const r = rig(true); wheel(r, 2.5);
    pointer(r, 'pointerdown', 200); pointer(r, 'pointermove', 400);
    const v = r.zoom.view(), cw = 300 * 900 / 1600, ox = (400 - cw) / 2;
    const left = v.x + ox * v.s, right = v.x + (ox + cw) * v.s;
    assert.ok(left <= 1e-8 && right >= 400 - 1e-8,
      JSON.stringify({ view: v, drawnLeft: left, drawnRight: right }));
  }],
  ['pinch: translate and scale must clamp together', () => {
    const r = rig(); wheel(r, 2, 100);
    pointer(r, 'pointerdown', 250, 150, 1000, 1);
    pointer(r, 'pointerdown', 350, 150, 1000, 2);
    pointer(r, 'pointermove', 170, 150, 1010, 1);
    pointer(r, 'pointermove', 230, 150, 1020, 2);
    assert.ok(Math.abs(r.zoom.view().x + 40) < 1e-8, 'expected x=-40, actual=' + r.zoom.view().x);
  }],
  ['tap: swipe at scale 1 must not become first double tap', () => {
    const r = rig();
    pointer(r, 'pointerdown', 100, 150, 900); pointer(r, 'pointermove', 200, 150, 950);
    pointer(r, 'pointerup', 200, 150, 1000); tap(r, 200, 1200);
    assert.equal(r.zoom.view().s, 1);
  }],
  ['tap: accumulated slow pan must not reset zoom', () => {
    const r = rig(); wheel(r, 2.5); tap(r, 200, 1000);
    pointer(r, 'pointerdown', 200, 150, 1050);
    for (let x = 202; x <= 220; x += 2) pointer(r, 'pointermove', x, 150, 1050 + x - 200);
    pointer(r, 'pointerup', 220, 150, 1150);
    assert.equal(r.zoom.view().s, 2.5);
  }],
  ['tap: two-finger gesture without move is not a tap', () => {
    const r = rig();
    pointer(r, 'pointerdown', 180, 150, 900, 1);
    pointer(r, 'pointerdown', 200, 150, 910, 2);
    pointer(r, 'pointerup', 180, 150, 990, 1);
    pointer(r, 'pointerup', 200, 150, 1000, 2);
    tap(r, 200, 1200);
    assert.equal(r.zoom.view().s, 1);
  }],
  ['loadstart: previous video tap must not zoom new video', () => {
    const r = rig(); tap(r, 200, 1000); r.el.fire('loadstart'); tap(r, 200, 1200);
    assert.equal(r.zoom.view().s, 1);
  }],
  ['controls: reset button pointer events do not zoom', () => {
    const r = rig(); wheel(r, 2.5);
    r.box.fire('pointerdown', { target: r.button });
    r.box.fire('pointerup', { target: r.button });
    r.button.onclick({ stopPropagation() {} });
    assert.deepEqual(r.zoom.view(), IDENTITY);
  }],
  ['loadstart: view, pointers and transform reset', () => {
    const r = rig(); wheel(r, 2.5); pointer(r, 'pointerdown', 200); r.el.fire('loadstart');
    pointer(r, 'pointermove', 300);
    assert.deepEqual(r.zoom.view(), IDENTITY);
    assert.equal(r.el.style.transform, '');
    assert.equal(r.button.hidden, true);
  }]
];
for (const [name, run] of cases) test('VZ ' + name, run);
