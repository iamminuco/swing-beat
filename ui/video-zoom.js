// 영상 확대(10/27 사용자 "동영상 인물 확대도 할 수 있게"): 두 손가락 벌리기·두 번 탭·끌어 옮기기.
// 페이지 확대는 막아 두었으므로(두 번 눌러 확대 방지) 영상 틀 안에서만 transform으로 키운다.
export const MIN_SCALE = 1, MAX_SCALE = 4, TAP_SCALE = 2.5;

// 상태 v = { s, x, y }: 틀 왼쪽 위 기준 translate(x,y) scale(s). 확대해도 틀 밖 빈칸이 보이지 않게 가둔다.
export function clampView(v, w, h) {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s));
  const x = Math.min(0, Math.max(w - w * s, v.x));
  const y = Math.min(0, Math.max(h - h * s, v.y));
  return { s, x, y };
}

// 틀 안의 점 (px,py)가 손가락 아래 그대로 있도록 배율만 바꾼다.
export function zoomAt(v, scale, px, py, w, h) {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const k = s / v.s;
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, w, h);
}

export function panBy(v, dx, dy, w, h) {
  return clampView({ s: v.s, x: v.x + dx, y: v.y + dy }, w, h);
}

export const IDENTITY = Object.freeze({ s: 1, x: 0, y: 0 });

// 브라우저 전용 연결. box = 영상 틀, el = 영상, resetBtn = 확대했을 때만 보이는 '원래 크기' 버튼.
export function attachVideoZoom(box, el, resetBtn) {
  let v = IDENTITY;
  const pts = new Map();
  let pinch = null, lastTap = 0, lastTapAt = null, moved = false;
  const size = () => ({ w: box.clientWidth || 1, h: box.clientHeight || 1 });
  const local = e => { const r = box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const apply = () => {
    el.style.transformOrigin = '0 0';
    el.style.transform = v.s === 1 ? '' : `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    if (resetBtn) resetBtn.hidden = v.s === 1;
  };
  const reset = () => { v = IDENTITY; pinch = null; pts.clear(); apply(); };
  const pair = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };

  box.addEventListener('pointerdown', e => {
    if (resetBtn && resetBtn.contains(e.target)) return; // 버튼 탭은 확대 동작이 아니다(붙잡으면 버튼이 안 눌림)
    box.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, local(e));
    moved = false;
    if (pts.size === 2) { const p = pair(); pinch = { ...p, v }; }
  });
  box.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = local(e);
    pts.set(e.pointerId, cur);
    const { w, h } = size();
    if (pts.size >= 2 && pinch) {
      const p = pair();
      // 처음 두 손가락 상태에서 배율을 다시 계산하고, 가운데점이 움직인 만큼 같이 옮긴다
      const z = zoomAt(pinch.v, pinch.v.s * p.d / pinch.d, pinch.mx, pinch.my, w, h);
      v = panBy(z, p.mx - pinch.mx, p.my - pinch.my, w, h);
      moved = true; apply();
    } else if (pts.size === 1 && v.s > 1) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) { v = panBy(v, dx, dy, w, h); apply(); }
      if (Math.hypot(dx, dy) > 3) moved = true;
    }
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return;
    const at = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0 && !moved && e.type === 'pointerup') {
      const now = e.timeStamp || Date.now();
      if (now - lastTap < 320 && lastTapAt && Math.hypot(at.x - lastTapAt.x, at.y - lastTapAt.y) < 40) {
        const { w, h } = size();
        v = v.s > 1 ? IDENTITY : zoomAt(v, TAP_SCALE, at.x, at.y, w, h);
        apply(); lastTap = 0; lastTapAt = null;
      } else { lastTap = now; lastTapAt = at; }
    }
  };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
  box.addEventListener('wheel', e => {   // 컴퓨터: 휠로 확대·축소
    e.preventDefault();
    const { w, h } = size(), p = local(e);
    v = zoomAt(v, v.s * Math.exp(-e.deltaY * 0.002), p.x, p.y, w, h); apply();
  }, { passive: false });
  if (resetBtn) resetBtn.onclick = e => { e.stopPropagation(); reset(); };
  el.addEventListener('loadstart', reset); // 새 영상을 열면 원래 크기로
  // 화면 크기(가로·세로 회전)가 바뀌면 틀 밖 빈칸이 생기지 않게 다시 가둔다
  globalThis.addEventListener?.('resize', () => { const { w, h } = size(); v = clampView(v, w, h); apply(); });
  apply();
  return { reset, view: () => v };
}
