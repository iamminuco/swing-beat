// SongMap v1: every per-song judgment in one place; screens only read it.
// The engine analysis is stored as-is and never edited; user corrections live
// separately so the original can always be shown or re-derived (원본 보존 v1:
// the audio file itself is NOT stored — the map is matched to a re-picked file
// by name+size+duration).
// v1 was finalized pre-release on 2026-09-07; interim in-session shapes (e.g.
// corrections.offsetShift) are rejected on purpose — no user data ever used
// them, so there is nothing to migrate. The first shipped format is this one.
// v2 (2026-09-11): `truth` — 귀 있는 사람(선생님·댄서)이 재생 중 "1"마다 탭한 시각. 앱의 카운트를 채점하고
// (count-at-tap) 교정하는 유일한 정답원. v1 지도는 truth:null로 올라온다. 저장 키·분석·보정 형식은 그대로.
export const SCHEMA_VERSION = 2;

// Two marker times closer than this are the same marker, everywhere: the API
// replaces/removes them together and the schema refuses to store such a pair.
export const MARKER_EPSILON = 1e-6;

const ACCENTS = ['EVEN', 'ONE_FIVE', 'OFF'];
const PHRASE_LENS = [4, 6, 8];
const MANUAL_TEMPOS = [null, 'half', 'double'];

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function assertOrdered(times, name) {
  if (!Array.isArray(times) || times.some((t, i) => !isFiniteNumber(t) || t < 0 || (i > 0 && t <= times[i - 1]))) {
    throw new RangeError(`${name} must be finite, ordered, unique and non-negative`);
  }
}

export function songKey(song) {
  // 구분자는 NUL(\0)이다 — 파일 이름에 절대 못 들어가는 문자라 이름·크기·길이가 섞여 충돌할 수 없다.
  // 저장 키(songmap:v1:·오디오 저장소)가 이 문자열이므로 바꾸면 기기의 저장곡 전부가 고아가 된다.
  // 2026-09-11: 원래 리터럴 NUL 바이트였는데 git이 파일을 바이너리로 봐 이스케이프로 바꿨다(값은 동일).
  return `${song.name}\0${song.size}\0${song.duration.toFixed(3)}`;
}

export function createSongMap(song, grid) {
  // song.duration is the only clock that survives persistence, so it must be
  // the analysed PCM's clock (same half-sample tolerance as buildGrid). A VBR
  // header duration that disagrees with the decoded audio is refused here.
  if (!isFiniteNumber(song?.duration) || !isFiniteNumber(grid?.duration) ||
      Math.abs(song.duration - grid.duration) > 0.5 / grid.sr) {
    throw new RangeError('song.duration must match the analysed audio duration');
  }
  const map = {
    schemaVersion: SCHEMA_VERSION,
    song: { name: String(song.name), size: song.size, duration: song.duration },
    analysis: {
      engine: Number.isInteger(grid.engine) ? grid.engine : null,
      sr: grid.sr,
      duration: grid.duration,
      firstOnset: grid.firstOnset,
      beats: [...grid.beats],
      downbeats: [...grid.downbeats],
      barPhase: { ...grid.barPhase },
      tempoFactor: grid.tempoFactor,
      warnings: [...grid.diagnostics.warnings],
    },
    corrections: { oneAnchorTime: null, oneFiveReturnTime: null, manualTempo: null, sectionOnes: [], source: 'user' },
    truth: null,
    markers: [],
    phraseLen: 4,
    accent: 'EVEN',
    rate: 1.0,
    loop: null,
    latency: { screen: 0, click: 0 },
  };
  return migrateSongMap(map);
}

// Accepts any stored object; returns a valid current-version SongMap or throws.
export function migrateSongMap(raw) {
  if (typeof raw !== 'object' || raw === null) throw new TypeError('SongMap must be an object');
  if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
    throw new RangeError('Missing or invalid schemaVersion');
  }
  if (raw.schemaVersion > SCHEMA_VERSION) {
    throw new RangeError(`SongMap schema ${raw.schemaVersion} is newer than this app (${SCHEMA_VERSION})`);
  }
  const { song, analysis } = raw;
  if (typeof song?.name !== 'string' || !Number.isInteger(song.size) || song.size < 0 ||
      !isFiniteNumber(song.duration) || song.duration <= 0) {
    throw new RangeError('song needs name, integer size and positive duration');
  }
  if (!isFiniteNumber(analysis?.sr) || analysis.sr <= 0) throw new RangeError('analysis.sr invalid');
  // Grid engine version (null for maps saved before 2026-09-11). The app re-analyses
  // a map whose engine is behind GRID_ENGINE, keeping the user's corrections.
  const engine = analysis.engine ?? null;
  if (engine !== null && (!Number.isInteger(engine) || engine < 1)) throw new RangeError('analysis.engine invalid');
  // The analysed clock is persisted so a stored map cannot quietly stretch its
  // song.duration past the audio that was actually analysed.
  if (!isFiniteNumber(analysis.duration) ||
      Math.abs(analysis.duration - song.duration) > 0.5 / analysis.sr) {
    throw new RangeError('analysis.duration must match song.duration');
  }
  if (analysis.firstOnset !== null &&
      (!isFiniteNumber(analysis.firstOnset) || analysis.firstOnset < 0 || analysis.firstOnset >= song.duration)) {
    throw new RangeError('analysis.firstOnset invalid');
  }
  assertOrdered(analysis.beats, 'analysis.beats');
  assertOrdered(analysis.downbeats, 'analysis.downbeats');
  const beatSet = new Set(analysis.beats);
  if (analysis.downbeats.some(t => !beatSet.has(t))) {
    throw new RangeError('analysis.downbeats must be a subset of analysis.beats');
  }
  // A stored map must obey the same time rules as a fresh analysis: beats live
  // inside the audio and never before the first sound (no counts in silence).
  if (analysis.beats.some(t => t >= song.duration)) {
    throw new RangeError('analysis.beats must lie inside the audio');
  }
  if (analysis.firstOnset === null && analysis.beats.length) {
    throw new RangeError('a silent song cannot carry beats');
  }
  if (analysis.firstOnset !== null && analysis.beats.length && analysis.beats[0] < analysis.firstOnset) {
    throw new RangeError('analysis.beats must not start before firstOnset');
  }
  const offset = analysis.barPhase?.offset ?? null;
  if (offset !== null && (!Number.isInteger(offset) || offset < 0 || offset >= Math.max(1, analysis.beats.length))) {
    throw new RangeError('analysis.barPhase.offset invalid');
  }
  // The user's chosen 1 is anchored to a moment in the music (seconds), so it
  // survives half/double round trips and works on songs with no downbeats.
  // oneFiveReturnTime remembers where a 1↔5 press started so a second press
  // returns exactly. Unknown correction fields are refused, never dropped: a
  // silently ignored field would erase a user's saved correction.
  const corrections = raw.corrections ?? { oneAnchorTime: null, oneFiveReturnTime: null, manualTempo: null, sectionOnes: [] };
  const knownCorrections = ['oneAnchorTime', 'oneFiveReturnTime', 'manualTempo', 'sectionOnes', 'source'];
  for (const key of Object.keys(corrections)) {
    if (!knownCorrections.includes(key)) throw new RangeError(`Unknown correction field: ${key}`);
  }
  const anchor = corrections.oneAnchorTime ?? null;
  const oneFiveReturn = corrections.oneFiveReturnTime ?? null;
  for (const [name, value] of [['oneAnchorTime', anchor], ['oneFiveReturnTime', oneFiveReturn]]) {
    if (value !== null && (!isFiniteNumber(value) || value < 0 || value >= song.duration)) {
      throw new RangeError(`corrections.${name} must be null or a time inside the audio`);
    }
  }
  if (!MANUAL_TEMPOS.includes(corrections.manualTempo)) throw new RangeError('corrections.manualTempo invalid');
  // 보정의 출처: 'user'(사람이 눌렀다) | 'structure'(앱이 구조 단서로 미리 바꿨다 — 배지에 정직하게 표시). 옛 지도는 'user'.
  const source = corrections.source ?? 'user';
  if (!['user', 'structure'].includes(source)) throw new RangeError('corrections.source invalid');
  // 구간별 「여기부터 1」: counting restarts at 1 at each of these moments.
  // The real-song measurement behind this (11/12 songs drift after one odd bar)
  // is in BEAT_APP_HANDOFF.md; a global 1 alone cannot repair a mid-song break.
  const sectionOnes = [...(corrections.sectionOnes ?? [])].sort((a, b) => a - b);
  for (const t of sectionOnes) {
    if (!isFiniteNumber(t) || t < 0 || t >= song.duration) {
      throw new RangeError('corrections.sectionOnes must be times inside the audio');
    }
  }
  if (sectionOnes.some((t, i) => i > 0 && t - sectionOnes[i - 1] < MARKER_EPSILON)) {
    throw new RangeError('corrections.sectionOnes must be distinct');
  }
  // Markers are anchored to time, not beat index, so tempo corrections can
  // never silently move a named spot to different music.
  const markers = (raw.markers ?? []).map(m => {
    if (!isFiniteNumber(m?.time) || m.time < 0 || m.time >= song.duration || typeof m?.name !== 'string') {
      throw new RangeError('marker needs a time inside the audio and a name');
    }
    return { time: m.time, name: m.name };
  }).sort((a, b) => a.time - b.time);
  if (markers.some((m, i) => i > 0 && Math.abs(m.time - markers[i - 1].time) < MARKER_EPSILON)) {
    throw new RangeError('markers must have unique times');
  }
  const phraseLen = raw.phraseLen ?? 4;
  if (!PHRASE_LENS.includes(phraseLen)) throw new RangeError('phraseLen must be 4, 6 or 8');
  const accent = raw.accent ?? 'EVEN';
  if (!ACCENTS.includes(accent)) throw new RangeError('accent invalid');
  // Rate follows the agreed presets (50~100%, never above 100%); loop must lie
  // inside the audio; latency honours the design's 300 ms correction cap.
  const rate = raw.rate ?? 1.0;
  if (!isFiniteNumber(rate) || rate < 0.5 || rate > 1.0) throw new RangeError('rate must be 0.5..1.0');
  const loop = raw.loop ?? null;
  if (loop !== null && !(isFiniteNumber(loop.start) && isFiniteNumber(loop.end) &&
      loop.start >= 0 && loop.end <= song.duration && loop.start < loop.end)) {
    throw new RangeError('loop must be null or {start,end} seconds inside the audio');
  }
  const latency = raw.latency ?? { screen: 0, click: 0 };
  if (!isFiniteNumber(latency.screen) || !isFiniteNumber(latency.click) ||
      Math.abs(latency.screen) > 0.3 || Math.abs(latency.click) > 0.3) {
    throw new RangeError('latency must be within ±0.3 s');
  }
  // 사람 확인 탭(v2). 시각은 곡 안·오름차순·유일. 최소 1개. 기록 시각 문자열은 출처 표시용.
  let truth = raw.truth ?? null;
  if (truth !== null) {
    if (typeof truth !== 'object' || !Array.isArray(truth.ones) || !truth.ones.length) {
      throw new RangeError('truth needs a non-empty ones array');
    }
    const ones = [...truth.ones];
    assertOrdered(ones, 'truth.ones');
    if (ones.some(t => t >= song.duration)) throw new RangeError('truth.ones must lie inside the audio');
    truth = { ones, recordedAt: typeof truth.recordedAt === 'string' ? truth.recordedAt : '' };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    song: { name: song.name, size: song.size, duration: song.duration },
    analysis: {
      engine,
      sr: analysis.sr, duration: analysis.duration, firstOnset: analysis.firstOnset,
      beats: [...analysis.beats], downbeats: [...analysis.downbeats],
      barPhase: { offset, confidence: analysis.barPhase?.confidence ?? null },
      tempoFactor: analysis.tempoFactor ?? 1,
      warnings: [...(analysis.warnings ?? [])],
    },
    corrections: {
      oneAnchorTime: anchor,
      oneFiveReturnTime: oneFiveReturn,
      manualTempo: corrections.manualTempo,
      sectionOnes,
      source,
    },
    truth,
    markers, phraseLen, accent, rate,
    loop: loop === null ? null : { start: loop.start, end: loop.end },
    latency: { screen: latency.screen, click: latency.click },
  };
}
