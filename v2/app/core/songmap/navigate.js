// 표식(깃발) 탐색과 구간반복 범위 — 합의(설계 §8): 표식은 이름·탐색·반복 전용이고
// 카운트를 건드리지 않는다. 반복 = 현재 위치 양옆 표식 사이, 표식이 없으면
// 현재 프레이즈. 한쪽만 있으면 곡 처음/끝이 그 자리를 대신한다(Audipo와 같다).
const BACK_GRACE = 0.6; // 이전: 지금 표식 바로 위에 있으면 그 앞 표식으로 간다

export function prevMarker(markers, time) {
  let best = null;
  for (const m of markers) if (m.time < time - BACK_GRACE) best = m;
  return best;
}

export function nextMarker(markers, time) {
  for (const m of markers) if (m.time > time + 0.05) return m;
  return null;
}

// phrase = {start, end, label} 현재 프레이즈(없으면 null). duration = 곡 길이.
// tolerance: 표식 바로 앞(압축 오디오 탐색이 몇 ms 못 미친 자리)도 그 표식 위로 본다 —
// 되감을 때마다 앞 구간으로 미끄러지는 것을 막는다.
export function loopRange(markers, time, phrase, duration, tolerance = 0.05) {
  let left = null, right = null;
  for (const m of markers) {
    if (m.time <= time + tolerance) left = m;
    else if (!right) right = m;
  }
  if (!left && !right) {
    return phrase ? { start: phrase.start, end: phrase.end, label: phrase.label } : null;
  }
  const name = m => (m ? (m.name || '표시') : null);
  return {
    start: left ? left.time : 0,
    end: right ? right.time : duration,
    label: `${name(left) ?? '처음'} → ${name(right) ?? '끝'}`,
  };
}

// 현재 시각에 가장 가까운 표식(삭제 대상). tolerance 초 안에 없으면 null.
export function markerNear(markers, time, tolerance = 2) {
  let best = null;
  for (const m of markers) {
    if (Math.abs(m.time - time) <= tolerance && (!best || Math.abs(m.time - time) < Math.abs(best.time - time))) best = m;
  }
  return best;
}
