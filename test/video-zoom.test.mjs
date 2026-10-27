import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, zoomAt, panBy, IDENTITY, MAX_SCALE } from '../ui/video-zoom.js';

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
