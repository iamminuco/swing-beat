// 학습용 「온전한 창」 찾기: 카운트 1로 시작해 1·2·…·8이 끊기지 않고 len개
// 이어지는 구간. 구간 재시작(sectionOnes)이나 첫 소리 전 카운트 부족으로 깨진
// 에이트는 학습 자료로 쓰지 않는다 — 문제 자체가 틀린 채 출제되면 안 되므로.
export function fullWindows(counts, len = 16) {
  if (!Number.isInteger(len) || len < 8 || len % 8 !== 0) {
    throw new RangeError('Window length must be a positive multiple of 8');
  }
  const out = [];
  for (let i = 0; i + len <= counts.length; i++) {
    if (counts[i].count !== 1) continue;
    let ok = true;
    for (let k = 0; k < len; k++) {
      if (counts[i + k].count !== (k % 8) + 1) { ok = false; break; }
    }
    if (ok) out.push({ index: i, start: counts[i].time, end: counts[i + len - 1].end });
  }
  return out;
}

// rng는 [0,1) 난수. 결정론 테스트를 위해 주입한다.
export function pickWindow(windows, rng = Math.random) {
  if (!windows.length) throw new RangeError('No full window available');
  return windows[Math.min(windows.length - 1, Math.floor(rng() * windows.length))];
}
