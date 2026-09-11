// Pure views and updates over a SongMap. Updates return a new map (the stored
// analysis is never mutated), so undo and save stay trivial.
// Rules from the agreed design: markers are time-anchored names for
// navigation/loops only and never restart the count; the correction sheet
// (1 한 박 앞/뒤 · 1↔5 · 프레이즈 길이 · 반/두 배) is what moves the counting grid.
// Every correction is folded into oneAnchorTime, the moment the user's 1 sits
// on, at press time — nothing is re-interpreted at view time, so a half/double
// switch can never flip the meaning of a stored correction. A 1↔5 press
// remembers its starting moment (oneFiveReturnTime) so a second press returns
// there exactly. Moving the anchor (withOneAt, withOneShift) clears that
// return point; tempo and phrase-length changes keep it — the return point is
// a time, so "press again to go back" stays true across grid switches.
import { layoutGrid, countAt, phaseVoteOffset } from '../analysis/analyze.js';
import { migrateSongMap, MARKER_EPSILON } from './schema.js';

function tempoBeats(analysis, manualTempo) {
  let beats = analysis.beats;
  let downbeats = analysis.downbeats;
  if (manualTempo === 'double') {
    beats = beats.flatMap((t, i) => i + 1 < beats.length ? [t, (t + beats[i + 1]) / 2] : [t]);
  } else if (manualTempo === 'half' && beats.length) {
    const first = downbeats.length ? beats.indexOf(downbeats[0]) : 0;
    const parity = first % 2;
    beats = beats.filter((_, i) => i % 2 === parity);
    const kept = new Set(beats);
    downbeats = downbeats.filter(t => kept.has(t));
  }
  return { beats, downbeats };
}

function nearestIndex(beats, time) {
  let best = 0;
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(beats[i] - time) < Math.abs(beats[best] - time)) best = i;
  }
  return best;
}

// The counting grid after user corrections, shaped for layoutGrid.
export function effectiveGrid(map) {
  const { beats, downbeats } = tempoBeats(map.analysis, map.corrections.manualTempo);
  const anchor = map.corrections.oneAnchorTime;
  let offset = null;
  if (beats.length && anchor !== null) {
    offset = nearestIndex(beats, anchor);
  } else if (downbeats.length) {
    // 첫 다운비트가 아니라 '다운비트 최빈 위상'을 격자 시작으로 — 스윙 백비트 착각 자동교정.
    // buildGrid와 같은 함수를 써야 화면 카운트가 실제로 교정된다(2026-09-10 reviewer 치명결함 수리).
    offset = phaseVoteOffset(beats, downbeats);
  }
  return { beats, downbeats, duration: map.song.duration, barPhase: { offset } };
}

// Counting restarts at 1 at every section anchor (구간별 「여기부터 1」).
// Segments are numbered as one continuous piece: a restart begins a NEW eight
// (the broken eight before it stays partial), and phrases follow the global
// eight numbers. Totals gain `sections`; endingCounts describes the last segment.
export function layout(map) {
  const grid = effectiveGrid(map);
  const { beats, duration, barPhase: { offset } } = grid;
  const sectionIdx = offset === null ? [] : [...new Set(
    map.corrections.sectionOnes.map(t => nearestIndex(beats, t)).filter(i => i > offset)
  )].sort((a, b) => a - b);
  if (!sectionIdx.length) return layoutGrid(grid, map.phraseLen);

  const starts = [offset, ...sectionIdx];
  const counts = [];
  let eightsBefore = 0;
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : beats.length;
    const segBeats = beats.slice(from, to);
    const segDuration = k + 1 < starts.length ? beats[starts[k + 1]] : duration;
    const seg = layoutGrid(
      { beats: segBeats, duration: segDuration, barPhase: { offset: 0 } },
      map.phraseLen);
    for (const c of seg.counts) {
      const eight = eightsBefore + c.eight;
      counts.push({ ...c, beat: c.beat + from, eight,
        phrase: Math.floor((eight - 1) / map.phraseLen) + 1 });
    }
    eightsBefore += Math.ceil(seg.counts.length / 8);
  }
  const fullEights = counts.filter(c => c.count === 8).length;
  return {
    counts,
    totals: {
      beats: beats.length,
      pickupBeats: offset ?? beats.length,
      fullEights,
      fullPhrases: Math.floor(fullEights / map.phraseLen),
      endingCounts: counts.length % (map.phraseLen * 8),
      sections: starts.length,
    },
  };
}

// 곡별 신뢰 배지 — 앱이 '자기가 맞는지' 스스로 표시한다(귀 없는 사용자용).
// ★정직: 정답(사람 탭/공개 데이터셋)이 없으면 '검증됨(초록)'은 절대 못 준다 —
//   서로 다른 자동도구도 스윙 백비트를 함께 착각할 수 있어 자기인증이 불가능하기 때문
//   (2026-09-11 codex+deep-reasoner 교차검증 결론). 그래서 여기선 앱이 아는 위험신호
//   (저장된 warnings)로 '확신/불확신'만 정직히 낸다. 어떤 곡이든 앱 내부값만으로 계산.
export function songTrust(map) {
  const w = new Set(map.analysis?.warnings ?? []);
  const { barPhase: { offset } } = effectiveGrid(map);
  if (map.corrections?.oneAnchorTime != null) {
    return { level: 'manual', label: '✋ 직접 맞춤',
      detail: '네가 「한 박」 버튼으로 직접 맞춘 곡이야.' };
  }
  if (offset === null || w.has('no_downbeat') || w.has('insufficient_beats')) {
    return { level: 'none', label: '🔴 근거 부족',
      detail: '박·마디를 제대로 못 찾아서 카운트를 믿기 어려워. 「한 박」으로 직접 맞춰줘.' };
  }
  if (w.has('bar_alignment_needs_review') || w.has('count_drift_needs_review')) {
    return { level: 'caution', label: '🔴 확인 필요',
      detail: '마디 길이가 들쭉날쭉하거나 중간부터 어긋날 수 있어. 카운트 보며 「한 박」으로 맞춰줘.' };
  }
  const corrected = w.has('downbeat_phase_corrected');
  return { level: 'auto', label: corrected ? '🟡 자동 교정함' : '🟡 자동 (안정적)',
    detail: '앱이 자동으로 맞췄어. 대체로 안정적이지만 사람 확인은 아직이야 — 어긋나 보이면 「한 박」으로.' };
}

export function posOf(map, time) {
  return countAt(layout(map), time);
}

// 표시용 BPM: 보정 뒤 그리드의 박 간격 중앙값. 곡 정보 시트·목록이 쓴다.
export function tempoBpm(map) {
  const { beats } = effectiveGrid(map);
  if (beats.length < 2) return null;
  const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.round(60 / med);
}

export function timeOf(map, beatIndex) {
  const { beats } = effectiveGrid(map);
  return beats[beatIndex] ?? null;
}

function updated(map, patch) {
  return migrateSongMap({ ...map, ...patch });
}

function withCorrections(map, corrections) {
  return updated(map, { corrections: { ...map.corrections, ...corrections } });
}

// 여기가 1: anchor the count to the beat nearest this moment. This is also the
// recovery path for a song whose analysis produced no downbeat at all.
export function withOneAt(map, time) {
  if (!Number.isFinite(time)) throw new TypeError('Anchor time must be finite');
  const { beats } = effectiveGrid(map);
  if (!beats.length) return map;
  return withCorrections(map, {
    oneAnchorTime: beats[nearestIndex(beats, time)],
    oneFiveReturnTime: null,
  });
}

// Moving the 1 stores the target beat's time. Out-of-range is a no-op.
export function withOneShift(map, delta) {
  if (delta !== 1 && delta !== -1) throw new RangeError('One-shift moves one beat at a time');
  const { beats, barPhase: { offset } } = effectiveGrid(map);
  if (offset === null) return map;
  const next = offset + delta;
  if (next < 0 || next >= beats.length) return map;
  return withCorrections(map, { oneAnchorTime: beats[next], oneFiveReturnTime: null });
}

// 1↔5: jump half an eight in the CURRENT grid, folded into the anchor at press
// time. A second press restores the exact starting moment.
export function withOneFiveSwap(map) {
  if (map.corrections.oneFiveReturnTime !== null) {
    return withCorrections(map, {
      oneAnchorTime: map.corrections.oneFiveReturnTime,
      oneFiveReturnTime: null,
    });
  }
  const { beats, barPhase: { offset } } = effectiveGrid(map);
  if (offset === null) return map; // nothing to swap without a proposed 1
  const swapped = offset >= 4 ? offset - 4 : offset + 4;
  if (swapped < 0 || swapped >= beats.length) return map;
  return withCorrections(map, {
    oneAnchorTime: beats[swapped],
    oneFiveReturnTime: beats[offset],
  });
}

// The anchor is a time, so switching half/double and back recovers the exact
// user correction; the visible 1 snaps to the nearest beat of the new grid.
export function withManualTempo(map, manualTempo) {
  if (manualTempo === map.corrections.manualTempo) return map;
  return withCorrections(map, { manualTempo });
}

export function withPhraseLen(map, phraseLen) {
  return updated(map, { phraseLen });
}

// 여기부터 1: counting restarts at the beat nearest this moment. This is the
// repair for a mid-song count break (one odd-length bar shifts every later
// count — measured on 11/12 real songs); the global 1 cannot fix it.
export function withSectionOne(map, time) {
  if (!Number.isFinite(time)) throw new TypeError('Section time must be finite');
  const { beats, barPhase: { offset } } = effectiveGrid(map);
  if (offset === null) return map; // a section restart needs a primary 1 first
  const snapped = beats[nearestIndex(beats, time)];
  if (snapped <= beats[offset]) return map;
  const sectionOnes = [
    ...map.corrections.sectionOnes.filter(t => Math.abs(t - snapped) >= MARKER_EPSILON),
    snapped,
  ];
  return withCorrections(map, { sectionOnes });
}

export function withoutSectionOne(map, time) {
  return withCorrections(map, {
    sectionOnes: map.corrections.sectionOnes.filter(t => Math.abs(t - time) >= MARKER_EPSILON),
  });
}

function sameMarkerTime(a, b) {
  return Math.abs(a - b) < MARKER_EPSILON;
}

export function withMarker(map, time, name) {
  const markers = [...map.markers.filter(m => !sameMarkerTime(m.time, time)), { time, name }];
  return updated(map, { markers });
}

export function withoutMarker(map, time) {
  return updated(map, { markers: map.markers.filter(m => !sameMarkerTime(m.time, time)) });
}
