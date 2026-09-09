// Player page: file → analysis (log-mel → ONNX → peaks) → SongMap → timeline
// with 1~8 counts, clicks and the correction sheet. Screens only read the
// SongMap; every judgment change goes through core/songmap functions and is
// saved immediately. The analysis and playback clocks come from the same
// decoded file; device offsets are handled by the two latency values only.
// 화면 구성은 design_mockup/gen2.py(시안 10장)를 따른다: 재생(HUD·타임라인·컨트롤
// 2줄) · 학습(박자 테스트·연습·지난번 결과) · 목록(선택·전체 재생·설정) · 시트
// (곡 정보·박자 보정 / 속도 / 설정 / 표시 이름) · 오버레이(게임·청음·두드려 재기·결과).
// 학습 오버레이가 떠 있는 동안(learning) 플레이어의 반복·강세·카운트음·연속재생은
// 모두 멈춘다 — 학습 소리에 플레이어 보조음이 섞이거나 곡이 바뀌면 안 된다(codex 9/8 #2·#3·#12).
import { prepareFilterbank, logMelSpect } from '../core/analysis/logmel.js';
import { chunkStarts, extractChunk, aggregate, CHUNK_SIZE, MIN_FRAMES } from '../core/analysis/chunking.js';
import { pickBeats } from '../core/analysis/postprocess.js';
import { analyze, countAt } from '../core/analysis/analyze.js';
import { createSongMap, songKey } from '../core/songmap/schema.js';
import {
  layout, withOneShift, withOneFiveSwap, withOneAt, withSectionOne, withoutSectionOne,
  withPhraseLen, withManualTempo, withMarker, withoutMarker, tempoBpm,
} from '../core/songmap/songmap.js';
import { prevMarker, nextMarker, loopRange, markerNear } from '../core/songmap/navigate.js';
import { saveSongMap, loadSongMap, listSongMaps } from '../storage/songstore.js';
import { decodeToModelRate, MODEL_SR } from '../audio/decode.js';
import { createClickEngine } from '../audio/click.js';
import { startGame } from './game.js';
import { startBounce } from './bounce.js';
import { startListening } from './listen.js';
import { startCalibration } from './calibrate.js';
import { saveAudio, loadAudio, listAudioKeys, requestPersistence } from '../storage/audiostore.js';
import { makeListeningQuiz, demoPair } from '../core/learn/listening.js';
import { fullWindows, pickWindow } from '../core/learn/windows.js';
import { lastResults, recordResult, describeTiming, suggestDefaults } from '../core/learn/results.js';

const LAST_SONG = 'beatapp_last_song';
const PREFS = 'beatapp_prefs_v1'; // 컨트롤 펼침 · 강세 방식

const $ = id => document.getElementById(id);
const au = $('au');

let map = null, lay = null, samples = null, rows = [];
let session = null, filterbank = null;
let clickOn = false, countMode = 1, loopOn = false;
let clickState = { nextIdx: 0 };
let lag = { screen: 0, click: 0 };
// accentMethod 기본 = 'click'(다른 음색으로 짝수 박만 찍음, 음악 신호를 안 건드림).
// 'gain'(음악 볼륨을 짝수 박에서 키움)은 음악을 WebAudio(MediaElementSource)로 태워야 하는데,
// 크롬이 그 경로에서 일시정지 때 지지직 노이즈를 낸다(사용자 실보고 9/8·codex 독립 확인).
// 그래서 gain은 기본이 아니라 사용자가 설정에서 명시로 켤 때만 쓴다.
let prefs = { expanded: false, accentMethod: 'click', countMode: 1, cueVol: 100 };
const analyzing = new Set();   // 뒤에서 분석 중인 파일 이름(목록의 「박 찾는 중」)
const selected = new Set();    // 목록에서 고른 곡 키
let queue = [], queueIdx = -1; // 연속 재생
let loopCur = null;            // 지금 적용 중인 반복 구간 {start,end,label}
let learning = false;          // 학습 오버레이(게임·청음·두드려 재기)가 떠 있는 동안 true
let openSeq = 0;               // 곡 열기 요청 번호 — 늦게 끝난 열기가 최신 선택을 덮지 않게
let countInTimer = null;       // 카운트인 뒤 재생 예약
let objectUrl = null;          // 현재 au.src (곡을 바꿀 때 해제)
try {
  const j = JSON.parse(localStorage.getItem('beatapp_lag_v1') || 'null');
  if (j) { lag = { screen: Math.min(300, j.screen | 0), click: Math.min(300, j.click | 0) }; paintLag.touched = true; }
  const p = JSON.parse(localStorage.getItem(PREFS) || 'null');
  if (p) prefs = { ...prefs, ...p };
  if ([0, 1, 2].includes(prefs.countMode)) countMode = prefs.countMode;
} catch { /* fresh device */ }
function savePrefs() {
  try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* private mode */ }
}

let audioCtx = null;
function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
// iOS: 백그라운드에 갔다 오면 컨텍스트가 suspended로 남을 수 있다 — 화면·소리는 도는데
// 카운트음만 안 나는 상태. 돌아올 때와 다음 터치에서 다시 깨운다.
document.addEventListener('visibilitychange', () => { if (!document.hidden && audioCtx) ensureCtx(); });
document.addEventListener('pointerdown', () => { if (audioCtx && audioCtx.state === 'suspended') ensureCtx(); }, { passive: true });

// 짝수 강세의 정본(시안 §6 ①): 음악 자체를 짝수 박에서 +3.5dB 키운다.
// 음악과 같은 출력 경로라 별도 지연 보정 없이 저절로 동기된다.
let mediaSrc = null, accentGain = null;
let accentState = { nextIdx: 0 };
// 음악을 WebAudio에 태우는 그래프. 한 번 만들면 되돌릴 수 없고(엘리먼트가 영구히 묶임)
// 크롬에서 지지직의 원인이 되므로, 'gain' 강세를 실제로 쓸 때만 lazy하게 만든다.
// 기본 경로(click 강세·강세 꺼짐)는 이 함수를 안 부르고 <audio>가 스피커로 바로 나간다.
function ensureMediaGraph() {
  const ctx = ensureCtx();
  if (!mediaSrc) {
    mediaSrc = ctx.createMediaElementSource(au);
    accentGain = ctx.createGain();
    mediaSrc.connect(accentGain).connect(ctx.destination);
  }
  return accentGain;
}
const engine = createClickEngine(ensureCtx);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const baseName = n => n.replace(/\.[^.]+$/, '');

// ── 분석 ──────────────────────────────────────────────────────────
async function ensureModel(progress) {
  if (!filterbank) {
    const buf = await (await fetch('./assets/mel_filterbank_513x128.bin')).arrayBuffer();
    filterbank = prepareFilterbank(new Float32Array(buf));
  }
  if (!session) {
    progress('모델 받는 중 (9.9MB · 처음 한 번)…');
    session = await ort.InferenceSession.create('./assets/beat_this_small0.onnx',
      { executionProviders: ['wasm'] });
  }
}

async function analyseSamples(pcm, progress) {
  progress('스펙트로그램 계산 중…');
  await new Promise(r => setTimeout(r));
  const { frames, data } = logMelSpect(pcm, filterbank);
  if (frames < MIN_FRAMES) throw new Error('30초보다 짧은 곡은 아직 분석할 수 없어요');
  const starts = chunkStarts(frames);
  const beatChunks = [], downChunks = [];
  for (let i = 0; i < starts.length; i++) {
    progress(`박자 찾는 중 ${i + 1}/${starts.length}…`);
    await new Promise(r => setTimeout(r));
    const out = await session.run({
      spect: new ort.Tensor('float32', extractChunk(data, frames, starts[i]), [1, CHUNK_SIZE, 128]),
    });
    beatChunks.push(out.beat_logits.data);
    downChunks.push(out.downbeat_logits.data);
  }
  const picked = pickBeats(
    aggregate(beatChunks, starts, frames), aggregate(downChunks, starts, frames));
  // 마지막 스펙트럼 프레임은 시각이 정확히 duration과 같을 수 있다(가장자리
  // 인공물). 그리드 계약은 duration 미만만 받으므로 여기서 걸러낸다.
  const duration = pcm.length / MODEL_SR;
  const beats = picked.beats.filter(t => t < duration);
  const kept = new Set(beats);
  return { sr: MODEL_SR, duration, beats, downbeats: picked.downbeats.filter(t => kept.has(t)) };
}

// 곡 하나를 분석해 SongMap을 저장한다(이미 저장돼 있으면 즉시). UI는 안 건드린다.
async function analyzeAndSave(file, progress) {
  const { samples: pcm, duration } = await decodeToModelRate(file);
  const song = { name: file.name, size: file.size, duration };
  let m = loadSongMap(song);
  let fresh = false;
  if (!m) {
    await ensureModel(progress);
    const model = await analyseSamples(pcm, progress);
    m = createSongMap(song, analyze(pcm, MODEL_SR, model));
    saveSongMap(m);
    fresh = true;
  }
  const stored = await saveAudio(songKey(m.song), file); // 기기 안 저장 — 다음에 열 때 파일 재선택 불요
  if (!stored) toast(`「${baseName(file.name)}」 파일을 기기에 저장하지 못했어요(용량 부족?) — 다음엔 다시 골라야 해요`);
  return { m, pcm, fresh };
}

// 재생 화면에 곡을 올린다(파일이든 저장 blob이든 공통).
function mountSong(m, pcm, blob) {
  clearTimeout(countInTimer); countInTimer = null;
  queue = queue.length ? queue : []; // 연속 재생 큐는 호출자가 관리
  map = m;
  samples = pcm;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  au.src = objectUrl;
  try { localStorage.setItem(LAST_SONG, songKey(m.song)); } catch { /* private */ }
  $('songTitle').textContent = baseName(m.song.name);
  $('dropZone').hidden = true;
  $('topBar').hidden = false;
  $('tabBar').hidden = false;
  switchTab('play');
  rebuild();
}

async function openFile(file, prefix = '') {
  const seq = ++openSeq;
  const progress = t => { if (seq === openSeq) $('progress').textContent = prefix + t; };
  try {
    progress('곡 읽는 중…');
    analyzing.add(file.name);
    const { m, pcm, fresh } = await analyzeAndSave(file, progress);
    analyzing.delete(file.name);
    if (seq !== openSeq) return; // 그새 다른 곡을 골랐다 — 저장만 하고 화면은 안 바꾼다
    mountSong(m, pcm, file);
    if (!fresh) toast('저장된 박자 설정을 불러왔어요');
    // 보정 시트를 먼저 들이밀지 않는다 — 우선 들려주고, 어긋날 때만 안내한다.
    if (fresh && map.analysis.warnings.includes('count_drift_needs_review')) {
      toast('중간에 카운트가 어긋나게 들리면 곡 제목을 눌러 「지금 이 순간이 1이에요」를 한 번 눌러 주세요');
    }
  } catch (err) {
    analyzing.delete(file.name);
    progress('');
    toast('분석 실패: ' + (err?.message || err));
    throw err;
  }
}

// 여러 곡: 첫 곡은 재생 화면에 올리고(곡이 이미 열려 있고 여러 개를 고른 경우만 예외 —
// 그때는 전부 뒤에서 준비만), 나머지는 차례로 분석해 저장해 둔다(목록에 「박 찾는 중」).
async function openFiles(files) {
  const mountFirst = !map || files.length === 1;
  if (mountFirst) {
    try {
      await openFile(files[0], files.length > 1 ? `1/${files.length}곡 · ` : '');
    } catch {
      return; // 첫 곡이 실패하면 큐를 계속 돌릴 이유가 없다
    }
  }
  const rest = mountFirst ? files.slice(1) : files;
  for (const f of rest) analyzing.add(f.name);
  renderList();
  let prepared = 0;
  for (let i = 0; i < rest.length; i++) {
    const label = `${i + 1}/${rest.length}곡 「${baseName(rest[i].name)}」 `;
    try {
      await analyzeAndSave(rest[i], t => toast(label + t));
      prepared += 1;
    } catch (err) {
      toast(label + '분석 실패: ' + (err?.message || err));
      await new Promise(r => setTimeout(r, 1600));
    }
    analyzing.delete(rest[i].name);
    renderList();
  }
  if (rest.length) toast(`${prepared}곡 준비 완료 — 목록에서 바로 열려요`);
}

// ── SongMap 갱신 → 화면 재구성 ────────────────────────────────────
function applyMap(next, msg) {
  if (next === map) return;
  map = saveSongMap(next); // 저장이 돌려주는 검증본이 정본
  rebuild();
  resync();
  if (loopOn) updateLoop();
  if (msg) toast(msg);
}

function rebuild() {
  lay = layout(map);
  buildRows();
  drawTimeline();
  paintSub();
  paintDrift();
  lastKey = null; // HUD 캐시 무효화 — 같은 카운트 숫자라도 프레이즈·강조가 바뀔 수 있다
  paintCells(null);
  $('btnAccent').classList.toggle('on', map.accent === 'EVEN');
  setSpeed(Math.round(map.rate * 100), false);
  if (!$('infoSheet').hidden) paintInfoStats();
  $('fxUndoSection').disabled = map.corrections.sectionOnes.length === 0;
}

function paintSub() {
  const bpm = tempoBpm(map);
  $('songSub').textContent = `${bpm ? bpm + ' BPM · ' : ''}${fmtTime(map.song.duration)}`;
}

function paintDrift() {
  const w = map.analysis.warnings;
  let txt = '';
  if (w.includes('no_downbeat')) {
    txt = '이 곡은 1을 자동으로 못 찾았어요. 1이라고 들리는 순간에 위 버튼을 눌러 주세요.';
  } else if (w.includes('count_drift_needs_review')) {
    txt = '이 곡은 중간부터 어긋날 수 있는 곡이에요 — 어긋나는 순간 위 버튼 한 번이면 그 자리부터 다시 맞아요.';
  }
  $('driftInfo').textContent = txt;
}

// ── 타임라인 (한 줄 = 프레이즈 · 굵은 눈금 = 에이트 · 얇은 선 = 카운트 · 깃발 = 표시) ──
function buildRows() {
  rows = [];
  const counts = lay.counts;
  if (!counts.length) {
    rows.push({ t0: 0, t1: map.song.duration, phrase: null });
    return;
  }
  if (counts[0].time > 0.5) rows.push({ t0: 0, t1: counts[0].time, phrase: null }); // 인트로 줄
  let cur = null;
  for (const c of counts) {
    if (!cur || c.phrase !== cur.phrase) {
      if (cur) rows.push(cur);
      cur = { t0: c.time, t1: c.end, phrase: c.phrase, marks: [] };
    }
    cur.t1 = c.end;
    cur.marks.push(c);
  }
  rows.push(cur);
  rows[rows.length - 1].t1 = Math.max(rows[rows.length - 1].t1, map.song.duration); // 엔딩 포함
}

function drawTimeline() {
  const canvas = $('wave');
  const wrap = $('timelineWrap');
  const width = wrap.clientWidth - 24;
  if (width <= 0) return; // 숨겨진 탭 — 보일 때 다시 그린다
  // 줄 높이: 남는 높이를 프레이즈 수로 나누되 22px 아래로는 안 줄인다(넘치면 스크롤)
  const rowH = Math.max(22, Math.floor((wrap.clientHeight - 8) / rows.length));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = rowH * rows.length * dpr;
  canvas.style.height = rowH * rows.length + 'px';
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, width, rowH * rows.length);
  rows.forEach((row, r) => {
    const y0 = r * rowH, span = row.t1 - row.t0;
    g.fillStyle = '#4a5060';
    const mid = y0 + rowH / 2, amp = rowH * 0.42;
    for (let x = 0; x < width; x++) {
      const s0 = Math.floor((row.t0 + (x / width) * span) * MODEL_SR);
      const s1 = Math.floor((row.t0 + ((x + 1) / width) * span) * MODEL_SR);
      let mn = 0, mx = 0;
      for (let s = Math.max(0, s0); s < Math.min(samples.length, s1); s += 8) {
        const v = samples[s];
        if (v < mn) mn = v; else if (v > mx) mx = v;
      }
      g.fillRect(x, mid + mn * amp, 1, Math.max(1, (mx - mn) * amp));
    }
    if (countMode > 0 && row.marks) {
      for (const c of row.marks) {
        const x = ((c.time - row.t0) / span) * width;
        if (c.count === 1) { // 에이트 시작 = 굵은 눈금
          g.fillStyle = '#c9cdd6';
          g.fillRect(x, y0 + 2, 2, rowH - 4);
        } else if (countMode === 2) { // 카운트·선
          g.fillStyle = '#5a5e68';
          g.fillRect(x, y0 + rowH * 0.25, 1, rowH * 0.5);
        }
      }
    }
    g.strokeStyle = '#2c313b';
    g.strokeRect(0, y0 + 0.5, width, rowH - 1);
  });
  // 반복 구간 테두리 (시안: 줄 바깥 노란 윤곽)
  if (loopOn && loopCur) {
    g.strokeStyle = '#ffd644';
    g.lineWidth = 2;
    rows.forEach((row, r) => {
      if (row.t1 <= loopCur.start + 1e-6 || row.t0 >= loopCur.end - 1e-6) return;
      g.strokeRect(1, r * rowH + 1, width - 2, rowH - 2);
    });
    g.lineWidth = 1;
  }
  // 깃발 = 깃대 + 삼각 + 이름 (재생 위치의 노란 선과 형태를 다르게)
  drawTimeline.geom = { width, rowH };
  for (const m of map.markers) {
    const loc = locate(m.time);
    if (!loc) continue;
    const y0 = loc.r * rowH;
    g.fillStyle = '#f2f1ec';
    g.fillRect(loc.x, y0, 2, rowH);
    g.beginPath();
    g.moveTo(loc.x + 2, y0); g.lineTo(loc.x + 13, y0); g.lineTo(loc.x + 10, y0 + 4);
    g.lineTo(loc.x + 13, y0 + 8); g.lineTo(loc.x + 2, y0 + 8); g.closePath(); g.fill();
    if (m.name) {
      g.font = '600 10px system-ui';
      g.textBaseline = 'top'; g.textAlign = 'left';
      const tw = g.measureText(m.name).width + 6;
      const tx = Math.min(loc.x + 15, width - tw);
      g.fillStyle = '#16181d';
      g.fillRect(tx, y0 + 1, tw, 12);
      g.fillStyle = '#f2f1ec';
      g.fillText(m.name, tx + 3, y0 + 2);
    }
  }
}

function locate(time) {
  if (!drawTimeline.geom) return null;
  for (let r = 0; r < rows.length; r++) {
    if (time < rows[r].t1 || r === rows.length - 1) {
      const { width, rowH } = drawTimeline.geom;
      const x = ((time - rows[r].t0) / (rows[r].t1 - rows[r].t0)) * width;
      return { r, x: Math.max(0, Math.min(width, x)), rowH };
    }
  }
  return null;
}

$('timeline').addEventListener('click', e => {
  if (!drawTimeline.geom) return;
  const rect = $('wave').getBoundingClientRect();
  const { rowH, width } = drawTimeline.geom;
  const r = Math.min(rows.length - 1, Math.floor((e.clientY - rect.top) / rowH));
  const frac = (e.clientX - rect.left) / width;
  au.currentTime = rows[r].t0 + frac * (rows[r].t1 - rows[r].t0);
  resync();
});

// ── 재생 표시 (화면은 lagScreen 만큼 늦춰 본다) ────────────────────
let lastRow = -1, lastKey = null, lastSec = -1;
function paintCells(item) {
  const cells = $('cells').children;
  for (let n = 1; n <= 8; n++) {
    cells[n - 1].classList.toggle('cur', !!item && item.count === n);
    cells[n - 1].classList.toggle('acc', !!map && map.accent === 'EVEN' && n % 2 === 0);
  }
}
function paintNow() {
  const t = heardTime();
  const item = lay ? countAt(lay, t) : null;
  const big = $('bigCount');
  const key = item ? `${item.count}/${item.eight}/${map.accent}` : null;
  if (key !== lastKey) {
    if (item) {
      big.textContent = item.count;
      big.classList.remove('idle');
      // 1은 노랗게 확 커진다 — 귀로 못 잡아도 눈으로 1의 자리를 잡게(못 듣는 초보). 소리(둠)와 같은 순간.
      big.classList.toggle('one', item.count === 1);
      big.classList.toggle('accent', item.count !== 1 && map.accent === 'EVEN' && item.count % 2 === 0);
      paintCells(item);
      const phrases = lay.totals.fullPhrases + (lay.totals.endingCounts ? 1 : 0);
      const eightIn = ((item.eight - 1) % map.phraseLen) + 1;
      $('progressLine').innerHTML =
        `프레이즈 <b>${item.phrase}</b> / ${phrases} &nbsp;·&nbsp; 에이트 <b>${eightIn}</b> / ${map.phraseLen}`;
    } else {
      big.textContent = '–';
      big.classList.add('idle');
      paintCells(null);
      $('progressLine').textContent = '';
    }
    lastKey = key;
  }
  const sec = Math.floor(Math.max(0, au.currentTime));
  if (map && sec !== lastSec) {
    $('tlTime').textContent = `${fmtTime(sec)} / ${fmtTime(map.song.duration)}`;
    lastSec = sec;
  }
  const loc = locate(Math.max(0, t));
  if (loc) {
    const hl = $('rowHl'), cur = $('cursor'), eh = $('eightHl');
    hl.style.display = cur.style.display = 'block';
    hl.style.top = loc.r * loc.rowH + 'px';
    hl.style.height = loc.rowH + 'px';
    cur.style.top = loc.r * loc.rowH + 'px';
    cur.style.height = loc.rowH + 'px';
    cur.style.left = loc.x + 'px'; // 캔버스와 같은 상자 안 — 바깥 여백을 더하지 않는다
    // 현재 에이트 상자
    if (item && countMode > 0) {
      const row = rows[loc.r];
      const first = row.marks?.find(c => c.eight === item.eight);
      const last = row.marks ? [...row.marks].reverse().find(c => c.eight === item.eight) : null;
      if (first && last) {
        const w = drawTimeline.geom.width, span = row.t1 - row.t0;
        eh.style.display = 'block';
        eh.style.top = loc.r * loc.rowH + 'px';
        eh.style.height = loc.rowH + 'px';
        eh.style.left = ((first.time - row.t0) / span) * w + 'px';
        eh.style.width = Math.max(2, ((last.end - first.time) / span) * w) + 'px';
      } else eh.style.display = 'none';
    } else eh.style.display = 'none';
    // 넘치면 스크롤 — 현재 줄이 보이게 따라간다(줄이 바뀔 때만)
    if (loc.r !== lastRow) {
      lastRow = loc.r;
      const wrap = $('timelineWrap');
      const top = loc.r * loc.rowH, bottom = top + loc.rowH;
      if (top < wrap.scrollTop + loc.rowH || bottom > wrap.scrollTop + wrap.clientHeight - loc.rowH) {
        wrap.scrollTo({ top: Math.max(0, top - wrap.clientHeight * 0.4), behavior: 'smooth' });
      }
    }
  }
  requestAnimationFrame(paintNow);
}

// ── 클릭 스케줄러 (25ms 룩어헤드 · 시킹마다 resync) ────────────────
function resync() {
  if (!lay) return;
  const t = au.currentTime;
  let lo = 0;
  while (lo < lay.counts.length && lay.counts[lo].time < t) lo++;
  clickState.nextIdx = lo;
  accentState.nextIdx = lo;
  lastKey = null;
  engine.cancelPending(); // 옛 자리에서 예약된 클릭은 버린다
  if (accentGain) { // 시킹 전에 예약된 볼륨 변화를 지운다
    accentGain.gain.cancelScheduledValues(0);
    accentGain.gain.value = 1;
  }
}

function currentPhrase() {
  const loc = locate(au.currentTime + 0.05); // 되감기 착지가 몇 ms 못 미쳐도 그 프레이즈로 본다
  const row = loc ? rows[loc.r] : null;
  return row && row.phrase !== null ? { start: row.t0, end: row.t1, label: '프레이즈 ' + row.phrase } : null;
}

function updateLoop() {
  const next = loopOn ? loopRange(map.markers, au.currentTime, currentPhrase(), map.song.duration) : null;
  const changed = (next?.start !== loopCur?.start) || (next?.end !== loopCur?.end);
  loopCur = next;
  if (changed) {
    // 표시(깃발)로 만든 구간은 이름이 없으니 시각으로 보여준다 — 「반복 · 0:41–1:12」
    const usesMarkers = loopCur && map.markers.some(m => Math.abs(m.time - loopCur.start) < 0.05 || Math.abs(m.time - loopCur.end) < 0.05);
    const label = loopCur ? (usesMarkers ? `${fmtTime(loopCur.start)}–${fmtTime(loopCur.end)}` : loopCur.label) : '';
    $('loopLabel').textContent = loopOn && loopCur ? '반복 · ' + label : '';
    drawTimeline();
  }
}

setInterval(() => {
  if (au.paused || !lay || learning || au.seeking) return;
  const rate = au.playbackRate || 1;
  const t = au.currentTime;
  if (loopOn) {
    if (!loopCur) updateLoop();
    if (loopCur && t >= loopCur.end - 0.03 && t < loopCur.end + 0.6) {
      au.currentTime = loopCur.start; // seeked → resync + updateLoop
      return;
    }
    if (loopCur && (t < loopCur.start - 0.05 || t >= loopCur.end + 0.6)) {
      updateLoop(); // 구간 밖으로 옮겨 갔다(탐색) — 새 자리 기준으로 다시 잡는다
    }
  }
  const now = t, horizon = now + 0.15 * rate;
  if (map.accent === 'EVEN') {
    while (accentState.nextIdx < lay.counts.length && lay.counts[accentState.nextIdx].time < horizon) {
      const c = lay.counts[accentState.nextIdx];
      if (c.count % 2 === 0 && c.time >= now - 0.01) {
        if (prefs.accentMethod === 'gain') {
          const g = ensureMediaGraph().gain; // gain을 쓸 때만 음악을 WebAudio에 태운다
          const when = audioCtx.currentTime + (c.time - now) / rate;
          const half = Math.max(0.08, (c.end - c.time) * 0.5 / rate);
          g.setValueAtTime(1, Math.max(0, when - 0.005));
          g.linearRampToValueAtTime(1.5, when + 0.02);
          g.setValueAtTime(1.5, when + half);
          g.linearRampToValueAtTime(1, when + half + 0.06);
        } else if (prefs.accentMethod === 'click' && !clickOn && audioCtx) {
          // 카운트음이 켜져 있으면 그 강세 단계가 이미 짝수를 키운다
          const when = audioCtx.currentTime + (c.time - now) / rate + lag.click / 1000;
          engine.accentClick(when, 0.6);
        }
      }
      accentState.nextIdx += 1;
    }
  }
  if (!clickOn || !audioCtx) return;
  engine.schedule(clickState, lay.counts, now, rate,
    { lagClickMs: lag.click, accent: map.accent, volume: prefs.cueVol / 100 });
}, 25);

au.addEventListener('seeked', () => { resync(); if (loopOn) updateLoop(); }); // 옮겨 간 자리 기준으로 반복 구간을 다시 잡는다
au.addEventListener('play', () => { $('btnPlay').textContent = '⏸'; resync(); if (loopOn) updateLoop(); });
au.addEventListener('pause', () => { $('btnPlay').textContent = '▶'; engine.cancelPending(); });
au.addEventListener('ended', () => {
  if (learning) return; // 학습 화면이 곡 끝을 스스로 처리한다
  if (loopOn && loopCur && loopCur.end >= map.song.duration - 0.05) { // 곡 끝을 포함하는 반복
    au.currentTime = loopCur.start;
    au.play().catch(() => {});
    return;
  }
  if (queueIdx >= 0 && queueIdx + 1 < queue.length) playQueued(queueIdx + 1); // 연속 재생: 다음 곡
});
au.addEventListener('playing', () => {
  setTimeout(() => { // 브라우저가 아는 출력 지연을 화면 보정 시작값으로 (사람 값 우선)
    const L = audioCtx?.outputLatency;
    if (!paintLag.touched && typeof L === 'number' && L > 0.02 && L < 0.5) {
      lag.screen = Math.min(300, Math.round(L * 100) * 10);
      paintLag();
    }
  }, 400);
});

// ── 버튼들 ────────────────────────────────────────────────────────
$('btnOpen').onclick = () => $('fileInput').click();
$('btnAddFiles').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  if (e.target.files.length) openFiles([...e.target.files]);
  e.target.value = ''; // 같은 파일을 다시 골라도 change가 나게
};

function startPlayback() {
  au.play().catch(() => toast('재생을 시작하지 못했어요 — ▶를 다시 눌러 주세요'));
}
function play() {
  ensureCtx();
  if (countInTimer) return; // 카운트인 진행 중 — 재생 예약이 이미 있다
  if (clickOn && lay?.counts.length) {
    // 카운트인 5·6·7·8 뒤에 오는 것은 1이어야 한다: 멈춘 자리에서 가장 가까운 다음 1로
    // 출발점을 옮긴 뒤 그 박 간격으로 넷을 세고 시작한다(설계 §9).
    const t = au.currentTime;
    let i = lay.counts.findIndex(c => c.count === 1 && c.time >= t - 0.02);
    if (i === -1) i = Math.max(0, clickState.nextIdx);
    const c = lay.counts[Math.min(i, lay.counts.length - 1)];
    const next = lay.counts[Math.min(i, lay.counts.length - 1) + 1];
    const interval = next ? next.time - c.time : (c.end - c.time) || 0.5;
    if (Math.abs(au.currentTime - c.time) > 0.005) au.currentTime = c.time;
    const wait = engine.countIn(interval, au.playbackRate || 1,
      { lagClickMs: lag.click, accent: map.accent, volume: prefs.cueVol / 100 });
    countInTimer = setTimeout(() => { countInTimer = null; startPlayback(); }, wait * 1000);
  } else {
    startPlayback();
  }
}
$('btnPlay').onclick = () => {
  if (countInTimer) { // 카운트인 도중 다시 누름 = 취소
    clearTimeout(countInTimer); countInTimer = null;
    engine.cancelPending();
    return;
  }
  if (!au.paused) au.pause(); else play();
};

// 이전/다음 = 표시(깃발) 사이 이동. 그쪽에 표시가 없으면 프레이즈 단위로 간다.
function jump(dir) {
  const m = dir < 0 ? prevMarker(map.markers, au.currentTime) : nextMarker(map.markers, au.currentTime);
  if (m) {
    au.currentTime = m.time;
    resync();
    toast((m.name ? `「${m.name}」` : '표시') + (dir < 0 ? '로 돌아가요' : '로 가요'));
    return;
  }
  const loc = locate(au.currentTime);
  if (!loc) return;
  const target = rows[Math.max(0, Math.min(rows.length - 1, loc.r + dir))];
  au.currentTime = target.t0;
  resync();
}
$('btnPrev').onclick = () => jump(-1);
$('btnNext').onclick = () => jump(1);
function setLoop(on) {
  loopOn = on;
  $('btnLoop').classList.toggle('on', loopOn);
  updateLoop();
}
$('btnLoop').onclick = () => {
  setLoop(!loopOn);
  if (!loopOn) { toast('반복을 껐어요'); return; }
  const usesMarkers = loopCur && map.markers.some(m => Math.abs(m.time - loopCur.start) < 0.05 || Math.abs(m.time - loopCur.end) < 0.05);
  toast(loopCur
    ? (usesMarkers ? `반복: ${fmtTime(loopCur.start)}–${fmtTime(loopCur.end)}` : `반복: ${loopCur.label} · 「추가」로 표시 두 개를 찍으면 그 사이를 돌아요`)
    : '반복을 켰어요 · 「추가」로 표시 두 개를 찍으면 그 사이를 돌아요');
};
$('btnClick').onclick = () => {
  setClick(!clickOn);
  if (clickOn) toast('1은 낮은 「둠」, 2·4는 밝게 — 낮은 소리가 나는 자리가 1이에요');
};
function setClick(on) {
  clickOn = on;
  $('btnClick').classList.toggle('on', clickOn);
  ensureCtx();
  resync();
}
function setAccent(on) {
  const next = on ? 'EVEN' : 'OFF';
  if (map.accent !== next) applyMap({ ...map, accent: next });
  $('btnAccent').classList.toggle('on', next === 'EVEN');
  if (next === 'OFF' && accentGain) {
    accentGain.gain.cancelScheduledValues(0);
    accentGain.gain.value = 1;
  }
  lastKey = null;
}
$('btnAccent').onclick = () => {
  const on = map.accent !== 'EVEN';
  setAccent(on);
  toast(on
    ? (prefs.accentMethod === 'gain' ? '2·4·6·8에서 음악이 살짝 커져요' : '2·4·6·8에 다른 음색이 찍혀요')
    : '짝수 강세를 껐어요');
};

// 카운트 표시 3단 (끔 · 카운트 · 카운트·선). 끔 = 숫자·칸·진행도 사라진 Audipo식 화면(시안 2).
function setCountMode(n) {
  countMode = n;
  if (prefs.countMode !== n) { prefs.countMode = n; savePrefs(); }
  for (const b of $('seg').children) b.classList.toggle('on', +b.dataset.cm === n);
  $('hud').hidden = n === 0 || document.querySelector('.tab.on')?.dataset.tab !== 'play';
  if (n === 0) $('eightHl').style.display = 'none';
  if (lay) drawTimeline();
}
for (const b of $('seg').children) b.onclick = () => setCountMode(+b.dataset.cm);
setCountMode(countMode); // 저장된 표시 단계 복원

// 컨트롤 접기/펼치기
function paintHandle() {
  $('ctlGrid').classList.toggle('expanded', prefs.expanded);
  $('ctlHandle').textContent = prefs.expanded ? '▴ 접기' : '▾ 더보기';
  if (lay) drawTimeline();
}
$('ctlHandle').onclick = () => { prefs.expanded = !prefs.expanded; savePrefs(); paintHandle(); };
paintHandle();

// ── 표시(깃발): 추가 · 삭제 ───────────────────────────────────────
// Audipo식: 「추가」는 이름 묻지 않고 지금 자리(가장 가까운 카운트에 스냅)에 바로 찍는다.
// 동작이 들어가는 자리 같은 걸 빠르게 표시하는 용도. 두 개를 찍고 반복을 켜면 그 사이를 돈다.
$('btnFlagAdd').onclick = () => {
  if (!lay || !lay.counts.length) { toast('먼저 곡을 열어 주세요'); return; }
  let t = au.currentTime;
  const item = countAt(lay, t);
  if (item) t = Math.abs(t - item.time) < Math.abs(t - item.end) ? item.time : Math.min(item.end, map.song.duration - 1e-3);
  t = Math.min(Math.max(0, t), map.song.duration - 1e-3);
  if (markerNear(map.markers, t, 0.05)) { toast('이미 여기에 표시가 있어요'); return; }
  applyMap(withMarker(map, t, ''), `표시 추가 · ${fmtTime(t)}`);
};
$('btnFlagDel').onclick = () => {
  const m = markerNear(map.markers, au.currentTime, 2);
  if (!m) { toast('근처에 표시가 없어요 — 지울 표시 위로 가서 눌러 주세요'); return; }
  applyMap(withoutMarker(map, m.time), '표시 삭제 · ' + fmtTime(m.time));
};

// ── 시트 공통 ────────────────────────────────────────────────────
const SHEETS = ['infoSheet', 'speedSheet', 'settingsSheet'];
function openSheet(id) {
  for (const s of SHEETS) $(s).hidden = s !== id;
  $('dim').hidden = false;
}
function closeSheets() {
  for (const s of SHEETS) $(s).hidden = true;
  $('dim').hidden = true;
}
$('dim').onclick = closeSheets;

// ── 곡 정보 · 박자 보정 시트 (제목 탭) ───────────────────────────
function paintInfoStats() {
  const t = lay.totals, bpm = tempoBpm(map);
  const cell = (k, v, small) => `<div><div class="k">${k}</div><div class="v${small ? ' s' : ''}">${v}</div></div>`;
  $('infoStats').innerHTML =
    cell('BPM', bpm ?? '–') + cell('길이', fmtTime(map.song.duration)) +
    cell('프레이즈', t.fullPhrases) + cell('에이트', t.fullEights) +
    cell('카운트', lay.counts.length) + cell('프레이즈 길이', `에이트 ${map.phraseLen}개`, true);
}
function openInfoSheet() {
  if (!map) return;
  $('infoTitle').textContent = baseName(map.song.name);
  paintInfoStats();
  openSheet('infoSheet');
}
$('titleBox').onclick = openInfoSheet;
$('fxClose').onclick = closeSheets;
$('fxBack').onclick = () => applyMap(withOneShift(map, -1), '1을 한 박자 앞으로');
$('fxFwd').onclick = () => applyMap(withOneShift(map, 1), '1을 한 박자 뒤로');
$('fxSwap').onclick = () => applyMap(withOneFiveSwap(map), '1과 5를 바꿨어요');
// 「지금 이 순간이 1이에요」: 곡 첫 에이트 안(또는 1을 못 찾은 곡)이면 곡 전체의 1을 옮기고,
// 그 뒤라면 그 자리부터 다시 세는 구간 보정이다 — 앞부분 카운트는 그대로 남는다(codex 9/8 #1).
function fixOneHere() {
  const t = au.currentTime;
  const counts = lay.counts;
  if (!counts.length || t < counts[Math.min(7, counts.length - 1)].end) {
    applyMap(withOneAt(map, t), '좋아요 — 여기가 1이에요');
    return;
  }
  const next = withSectionOne(map, t);
  if (next === map) { applyMap(withOneAt(map, t), '좋아요 — 여기가 1이에요'); return; }
  applyMap(next, '좋아요 — 여기부터 1로 다시 세요');
}
$('fxHere').onclick = fixOneHere;
$('fxGlobalHere').onclick = () => applyMap(withOneAt(map, au.currentTime), '곡 전체의 1을 여기로 옮겼어요');
$('fxUndoSection').onclick = () => {
  const s = map.corrections.sectionOnes;
  if (!s.length) return;
  applyMap(withoutSectionOne(map, s[s.length - 1]), `${fmtTime(s[s.length - 1])}의 구간 보정을 취소했어요`);
};
for (const b of document.querySelectorAll('[data-plen]')) {
  b.onclick = () => applyMap(withPhraseLen(map, +b.dataset.plen), `프레이즈 = 에이트 ${b.dataset.plen}개`);
}
$('fxHalf').onclick = () => applyMap(withManualTempo(map, 'half'), '반 빠르기로 해석');
$('fxNormal').onclick = () => applyMap(withManualTempo(map, null), '기본 해석');
$('fxDouble').onclick = () => applyMap(withManualTempo(map, 'double'), '두 배 빠르기로 해석');

// ── 설정 시트: 지연 보정 · 두드려 재기 · 강세 방식 ───────────────
function paintLag() {
  $('lagScreen').value = lag.screen;
  $('lagClick').value = lag.click;
  $('lagScreenV').textContent = lag.screen + 'ms';
  $('lagClickV').textContent = lag.click + 'ms';
}
function saveLag() {
  try { localStorage.setItem('beatapp_lag_v1', JSON.stringify(lag)); } catch { /* private mode */ }
}
for (const which of ['Screen', 'Click']) {
  $('lag' + which).addEventListener('input', e => {
    lag[which.toLowerCase()] = +e.target.value;
    paintLag.touched = true;
    paintLag();
    saveLag();
  });
}
paintLag();
// 카운트음 크기 — 음악에 안 묻히게 사용자가 직접 키운다(못 듣는 초보의 최우선 레버)
function paintCueVol() { $('cueVol').value = prefs.cueVol; $('cueVolV').textContent = prefs.cueVol + '%'; }
$('cueVol').addEventListener('input', e => { prefs.cueVol = +e.target.value; savePrefs(); paintCueVol(); });
paintCueVol();
function paintAccentMethod() {
  $('accGain').classList.toggle('on', prefs.accentMethod === 'gain');
  $('accClick').classList.toggle('on', prefs.accentMethod === 'click');
}
$('accGain').onclick = () => { prefs.accentMethod = 'gain'; savePrefs(); paintAccentMethod(); };
$('accClick').onclick = () => { prefs.accentMethod = 'click'; savePrefs(); paintAccentMethod(); };
paintAccentMethod();
function openSettings() {
  paintLag();
  const L = audioCtx?.outputLatency;
  const el = $('autoLag');
  if (typeof L === 'number' && isFinite(L) && L > 0.005 && L < 0.5) {
    const ms = Math.round(L * 100) * 10;
    el.innerHTML = `이 기기가 알려준 소리 지연은 <b>${ms}ms</b>예요. <button id="useAuto" style="flex:none; font-size:12px; padding:4px 10px">이 값으로 맞추기</button>`;
    el.querySelector('#useAuto').onclick = () => { lag.screen = Math.min(300, ms); paintLag.touched = true; paintLag(); saveLag(); };
  } else {
    el.textContent = '이 기기는 소리 지연을 알려주지 않아요. 아래 「두드려 재기」를 쓰세요.';
  }
  openSheet('settingsSheet');
}
$('btnSettings').onclick = openSettings;
$('stClose').onclick = closeSheets;

// 학습 오버레이 진입/이탈 공통: 반복·연속재생·플레이어 보조음을 멈추고, 나올 때 자리를 다시 맞춘다.
function enterLearning() {
  learning = true;
  clearTimeout(countInTimer); countInTimer = null;
  engine.cancelPending();
  if (loopOn) setLoop(false);
  queue = []; queueIdx = -1;
  if (accentGain) { accentGain.gain.cancelScheduledValues(0); accentGain.gain.value = 1; }
  // 게임/청음은 게임 자신의 소리(카운트음·큐)만 낸다. 여기서 음악 그래프를 만들지 않는다.
}
function leaveLearning() {
  learning = false;
  engine.cancelPending();
  resync();
}

$('btnCalibrate').onclick = () => {
  if (!lay || !lay.counts.length) { toast('먼저 곡을 열어 주세요'); return; }
  closeSheets();
  switchTab('play');
  enterLearning();
  startCalibration({
    au,
    getLayout: () => lay,
    setRate: r => setSpeed(Math.round(r * 100), false),
    setScreenLag: ms => { lag.screen = ms; paintLag.touched = true; paintLag(); saveLag(); },
    silenceClicks: () => () => {}, // learning 플래그가 이미 카운트음·강세를 막는다
    onClose: leaveLearning,
  });
};

// ── 속도 ─────────────────────────────────────────────────────────
const PRESETS = [65, 70, 75, 80, 85, 90, 95, 100];
$('speedPresets').innerHTML = PRESETS.map(v => `<button data-sp="${v}">${v}</button>`).join('');
function setSpeed(pct, persist = true) {
  pct = Math.max(50, Math.min(100, pct));
  au.playbackRate = pct / 100;
  au.preservesPitch = true;
  au.webkitPreservesPitch = true;
  $('speed').value = pct;
  $('speedBig').innerHTML = `${pct}<span>%</span>`;
  $('speedLabel').textContent = pct + '%';
  for (const b of $('speedPresets').children) b.classList.toggle('on', +b.dataset.sp === pct);
  if (persist && map && map.rate !== pct / 100) applyMap({ ...map, rate: pct / 100 });
}
$('btnSpeed').onclick = () => openSheet('speedSheet');
$('spClose').onclick = closeSheets;
$('speed').addEventListener('input', e => setSpeed(+e.target.value));
for (const b of $('speedPresets').children) b.onclick = () => setSpeed(+b.dataset.sp);

window.addEventListener('resize', () => { if (lay) drawTimeline(); });
requestAnimationFrame(paintNow);

// ── 탭바 (재생 · 학습 · 목록) ─────────────────────────────────────
const PLAY_IDS = ['tlHead', 'timelineWrap', 'controls'];
function switchTab(name) {
  for (const el of document.querySelectorAll('.tab')) {
    el.classList.toggle('on', el.dataset.tab === name);
  }
  for (const id of PLAY_IDS) $(id).hidden = name !== 'play';
  $('hud').hidden = name !== 'play' || countMode === 0;
  $('learnView').hidden = name !== 'learn';
  $('listView').hidden = name !== 'list';
  if (name === 'list') renderList();
  if (name === 'learn') renderLearn();
  if (name === 'play' && lay) { drawTimeline(); lastRow = -1; }
}
for (const el of document.querySelectorAll('.tab')) {
  el.onclick = () => switchTab(el.dataset.tab);
}

// ── 목록: 선택 · 행 탭 = 재생 · 전체/선택 재생 · 박 찾는 중 ──────
async function renderList() {
  if ($('listView').hidden) return;
  const box = $('songList');
  const maps = listSongMaps();
  const stored = new Set(await listAudioKeys());
  if ($('listView').hidden) return; // 기다리는 사이 탭이 바뀌었다
  box.innerHTML = '';
  if (!maps.length && !analyzing.size) {
    box.innerHTML = '<div style="color:var(--t3); font-size:13px; padding:12px 14px">아직 준비된 곡이 없어요 — 「파일 추가」로 시작해요</div>';
  }
  for (const m of maps) {
    const key = songKey(m.song);
    const has = stored.has(key);
    const row = document.createElement('div');
    row.className = 'songRow' + (has ? '' : ' busy');
    const bpm = tempoBpm(m);
    // 파일이 기기에 없으면(저장 실패·브라우저가 지움) 흐리게가 아니라 이유를 적는다
    row.innerHTML = has
      ? `<div class="chk"></div><div class="nm"></div><div class="mt num r">${bpm ?? '–'}</div><div class="mt num r">${fmtTime(m.song.duration)}</div>`
      : `<div class="chk" style="opacity:.4"></div><div class="nm"></div><div class="busyTag">파일 다시 선택</div><div class="mt num r">${fmtTime(m.song.duration)}</div>`;
    row.querySelector('.nm').textContent = baseName(m.song.name);
    const chk = row.querySelector('.chk');
    const paintChk = () => { chk.classList.toggle('on', selected.has(key)); chk.textContent = selected.has(key) ? '✓' : ''; };
    paintChk();
    chk.onclick = e => { e.stopPropagation(); if (selected.has(key)) selected.delete(key); else selected.add(key); paintChk(); paintListActions(); };
    row.onclick = async () => {
      ensureCtx(); // 사용자 탭 안에서 오디오 컨텍스트를 만든다(iOS 제스처 규칙)
      if (!has) { toast('이 곡의 파일이 기기에 없어요 — 같은 파일을 다시 골라 주세요'); $('fileInput').click(); return; }
      if (!au.src) au.play().catch(() => {}); // 첫 재생은 사용자 탭 안에서 깨워 둔다(iOS 자동재생 규칙)
      queue = []; queueIdx = -1;
      const seq = ++openSeq;
      const blob = await loadAudio(key);
      if (seq !== openSeq || !blob) return;
      if (await openStored(m, blob, seq)) play();
    };
    box.appendChild(row);
  }
  for (const name of analyzing) {
    const row = document.createElement('div');
    row.className = 'songRow busy';
    row.innerHTML = `<div class="chk" style="opacity:.4"></div><div class="nm"></div><div class="busyTag"><div class="spin"></div>박자 찾는 중</div><div class="mt num r"></div>`;
    row.querySelector('.nm').textContent = baseName(name);
    box.appendChild(row);
  }
  paintListActions();
}
function paintListActions() {
  const n = selected.size;
  $('btnPlaySel').textContent = n ? `선택 ${n}곡 재생` : '선택 재생';
  $('btnPlaySel').disabled = n === 0;
}
async function playQueued(i) {
  queueIdx = i;
  const m = queue[i];
  const seq = ++openSeq;
  const blob = await loadAudio(songKey(m.song));
  if (seq !== openSeq) return;
  if (!blob) { toast(`「${baseName(m.song.name)}」 파일이 없어 건너뛰어요`); if (i + 1 < queue.length) playQueued(i + 1); return; }
  if (await openStored(m, blob, seq)) {
    toast(`${i + 1}/${queue.length} · ${baseName(m.song.name)}`);
    play();
  }
}
async function startQueue(maps) {
  if (!maps.length) { toast('재생할 곡이 없어요'); return; }
  ensureCtx();
  if (!au.src) au.play().catch(() => {});
  const stored = new Set(await listAudioKeys());
  queue = maps.filter(m => stored.has(songKey(m.song)));
  if (!queue.length) { toast('저장된 곡 파일이 없어요 — 「파일 추가」로 다시 넣어 주세요'); return; }
  if (loopOn) setLoop(false);
  playQueued(0);
}
$('btnPlayAll').onclick = () => startQueue(listSongMaps());
$('btnPlaySel').onclick = () => startQueue(listSongMaps().filter(m => selected.has(songKey(m.song))));

// ── 학습 탭 ──────────────────────────────────────────────────────
function renderLearn() {
  const r = lastResults();
  const row = (k, v) => `<div class="recRow"><div>${k}</div><div class="v num">${v}</div></div>`;
  const tapText = !r.tap ? '기록 없음'
    : r.tap.meanMs === null || r.tap.meanMs === undefined ? '맞힌 박 없음'
    : Math.abs(r.tap.meanMs) <= 8 ? '평균 정확' : `평균 ${describeTiming(r.tap.meanMs)}`;
  $('lastResults').innerHTML =
    row('청음', r.listening ? `${r.listening.correct} / ${r.listening.total} 맞음` : '기록 없음') +
    row('박자 맞추기', tapText) +
    row('5·6·7·8 들어가기', r.intro ? `${r.intro.hits} / ${r.intro.total} 성공` : '기록 없음');
}
function needSong() {
  if (!lay || !lay.counts.length) { toast('먼저 재생 탭에서 곡을 열어 주세요'); return false; }
  return true;
}
const getRate = () => au.playbackRate || 1;
// 귀에 들리는 음악 시각. lag.screen은 벽시계 ms이고 currentTime은 배속으로 흐르므로
// 음악 시간으로는 lag × rate 만큼 앞서 있다(reviewer 9/8 M4).
const heardTime = () => au.currentTime - lag.screen / 1000 * getRate();
// 5·6·7·8 준비음: 음악 시계(currentTime) 기준으로 예약한다 — 화면 지연은 눈의 몫이지 소리의 몫이 아니다.
function cueClickFor(levelId) {
  if (levelId !== 'intro') return null;
  return (musicTime, count) => {
    const ctx = ensureCtx();
    const when = ctx.currentTime + (musicTime - au.currentTime) / getRate() + lag.click / 1000;
    engine.clickAt(when, count === 5 ? 1 : 2, 0.7);
  };
}
function recordGame(levelId, st) {
  if (!st) return;
  if (levelId === 'intro' || levelId === 'five') {
    recordResult('intro', { hits: st.perfect + st.good, total: st.total, meanMs: st.meanMs });
  } else {
    recordResult('tap', { meanMs: st.meanMs, sdMs: st.sdMs, accuracy: st.accuracy, level: levelId });
  }
}
function launchGame(levelId) {
  if (!needSong()) return;
  enterLearning();
  startGame({
    levelId, counts: lay.counts, au,
    getHeardTime: heardTime, getRate,
    cueClick: cueClickFor(levelId),
    onExit: (why, level, st) => {
      recordGame(level, st);
      if (why === 'retry') { launchGame(level); return; }
      leaveLearning();
      switchTab('learn');
    },
  });
}
for (const el of document.querySelectorAll('#learnView [data-level]')) {
  el.onclick = () => launchGame(el.dataset.level);
}

// 1 찾기 / 혼자 이어가기(토대) — "어디가 1인지 못 잡겠다"는 초보용. 점수 없이 몸에 붙인다.
// ⚠️ 한 구간 반복은 "그 멜로디 외우기"가 되어 실력이 안 는다(사용자 지적) → 곡 전체를 지나간다.
// 1 찾기는 힌트를 껐다 켤 수 있다: 켜면 앱이 1을 짚어 주고, 끄면 음악만 듣고 스스로 찾는다.
function launchBounce(mode) {
  if (!needSong()) return;
  enterLearning();
  startBounce({
    mode, counts: lay.counts, au, ensureCtx,
    clickAt: engine.clickAt, kick: engine.kick, cancelClicks: engine.cancelPending,
    getHeardTime: heardTime, getRate,
    setRate: r => setSpeed(Math.round(r * 100), false),
    title: mode === 'find' ? '박자 잡기' : '혼자 이어가기',
    onExit: () => { leaveLearning(); switchTab('learn'); },
  });
}
$('btnFind').onclick = () => launchBounce('find');
$('btnGap').onclick = () => launchBounce('gap');

// 청음. onDone(score|null) 안에서 leaveLearning은 호출자가 한다(테스트 흐름은 이어서 게임으로 간다).
// teach=true면 문제 전에 가르침 화면(맞는 소리·어긋난 소리 시범)을 먼저 보여준다.
function launchListening(n, onDone, teach = false) {
  if (!needSong()) return false;
  let questions;
  try { questions = makeListeningQuiz(lay.counts, n); } catch (err) { toast(err.message); return false; }
  enterLearning();
  startListening({
    questions, demo: teach ? demoPair(lay.counts) : null,
    au, ensureCtx,
    clickAt: engine.clickAt, cancelClicks: engine.cancelPending, lagClickMs: lag.click,
    samples, sr: MODEL_SR,
    onDone,
  });
  return true;
}
$('btnListen').onclick = () => launchListening(10, score => {
  if (score) { recordResult('listening', score); toast(`청음 ${score.correct} / ${score.total} 맞음`); }
  leaveLearning();
  switchTab('learn');
}, true); // 연습 청음은 가르침부터

// 박자 테스트 = 청음 8문제 → 박자 맞추기 16박(한 창) → 결과 화면(시안 10)
function runBeatTest() {
  if (!needSong()) return;
  launchListening(8, listening => {
    if (!listening) { leaveLearning(); switchTab('learn'); return; }
    recordResult('listening', listening);
    const wins = fullWindows(lay.counts, 16);
    if (!wins.length) { toast('이 곡에는 온전한 16박 구간이 없어요'); showResult(listening, null); return; }
    const win = pickWindow(wins);
    const runTap = () => {
      startGame({
        levelId: 'all', counts: lay.counts, au, from: win.start, limit: 16, title: '박자 맞추기',
        getHeardTime: heardTime, getRate, cueClick: null,
        onExit: (why, level, st) => {
          if (why === 'retry') { runTap(); return; }
          if (st) recordResult('tap', { meanMs: st.meanMs, sdMs: st.sdMs, accuracy: st.accuracy, level: 'test' });
          showResult(listening, st);
        },
      });
    };
    runTap();
  });
}
$('btnTest').onclick = runBeatTest;

function showResult(listening, st) {
  const root = $('resultView');
  const d = suggestDefaults({ listening, tap: st });
  const tapLine = st
    ? `16박 중 맞음 ${st.perfect + st.good} · 놓침 ${st.miss}` : '기록 없음';
  root.innerHTML = `
    <div class="ovTop"><button class="ovClose" id="rsClose">✕</button><div class="ovTitle">박자 테스트 결과</div><div class="ovRight"></div></div>
    <div class="rsStats">
      <div class="rsStat"><div class="k">청음</div><div class="v num">${listening.correct} / ${listening.total}</div><div class="s">${listening.missed.length ? `틀린 문제 ${listening.missed.length} · 다시 들어 보면 좋아요` : '전부 맞았어요'}</div></div>
      <div class="rsStat"><div class="k">박자 맞추기 · 평균</div><div class="v num">${st && st.meanMs !== null ? describeTiming(st.meanMs) : '–'}</div><div class="s">${tapLine}</div></div>
      <div class="rsStat"><div class="k">박자 맞추기 · 흔들림</div><div class="v num">${st && st.sdMs !== null ? '±' + st.sdMs + 'ms' : '–'}</div><div class="s">탭 간격이 고른 정도</div></div>
    </div>
    <div class="rsDefault"><div class="k">재생 화면 기본값</div><div class="v">${d.text}</div></div>
    <div class="rsBtns"><button id="rsRetry">다시</button><button class="primary" id="rsDone">학습으로</button></div>`;
  root.hidden = false;
  const close = () => { root.hidden = true; root.innerHTML = ''; };
  const finish = () => {
    close();
    leaveLearning();
    setCountMode(d.countMode); setClick(d.click); setAccent(d.accent);
    switchTab('learn');
  };
  root.querySelector('#rsDone').onclick = finish;
  root.querySelector('#rsClose').onclick = finish;
  root.querySelector('#rsRetry').onclick = () => { close(); leaveLearning(); runBeatTest(); };
}

// ── 저장된 곡 즉시 열기 + 마지막 곡 자동 복원 ────────────────────
// seq = 이 열기 요청의 번호. 디코딩하는 사이 더 새 요청이 생겼으면 화면을 바꾸지 않는다.
async function openStored(m, blob, seq = ++openSeq) {
  const progress = t => { if (seq === openSeq) $('progress').textContent = t; };
  try {
    progress('이어서 여는 중…');
    const { samples: pcm } = await decodeToModelRate(blob);
    if (seq !== openSeq) return false;
    mountSong(m, pcm, blob);
    progress('');
    return true;
  } catch (err) {
    progress('');
    toast('여는 데 실패했어요: ' + (err?.message || err));
    return false;
  }
}

async function restoreLastSong() {
  let key = null;
  try { key = localStorage.getItem(LAST_SONG); } catch { return; }
  if (!key) return;
  const m = listSongMaps().find(x => songKey(x.song) === key);
  if (!m) return;
  const seq = ++openSeq;
  const blob = await loadAudio(key);
  if (!blob || seq !== openSeq) return; // 그새 사용자가 다른 곡을 골랐다
  const ok = await openStored(m, blob, seq);
  if (ok) toast('이어서: ' + baseName(m.song.name));
}
requestPersistence();
restoreLastSong();
