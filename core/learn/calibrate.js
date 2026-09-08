// 두드려 재기 — 기기 지연(화면 값)을 사람이 직접 잰다. template.html의 검증된
// 계산을 그대로 옮겼다: 박 안에서의 위치(0~1)를 원형 평균으로 접는다. 지연이
// 거의 없을 땐 두드린 값이 0 근처와 1 근처로 갈라지는데, 산술 평균은 그걸
// 0.5로 뭉갠다. 반 속도로 재는 이유(호출자 책임): 박 간격이 두 배로 벌어져
// 0.4초까지의 지연을 다음 박과 헷갈리지 않는다.
export const TAPS_NEEDED = 8;
export const LAG_MAX_MS = 300;
export const STEADY_MIN = 0.8;

// taps: [{p: 박 안 위치 0~1, beat: 그 박 길이(초), rate: 재생 속도}]
// → {steady, ms} · steady < STEADY_MIN이면 ms는 null(들쭉날쭉 — 다시 재야 한다).
export function foldTaps(taps) {
  if (!taps.length) return { steady: 0, ms: null };
  let sx = 0, sy = 0, beat = 0, rate = 0;
  for (const v of taps) {
    const th = 2 * Math.PI * v.p;
    sx += Math.cos(th); sy += Math.sin(th);
    beat += v.beat; rate += v.rate;
  }
  const steady = Math.hypot(sx, sy) / taps.length;
  if (steady < STEADY_MIN) return { steady, ms: null };
  let ph = Math.atan2(sy, sx) / (2 * Math.PI);
  if (ph < 0) ph += 1;
  if (ph > 0.85) ph = 0; // 박보다 살짝 일찍 = 지연 없음
  beat /= taps.length; rate /= taps.length;
  const raw = ph * beat / rate * 1000; // 느린 재생분을 되돌린다
  return { steady, ms: Math.max(0, Math.min(LAG_MAX_MS, Math.round(raw / 10) * 10)) };
}

// 탭 한 번을 기록용 값으로 바꾼다. item = countAt()이 준 현재 카운트.
export function tapSample(item, musicTime, rate) {
  const len = item.end - item.time;
  if (!(len > 0)) return null;
  return { p: (musicTime - item.time) / len, beat: len, rate: rate || 1 };
}
