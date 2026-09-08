// 1 찾기 / 혼자 이어가기 — "어디가 1인지 못 잡겠다"는 초보용(사용자 9/8).
// ⚠️ 한 구간 반복은 "그 멜로디 외우기"가 되어 실력이 안 는다(사용자 지적, 정확함).
// 그래서 곡 전체를 지나가며(계속 새 자료) 하고, 힌트를 껐다 켤 수 있게 한다:
//   힌트 켬 → 앱이 1을 노란 큰 공+큰 소리로 짚어 준다(1이 어떤 소리·느낌인지 익힌다).
//   힌트 끔 → 소리 표시가 사라진다. 음악만 듣고 1이라고 느낄 때 눌러서 스스로 찾는다(진짜 실력).
// 근거: 가변 연습이 전이에 유리(Shea&Morgan), 자기조절 피드백(원할 때 힌트 on/off)이 파지에 유리.
// 용어는 "박자/카운트"만 쓴다.
import { countAt } from '../core/analysis/analyze.js';

const FIND_RATE = 0.85; // 기본만 살짝 느리게 — 나머지는 화면 안 속도 조절로 사용자가 정한다
const GAP_RATE = 0.85;
const GAP_ON = 8, GAP_OFF = 8;

export function startBounce({
  mode, counts, au, ensureCtx, clickAt, cancelClicks, getHeardTime, getRate, setRate, onExit, title,
}) {
  const root = document.getElementById('bounceView');
  const gap = mode === 'gap';
  const firstBeat = counts[0]?.time ?? 0;
  const lastBeat = counts.length ? counts[counts.length - 1].time : 0;
  let closed = false, hits = [], hint = true;
  let clickState = { nextIdx: 0 };

  root.innerHTML = `
    <div class="ovTop">
      <button class="ovClose" id="bnExit">✕</button>
      <div class="ovTitle">${title}</div>
      <div class="ovRight"></div>
    </div>
    <div class="bnHint" id="bnHint"></div>
    <div class="bnSpeed">
      <button id="bnSlow" aria-label="느리게">−</button>
      <div><span id="bnSpeedV" class="num">85%</span><div class="bnSpeedLbl">속도</div></div>
      <button id="bnFast" aria-label="빠르게">+</button>
    </div>
    ${gap ? '' : '<button class="lsDemo" id="bnToggle" style="max-width:260px; margin:6px auto 0; height:44px; font-size:15px"></button>'}
    <div class="bnStrip" id="bnStrip"></div>
    <canvas id="bnCanvas"></canvas>
    <div class="bnTapHint">${gap ? '소리가 없는 동안에도 계속 세세요' : '1이라고 느낄 때 화면을 누르세요'}</div>`;
  root.hidden = false;
  const $ = id => root.querySelector('#' + id);

  $('bnStrip').innerHTML = Array.from({ length: 8 }, (_, k) =>
    `<div class="bnDot${k === 0 ? ' one' : k === 4 ? ' five' : ''}" data-n="${k + 1}">${k + 1}</div>`).join('');
  const dots = [...$('bnStrip').children];

  function paintHint() {
    if (gap) {
      $('bnHint').innerHTML = '소리가 <b>사라져도</b> 같은 박자로 계속 세세요. 돌아올 때 맞는지 봐요.';
      return;
    }
    $('bnHint').innerHTML = hint
      ? '<b style="color:#ffd644">노란 큰 공 = 1</b> (여덟 카운트의 시작). 어떤 소리·느낌인지 익혀 보세요.'
      : '이제 <b>혼자</b> — 음악만 듣고 1이라고 느낄 때 눌러요. 맞았는지 알려줄게요.';
    if ($('bnToggle')) $('bnToggle').textContent = hint ? '힌트 끄고 혼자 찾기 →' : '← 힌트 다시 켜기';
    $('bnStrip').style.visibility = hint ? 'visible' : 'hidden'; // 힌트 끄면 자리표시도 숨긴다(1 노출 방지)
  }
  if (!gap) $('bnToggle').onclick = () => { hint = !hint; paintHint(); };
  paintHint();

  // 속도 조절 — 곡 안에서 바로 반영(음정 유지). 나갈 때 원래 속도로 복원.
  let curRate = gap ? GAP_RATE : FIND_RATE;
  function paintSpeed() { $('bnSpeedV').textContent = Math.round(curRate * 100) + '%'; }
  function bumpSpeed(d) {
    curRate = Math.max(0.5, Math.min(1.0, Math.round((curRate + d) * 20) / 20));
    setRate(curRate);
    paintSpeed();
  }
  $('bnSlow').onclick = () => bumpSpeed(-0.05);
  $('bnFast').onclick = () => bumpSpeed(0.05);
  paintSpeed();

  const canvas = $('bnCanvas');
  const dpr = window.devicePixelRatio || 1;
  let W = 0, H = 0, FLOOR = 0;
  function resize() {
    W = root.clientWidth; H = root.clientHeight - (gap ? 210 : 260);
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    FLOOR = H * 0.8;
  }
  resize();
  window.addEventListener('resize', resize);
  const g = canvas.getContext('2d');

  function audibleAt(idx) { return gap ? Math.floor(idx / GAP_ON) % 2 === 0 : hint; }
  function ballStyle(count) {
    // 힌트 끔(find)이면 어느 게 1인지 숨겨야 하므로 전부 같은 회색 공(펄스만).
    if (!gap && !hint) return { r: Math.min(36, W * 0.095), fill: '#8f929b' };
    if (count === 1) return { r: Math.min(52, W * 0.14), fill: '#ffd644' };
    if (count === 5) return { r: Math.min(42, W * 0.11), fill: '#ffffff' };
    return { r: Math.min(32, W * 0.085), fill: '#8f929b' };
  }

  function nearestBeatIndex(t) {
    let lo = 0, hi = counts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (counts[m].time <= t) lo = m + 1; else hi = m; }
    const a = lo - 1, b = lo;
    if (a < 0) return 0;
    if (b >= counts.length) return counts.length - 1;
    return (t - counts[a].time) <= (counts[b].time - t) ? a : b;
  }

  function tap() {
    if (closed) return;
    const t = getHeardTime();
    const i = nearestBeatIndex(t);
    const c = counts[i];
    const diff = Math.abs(t - c.time) / getRate() * 1000;
    const onBeat = diff <= 150;
    // find+힌트끔: "1을 맞혔나"가 핵심. gap/힌트켬: 그냥 박자 맞췄나.
    const good = (!gap && !hint) ? (onBeat && c.count === 1) : onBeat;
    let msg = '';
    if (!gap && !hint) {
      if (onBeat && c.count === 1) msg = '1 맞아요! 👍';
      else if (onBeat) msg = `${c.count}번이에요 · 1은 아니에요`;
      else msg = '';
    }
    hits.push({ born: performance.now(), good, count: c.count, msg });
    if (hits.length > 5) hits.shift();
  }
  canvas.addEventListener('pointerdown', tap);

  function scheduleClicks() {
    if (closed || au.paused) return;
    const ctx = ensureCtx();
    const rate = getRate();
    const now = au.currentTime, horizon = now + 0.15 * rate;
    while (clickState.nextIdx < counts.length && counts[clickState.nextIdx].time < horizon) {
      const c = counts[clickState.nextIdx];
      const idx = clickState.nextIdx;
      if (c.time >= now - 0.01 && audibleAt(idx)) {
        const when = ctx.currentTime + (c.time - now) / rate;
        const lvl = c.count === 1 ? 0 : c.count === 5 ? 1 : 2;
        const vol = c.count === 1 ? 1.0 : c.count === 5 ? 0.8 : 0.35;
        clickAt(when, lvl, vol);
      }
      clickState.nextIdx += 1;
    }
  }
  const clickTimer = setInterval(scheduleClicks, 25);

  function toStart() { au.currentTime = Math.max(0, firstBeat - 1); clickState.nextIdx = 0; }

  function draw() {
    if (closed) return;
    const heard = getHeardTime();
    const now = performance.now();
    if (heard > lastBeat + 1 || au.ended) { toStart(); requestAnimationFrame(draw); return; }
    g.clearRect(0, 0, W, H);

    let i = nearestBeatIndex(heard);
    if (counts[i] && counts[i].time > heard && i > 0) i -= 1;
    const cur = counts[i], next = counts[i + 1];
    let p = 0;
    if (cur && next && heard >= cur.time) p = Math.min(1, Math.max(0, (heard - cur.time) / (next.time - cur.time)));
    const audible = audibleAt(i);

    dots.forEach((d, k) => d.classList.toggle('on', !!cur && cur.count === k + 1));

    if (gap) {
      g.fillStyle = audible ? 'rgba(255,214,68,0.08)' : 'rgba(90,94,104,0.16)';
      g.fillRect(0, 0, W, H);
      g.fillStyle = audible ? '#ffd644' : '#8f929b';
      g.font = '700 14px system-ui'; g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText(audible ? '소리 켬 — 같이 세요' : '혼자 — 소리 없이 이어가세요', W / 2, 8);
    }

    g.strokeStyle = '#3a3f4a'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(24, FLOOR); g.lineTo(W - 24, FLOOR); g.stroke();

    const st = cur ? ballStyle(cur.count) : { r: 32, fill: '#8f929b' };
    const marked = (audible || !gap) && (gap || hint) && cur && cur.count === 1;
    const hitPhase = Math.max(0, 1 - p * 3);
    if (hitPhase > 0) {
      g.strokeStyle = (marked ? 'rgba(255,214,68,' : 'rgba(201,205,214,') + hitPhase + ')';
      g.lineWidth = 3;
      g.beginPath(); g.arc(W / 2, FLOOR, st.r + (1 - hitPhase) * (marked ? 90 : 50), 0, Math.PI * 2); g.stroke();
    }
    const amp = FLOOR * 0.6;
    const y = FLOOR - amp * Math.sin(Math.PI * p);
    const r = st.r + 6 * Math.max(0, 1 - p * 4);
    g.beginPath(); g.arc(W / 2, y, r, 0, Math.PI * 2);
    g.fillStyle = gap && !audible ? '#5a5e68' : st.fill;
    g.fill();
    if (cur && (gap || hint)) { // 힌트 끔이면 숫자도 숨긴다(1 노출 방지)
      g.fillStyle = '#16181d';
      g.font = `800 ${Math.round(r * 0.95)}px system-ui`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(cur.count, W / 2, y + 1);
    }

    for (const h of hits) {
      const age = (now - h.born) / 600;
      if (age > 1) continue;
      g.globalAlpha = 1 - age;
      g.strokeStyle = h.good ? '#ffd644' : '#5a5e68';
      g.lineWidth = 3 * (1 - age);
      g.beginPath(); g.arc(W / 2, FLOOR, 30 + age * 44, 0, Math.PI * 2); g.stroke();
      if (h.msg) {
        g.fillStyle = h.good ? '#ffd644' : '#c9cdd6';
        g.font = '700 20px system-ui'; g.textAlign = 'center';
        g.fillText(h.msg, W / 2, FLOOR - 70 - age * 24);
      }
      g.globalAlpha = 1;
    }

    requestAnimationFrame(draw);
  }

  function cleanup() {
    closed = true;
    clearInterval(clickTimer);
    window.removeEventListener('resize', resize);
    cancelClicks();
    au.pause();
    setRate(prevRate);
    root.hidden = true;
    root.innerHTML = '';
  }
  $('bnExit').onclick = () => { cleanup(); onExit(); };

  const prevRate = getRate();
  setRate(gap ? GAP_RATE : FIND_RATE);
  toStart();
  au.play().catch(() => {
    $('bnHint').innerHTML = '화면을 한 번 누르면 시작해요';
    canvas.addEventListener('pointerdown', () => { if (au.paused && !closed) au.play().catch(() => {}); }, { once: true });
  });
  requestAnimationFrame(draw);
  return { stop: cleanup };
}
