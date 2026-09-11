// 1 찾기 / 혼자 이어가기 — "어디가 1인지 못 잡겠다"는 초보용(사용자 9/8).
// ⚠️ 한 구간 반복은 "그 멜로디 외우기"가 되어 실력이 안 는다(사용자 지적, 정확함).
// 그래서 곡 전체를 지나가며(계속 새 자료) 하고, 힌트를 껐다 켤 수 있게 한다:
//   힌트 켬 → 앱이 1을 노란 큰 공+큰 소리로 짚어 준다(1이 어떤 소리·느낌인지 익힌다).
//   힌트 끔 → 소리 표시가 사라진다. 음악만 듣고 1이라고 느낄 때 눌러서 스스로 찾는다(진짜 실력).
// 확인 라운드(9/9, codex 대조) → "잘되는지 모르겠다"에 답하려고 채점을 남긴다:
//   공(박자 큐)과 소리 힌트, 실시간 정답 피드백을 잠깐 걷고, 음악만 듣고 1을 N번 찾게 한 뒤
//   끝나면 "지나온 1 N번 중 Y번 맞힘 · 다른 박 A번 · 놓침 M번"으로 요약한다. 세션 안 비교만.
//   ※ "우연 X%" 같은 확률선은 안 쓴다 — 자유 탭이라 균등 추측이 아니고 시간오차도 함께 채점하니
//     통계적으로 틀린 기준이다(codex 지적, 채택). 정답표는 앱이 자동으로 잡은 1이라 곡에 따라 틀릴 수 있다.
// 근거: 가변 연습이 전이에 유리(Shea&Morgan), 자기조절 피드백(원할 때 힌트 on/off)이 파지에 유리.
// 용어는 "박자/카운트"만 쓴다.
import { countAt } from '../core/analysis/analyze.js';

// 기본 100% (2026-09-12 사용자: 85%에서 '느려져서 노이즈 낀 느낌, 정상인지 틀린지 모르겠다'). 학습 중엔 음정유지를
// 끄므로 느리게 하면 소리가 낮고 거칠어지는데, 그게 기본이면 앱이 고장난 것처럼 들린다. 느리게는 사용자가 고른다.
const FIND_RATE = 1.0;
const GAP_RATE = 1.0;
const GAP_ON = 8, GAP_OFF = 8;
const CHECK_N = 4;       // 확인 라운드에서 찾을 1의 개수(짧고 반복 가능하게)
const WIN_MS = 150;      // 박자 판정창(게임의 더 좁은 창은 안 가져온다 — codex 권고)

export function startBounce({
  mode, counts, au, ensureCtx, clickAt, kick, cancelClicks, getHeardTime, getRate, setRate, onExit, title,
}) {
  const root = document.getElementById('bounceView');
  const gap = mode === 'gap';
  const firstBeat = counts[0]?.time ?? 0;
  const lastBeat = counts.length ? counts[counts.length - 1].time : 0;
  let closed = false, hits = [], hint = true;
  let clickState = { nextIdx: 0 };

  // 확인 라운드 상태
  let checking = false;
  let checkTaps = [];
  let targetOnes = [];            // 이번 라운드에서 찾을 count===1 박자들의 counts 인덱스
  let targetOneIdx = new Set();
  let checkStartHeard = 0, checkEndTime = 0, checkRate = null;
  let lastCheck = null;           // 직전 라운드 결과(같은 속도일 때만 비교)

  root.innerHTML = `
    <div class="ovTop">
      <button class="ovClose" id="bnExit">✕</button>
      <div class="ovTitle">${title}</div>
      <div class="ovRight"></div>
    </div>
    <div class="bnHint" id="bnHint"></div>
    <div id="bnSpeedLblNote" style="text-align:center; font-size:12px; color:var(--t2); min-height:16px"></div>
    <div class="bnSpeed" id="bnSpeed">
      <button id="bnSlow" aria-label="느리게">−</button>
      <div><span id="bnSpeedV" class="num">100%</span><div class="bnSpeedLbl">속도</div></div>
      <button id="bnFast" aria-label="빠르게">+</button>
    </div>
    ${gap ? '' : `<div id="bnBtns" style="display:flex; gap:8px; max-width:340px; margin:6px auto 0; justify-content:center">
      <button class="lsDemo" id="bnToggle" style="flex:1; height:44px; font-size:15px"></button>
      <button class="lsDemo" id="bnCheck" style="flex:1; height:44px; font-size:15px; display:none">혼자 확인하기 →</button>
    </div>`}
    <div class="bnStrip" id="bnStrip"></div>
    <canvas id="bnCanvas"></canvas>
    <div class="bnTapHint" id="bnTapHint">${gap ? '소리가 없는 동안에도 계속 세세요' : '1이라고 느낄 때 화면을 누르세요'}</div>
    <div id="bnSummary" style="position:absolute; inset:0; background:rgba(22,24,29,0.97); display:none; flex-direction:column; align-items:center; justify-content:center; padding:24px; text-align:center; z-index:5"></div>`;
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
      ? '<b style="color:#ffd644">낮게 「둠」 하는 큰 공 = 1</b> (여덟 카운트의 시작). 스윙은 1이 낮은 베이스예요.'
      : '이제 <b>혼자</b> — 음악만 듣고 1이라고 느낄 때 눌러요. 맞았는지 알려줄게요. 준비되면 <b>혼자 확인하기</b>로 채점해요.';
    if ($('bnToggle')) {
      $('bnToggle').textContent = hint ? '힌트 끄고 혼자 찾기 →' : '← 힌트 다시 켜기';
      $('bnToggle').style.display = '';
    }
    if ($('bnCheck')) {
      $('bnCheck').textContent = '혼자 확인하기 →';
      $('bnCheck').style.display = hint ? 'none' : ''; // 힌트 끈 뒤에만 채점 라운드 제공
    }
    $('bnStrip').style.visibility = hint ? 'visible' : 'hidden'; // 힌트 끄면 자리표시도 숨긴다(1 노출 방지)
    $('bnTapHint').textContent = '1이라고 느낄 때 화면을 누르세요';
  }
  if (!gap) {
    $('bnToggle').onclick = () => { hint = !hint; paintHint(); };
    $('bnCheck').onclick = () => { if (checking) abortCheck(); else startCheck(); };
  }
  paintHint();

  // 속도 조절 — 곡 안에서 바로 반영(음정 유지). 나갈 때 원래 속도로 복원.
  let curRate = gap ? GAP_RATE : FIND_RATE;
  function paintSpeed() {
    $('bnSpeedV').textContent = Math.round(curRate * 100) + '%';
    // 느리게 하면 음정유지를 끈 상태라 소리가 낮고 거칠어진다 — 고장이 아니라는 걸 화면에 써 준다
    $('bnSpeedLblNote').textContent = curRate < 1 ? '느리면 소리가 낮고 거칠어져요 — 정상이에요' : '';
  }
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
    const onBeat = diff <= WIN_MS;
    // 확인 라운드: 정답을 지금 보여주지 않고(피드백 걷음) 탭만 모은다 → 끝나고 채점.
    if (checking) {
      checkTaps.push({ i, count: c.count, onBeat, born: performance.now() });
      return;
    }
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

  // ── 확인 라운드 ──────────────────────────────────────────────
  function startCheck() {
    const h = getHeardTime();
    targetOnes = []; targetOneIdx = new Set();
    // 지금 위치에서 앞으로 지나갈 1들을 목표로. 첫 1은 최소 0.6초 뒤여야 반응할 틈이 있다.
    for (let k = 0; k < counts.length && targetOnes.length < CHECK_N; k++) {
      if (counts[k].count === 1 && counts[k].time > h + 0.6) { targetOnes.push(k); targetOneIdx.add(k); }
    }
    if (targetOnes.length === 0) { // 곡 끝 근처 — 처음으로 되돌려 다시 채운다
      toStart();
      for (let k = 0; k < counts.length && targetOnes.length < CHECK_N; k++) {
        if (counts[k].count === 1 && counts[k].time > firstBeat - 0.01) { targetOnes.push(k); targetOneIdx.add(k); }
      }
      checkStartHeard = firstBeat - 1;
    } else {
      checkStartHeard = h;
    }
    if (targetOnes.length === 0) return; // 1이 하나도 없는 비정상 곡 — 채점 불가
    checkEndTime = counts[targetOnes[targetOnes.length - 1]].time + 0.5; // 마지막 1 뒤 여유
    checkTaps = []; hits = []; checkRate = curRate; checking = true;
    // UI: 공·소리·실시간 피드백을 걷는다
    $('bnHint').innerHTML = `<b>혼자 확인 중</b> — 음악만 듣고, 1이라고 느낄 때 눌러요. 공·소리 힌트는 잠깐 꺼둘게요. (1을 ${targetOnes.length}번 찾기)`;
    $('bnToggle').style.display = 'none';
    $('bnCheck').textContent = '확인 그만두기';
    $('bnStrip').style.visibility = 'hidden';
    $('bnSpeed').style.visibility = 'hidden';
    $('bnTapHint').textContent = '음악만 듣고 · 1이라고 느낄 때 누르기';
    if (au.paused && !closed) au.play().catch(() => {});
  }

  function abortCheck() {
    checking = false;
    $('bnSpeed').style.visibility = '';
    paintHint();
  }

  function finishCheck() {
    if (!checking) return;
    checking = false;
    const N = targetOnes.length;
    const hitSet = new Set();
    let wrong = 0, off = 0;
    for (const tp of checkTaps) {
      if (tp.onBeat && tp.count === 1 && targetOneIdx.has(tp.i)) hitSet.add(tp.i); // 같은 1 중복 탭은 Set이 무효화
      else if (tp.onBeat && tp.count === 1) { /* 목표창 밖의 1 — 분모 초과 방지 위해 무시 */ }
      else if (tp.onBeat) wrong++;    // 창 안이지만 1이 아님 = 1 위치 혼동
      else off++;                     // 창 밖 = 시간이 어긋남(빗나감)
    }
    const Y = hitSet.size, missed = N - Y;
    const prev = (lastCheck && lastCheck.rate === checkRate) ? lastCheck : null;
    lastCheck = { N, Y, wrong, off, rate: checkRate };
    showSummary({ N, Y, wrong, off, missed, prev });
  }

  function showSummary({ N, Y, wrong, off, missed, prev }) {
    const encourage = Y === 0
      ? '아직 귀가 트이는 중이에요. 힌트를 켜고 「둠」 소리를 더 들어도 좋아요.'
      : Y >= N ? '전부 맞혔어요. 속도를 올리거나 힌트 없이 더 해봐요.'
        : '되고 있어요. 같은 곡으로 몇 번 더 해봐요.';
    let cmp = '';
    if (prev) {
      const d = Y - prev.Y;
      cmp = d > 0 ? `<div style="color:#ffd644; font-size:15px; margin-top:6px">지난번보다 +${d} (지난번 ${prev.Y}번)</div>`
        : d < 0 ? `<div style="color:#8f929b; font-size:15px; margin-top:6px">지난번은 ${prev.Y}번이었어요. 한 번 더 해봐요.</div>`
          : `<div style="color:#8f929b; font-size:15px; margin-top:6px">지난번과 같아요 (${prev.Y}번).</div>`;
    }
    const offLine = off > 0 ? `<div style="color:#8f929b; font-size:14px">· 박자 아닌 곳: ${off}번</div>` : '';
    $('bnSummary').innerHTML = `
      <div style="font-size:18px; font-weight:700; margin-bottom:4px">이번 확인 (혼자 · 음악만)</div>
      <div style="font-size:15px; color:#c9cdd6; margin-bottom:14px">지나온 1 — ${N}번</div>
      <div style="font-size:34px; font-weight:800; color:#ffd644; line-height:1.1">${Y}<span style="font-size:18px; color:#c9cdd6"> / ${N} 맞힘</span></div>
      <div style="margin-top:12px; font-size:15px; color:#c9cdd6; line-height:1.6">
        <div>✘ 다른 박을 1로 누름 — ${wrong}번</div>
        <div>· 놓친 1 — ${missed}번</div>
        ${offLine}
      </div>
      ${cmp}
      <div style="margin-top:14px; font-size:15px; color:#e8eaee; max-width:300px">${encourage}</div>
      <div style="margin-top:8px; font-size:12px; color:#6a6e78; max-width:300px">앱이 자동으로 잡은 1 기준이에요 — 곡에 따라 앱이 틀릴 수도 있어요.</div>
      <div style="display:flex; gap:10px; margin-top:22px; flex-wrap:wrap; justify-content:center">
        <button class="lsDemo" id="bnAgain" style="height:46px; padding:0 18px; font-size:15px">다시 확인</button>
        <button class="lsDemo" id="bnBackFree" style="height:46px; padding:0 18px; font-size:15px">혼자 연습</button>
        <button class="lsDemo" id="bnBackHint" style="height:46px; padding:0 18px; font-size:15px">힌트 켜고 듣기</button>
      </div>`;
    $('bnSummary').style.display = 'flex';
    $('bnAgain').onclick = () => { $('bnSummary').style.display = 'none'; startCheck(); };
    $('bnBackFree').onclick = () => { $('bnSummary').style.display = 'none'; hint = false; $('bnSpeed').style.visibility = ''; paintHint(); };
    $('bnBackHint').onclick = () => { $('bnSummary').style.display = 'none'; hint = true; $('bnSpeed').style.visibility = ''; paintHint(); };
  }

  function scheduleClicks() {
    if (closed || au.paused || checking || document.hidden) return; // 확인 중/백그라운드엔 예약 안 함(복귀 지지직 방지)
    const ctx = ensureCtx();
    const rate = getRate();
    const now = au.currentTime, horizon = now + 0.15 * rate;
    while (clickState.nextIdx < counts.length && counts[clickState.nextIdx].time < horizon) {
      const c = counts[clickState.nextIdx];
      const idx = clickState.nextIdx;
      // 1 찾기(find)는 1·5만 소리낸다 — 매 박자 큰 클릭이 음악과 겹쳐 찢어지던 걸 없애고,
      // 찾을 대상(1·5)만 귀에 남긴다. 나머지 박자는 공으로만 보인다. gap은 박자 유지가
      // 목적이라 모든 박을 내되 여린 소리로. 볼륨은 엔진 마스터(0.9)가 다시 한 번 누른다.
      const emphasized = c.count === 1 || c.count === 5;
      if (c.time >= now - 0.01 && audibleAt(idx) && (gap || emphasized)) {
        const when = ctx.currentTime + (c.time - now) / rate;
        // 1 = 낮은 둠(베이스처럼), 5 = 중간, 나머지(gap) = 여린 고음. 스윙의 저역=1 구조를 귀로.
        if (c.count === 1) kick(when, 0.95);
        else clickAt(when, c.count === 5 ? 1 : 2, c.count === 5 ? 0.6 : 0.3);
      }
      clickState.nextIdx += 1;
    }
  }
  const clickTimer = setInterval(scheduleClicks, 25);

  function toStart() { au.currentTime = Math.max(0, firstBeat - 1); clickState.nextIdx = 0; }

  function drawCheckScreen(heard) {
    // 박자에 맞춰 튀는 공을 걷는다 — 대신 정적인 안내 원 + 진행바 + 중립 탭 물결.
    const cx = W / 2, cy = FLOOR - FLOOR * 0.25;
    g.strokeStyle = '#3a3f4a'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, Math.min(46, W * 0.12), 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#8f929b';
    g.font = '700 15px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('듣는 중', cx, cy);

    // 진행바(시간 기준 — 개별 박자 시점을 흘리지 않으려고 박자와 무관하게 그린다)
    const span = Math.max(0.001, checkEndTime - checkStartHeard);
    const prog = Math.min(1, Math.max(0, (heard - checkStartHeard) / span));
    const bw = Math.min(280, W - 60), bx = (W - bw) / 2, by = cy + 90;
    g.strokeStyle = '#3a3f4a'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + bw, by); g.stroke();
    g.strokeStyle = '#ffd644';
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + bw * prog, by); g.stroke();
    g.lineCap = 'butt';

    // 중립 탭 물결 — 맞았는지는 숨기고, 눌린 것만 알려준다
    const now = performance.now();
    for (const tp of checkTaps) {
      const age = (now - tp.born) / 600;
      if (age > 1) continue;
      g.globalAlpha = 1 - age;
      g.strokeStyle = '#c9cdd6'; g.lineWidth = 3 * (1 - age);
      g.beginPath(); g.arc(cx, cy, Math.min(46, W * 0.12) + 6 + age * 40, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }
  }

  function draw() {
    if (closed) return;
    const heard = getHeardTime();
    const now = performance.now();

    if (checking) {
      if (heard > checkEndTime || heard > lastBeat + 0.5 || au.ended) { finishCheck(); requestAnimationFrame(draw); return; }
      g.clearRect(0, 0, W, H);
      drawCheckScreen(heard);
      requestAnimationFrame(draw);
      return;
    }

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
