// 박자 맞추기 게임 화면. 노트 = 카운트 숫자가 박힌 원이 판정선으로 떨어진다.
// 판정·통계는 core/learn/judge.js(순수·테스트됨)가 담당하고, 여기는 그리기와
// 입력만 한다. 시각 기준은 「귀에 들리는 시각」(재생 위치 − 화면 지연).
// 「5·6·7·8 들어가기」 레벨은 5~8이 유령 노트+카운트음으로 지나가고 1만 잡는다
// — 5678은 준비 신호, 출발은 1이라는 스윙의 규칙을 게임이 직접 가르친다.
// 박자 테스트는 from/limit으로 한 창(16박)만 친다. 끝나면 onExit(why, levelId, stats).
import {
  makeChart, createGameState, judgeTap, sweepMisses, gameStats, LEVELS,
} from '../core/learn/judge.js';

const APPROACH = 1.8; // 노트가 화면 위에서 판정선까지 내려오는 음악 시간(초)

export function startGame({ levelId, counts, au, getHeardTime, getRate = () => 1, cueClick, onExit, from, limit, title }) {
  const level = LEVELS.find(l => l.id === levelId);
  const chart = makeChart(counts, levelId, { from, limit });
  const state = createGameState(chart);
  const lastNote = chart.length ? chart[chart.length - 1].time : 0;
  const ghosts = level.cues
    ? counts.filter(c => c.count >= 5 && c.time <= lastNote && (from === undefined || c.time >= from - 2))
    : [];
  const root = document.getElementById('gameView');
  root.innerHTML = `
    <div id="gameTop">
      <button id="gameExit">✕</button>
      <div id="gameLevel">${title ?? level.name}</div>
      <div id="gameCombo"></div>
    </div>
    <canvas id="gameCanvas"></canvas>
    <div id="gameResult" hidden></div>`;
  root.hidden = false;

  const canvas = root.querySelector('#gameCanvas');
  const comboEl = root.querySelector('#gameCombo');
  const dpr = window.devicePixelRatio || 1;
  let W = 0, H = 0, LINE = 0;
  function resize() {
    W = root.clientWidth; H = root.clientHeight - 56;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const g2 = canvas.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    LINE = H * 0.76;
  }
  resize();
  window.addEventListener('resize', resize);

  const g = canvas.getContext('2d');
  const pops = [];   // 판정 글자
  const bursts = []; // 히트 터짐 효과
  let running = true, ended = false;
  let beatPtr = 0, cuePtr = 0;

  function pop(text, color) {
    pops.push({ text, color, born: performance.now() });
    if (pops.length > 6) pops.shift();
  }

  function tap() {
    if (!running || ended) return;
    const res = judgeTap(state, getHeardTime(), getRate()); // 느린 재생도 실제 시간으로 판정
    if (!res) return;
    const perfect = res.judgment === 'perfect';
    bursts.push({ born: performance.now(), color: perfect ? '#ffd644' : '#c9cdd6' });
    if (perfect) pop('정확!', '#ffd644');
    else pop(res.diffMs > 0 ? '조금 늦었어요' : '조금 빨랐어요', '#c9cdd6');
  }
  canvas.addEventListener('pointerdown', tap);

  function noteStyle(count) {
    if (count === 1) return { r: 27, fill: '#ffd644', font: 22 };
    if (count === 5) return { r: 24, fill: '#ffffff', font: 19 }; // 귀로 잡는 5
    return { r: 21, fill: count % 2 === 0 ? '#c9cdd6' : '#8f929b', font: 17 };
  }

  function drawFrame() {
    if (!running) return;
    const now = performance.now();
    const heard = getHeardTime();
    for (const m of sweepMisses(state, heard, getRate())) void m, pop('놓침', '#5a5e68');

    // 현재 박 위치 추적 (박 맥동·1~8 표시용)
    while (beatPtr < counts.length - 1 && counts[beatPtr + 1].time <= heard) beatPtr++;
    const cur = counts[beatPtr];
    const next = counts[beatPtr + 1];
    const beatPhase = cur && next && heard >= cur.time
      ? Math.min(1, (heard - cur.time) / (next.time - cur.time)) : 1;

    // 5·6·7·8 카운트음 예약 (들어가기 레벨)
    if (cueClick) {
      const horizon = heard + 0.2;
      while (cuePtr < ghosts.length && ghosts[cuePtr].time < horizon) {
        if (ghosts[cuePtr].time >= heard - 0.01) cueClick(ghosts[cuePtr].time, ghosts[cuePtr].count);
        cuePtr++;
      }
    }

    g.clearRect(0, 0, W, H);

    // 상단 1~8 자리 표시 — 지금 곡이 에이트의 어디를 지나는지 늘 보인다
    if (cur) {
      const dotGap = Math.min(40, (W - 48) / 8);
      const x0 = W / 2 - dotGap * 3.5;
      for (let n = 1; n <= 8; n++) {
        const active = cur.count === n;
        g.beginPath();
        g.arc(x0 + (n - 1) * dotGap, 30, active ? (n === 1 ? 11 : 9) : 5, 0, Math.PI * 2);
        g.fillStyle = active ? (n === 1 ? '#ffd644' : '#ffffff') : '#3a3f4a';
        g.fill();
        if (active) {
          g.fillStyle = '#16181d';
          g.font = '800 11px system-ui';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(n, x0 + (n - 1) * dotGap, 31);
        }
      }
    }

    // 판정선 + 박에 맞춰 맥동하는 링
    g.strokeStyle = '#3a3f4a';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(24, LINE); g.lineTo(W - 24, LINE); g.stroke();
    const pulse = 1 + 0.16 * Math.max(0, 1 - beatPhase * 2.6);
    g.strokeStyle = '#ffd644';
    g.lineWidth = 2 + 2 * Math.max(0, 1 - beatPhase * 2.6);
    g.beginPath(); g.arc(W / 2, LINE, 34 * pulse, 0, Math.PI * 2); g.stroke();

    // 히트 터짐
    for (const b of bursts) {
      const age = (now - b.born) / 420;
      if (age > 1) continue;
      g.globalAlpha = 1 - age;
      g.strokeStyle = b.color;
      g.lineWidth = 3 * (1 - age);
      g.beginPath(); g.arc(W / 2, LINE, 34 + age * 52, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }

    // 유령 노트(5·6·7·8) — 잡는 게 아니라 지나가는 신호
    for (const c of ghosts) {
      const dt = c.time - heard;
      if (dt < -0.05 || dt > APPROACH) continue;
      const y = LINE * (1 - dt / APPROACH);
      g.globalAlpha = 0.45;
      g.fillStyle = '#8f929b';
      g.beginPath(); g.arc(W / 2, y, 15, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#16181d';
      g.font = '700 13px system-ui';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(c.count, W / 2, y + 1);
      g.globalAlpha = 1;
    }

    // 진짜 노트 — 가까워질수록 커진다
    for (let i = 0; i < chart.length; i++) {
      if (state.hit[i]) continue;
      const dt = chart[i].time - heard;
      if (dt < -0.12 || dt > APPROACH) continue;
      const y = LINE * (1 - dt / APPROACH);
      const st = noteStyle(chart[i].count);
      const grow = 0.82 + 0.18 * (1 - dt / APPROACH);
      g.fillStyle = st.fill;
      g.beginPath(); g.arc(W / 2, y, st.r * grow, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#16181d';
      g.font = `800 ${Math.round(st.font * grow)}px system-ui`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(chart[i].count, W / 2, y + 1);
    }

    // 판정 팝
    for (const p of pops) {
      const age = (now - p.born) / 700;
      if (age > 1) continue;
      g.globalAlpha = 1 - age;
      g.fillStyle = p.color;
      g.font = '700 22px system-ui';
      g.textAlign = 'center';
      g.fillText(p.text, W / 2, LINE - 62 - age * 28);
      g.globalAlpha = 1;
    }

    comboEl.textContent = state.combo >= 2 ? state.combo + ' 콤보' : '';
    comboEl.style.color = state.combo >= 8 ? '#ffd644' : '#c9cdd6';
    if (!ended && (au.ended || heard > lastNote + 1)) { ended = true; finish(); }
    requestAnimationFrame(drawFrame);
  }

  function grade(st) {
    if (st.miss === 0 && st.accuracy >= 0.95) return 'S';
    if (st.accuracy >= 0.9) return 'A';
    if (st.accuracy >= 0.75) return 'B';
    return 'C';
  }

  function finish() {
    au.pause();
    const st = gameStats(state);
    const timing = st.meanMs === null ? ''
      : st.meanMs > 8 ? `평균 ${st.meanMs}ms 늦게 쳤어요`
      : st.meanMs < -8 ? `평균 ${-st.meanMs}ms 빠르게 쳤어요`
      : '타이밍이 정확해요';
    const panel = root.querySelector('#gameResult');
    panel.innerHTML = `
      <div class="rTitle">${title ?? level.name} 결과</div>
      <div class="rBig">${grade(st)}</div>
      <div class="rLine">${Math.round(st.accuracy * 100)}% · 정확 ${st.perfect} · 좋음 ${st.good} · 놓침 ${st.miss}</div>
      <div class="rLine">${timing}${st.sdMs !== null ? ` · 흔들림 ±${st.sdMs}ms` : ''}</div>
      <div class="rLine">최대 ${st.maxCombo}콤보</div>
      <div class="row" style="margin-top:14px">
        <button id="gameRetry">다시</button><button id="gameDone">끝내기</button>
      </div>`;
    panel.hidden = false;
    panel.querySelector('#gameRetry').onclick = () => { cleanup(); onExit('retry', levelId, st); };
    panel.querySelector('#gameDone').onclick = () => { cleanup(); onExit('done', levelId, st); };
  }

  function cleanup() {
    running = false;
    window.removeEventListener('resize', resize);
    root.hidden = true;
    root.innerHTML = '';
  }
  root.querySelector('#gameExit').onclick = () => { au.pause(); cleanup(); onExit('quit', levelId, null); };

  // 첫 노트 2초 전부터 재생. 자동재생이 막히면(iOS 제스처 규칙) 화면을 탭해 시작한다.
  au.currentTime = Math.max(0, (chart[0]?.time ?? 0) - 2);
  au.play().catch(() => {
    pop('화면을 탭하면 시작해요', '#c9cdd6');
    canvas.addEventListener('pointerdown', () => { if (au.paused && !ended) au.play().catch(() => {}); }, { once: true });
  });
  requestAnimationFrame(drawFrame);
  return { stop: cleanup };
}
