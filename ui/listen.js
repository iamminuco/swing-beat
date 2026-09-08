// 청음 화면. 문제 생성·채점은 core/learn/listening.js(순수·테스트됨).
// 초보가 "이게 뭔지 모르겠다"던 문제(9/8 사용자)를 풀려고, 문제 전에 **가르침 화면**을 둔다:
// 뜻을 풀어 쓰고, 「맞는 소리」와 「어긋난 소리」를 실제로 들려줘 귀로 차이를 잡게 한 뒤 시작한다.
// 근거: 지각 판별 훈련이 2주 만에 실제로 는다(Bégel 2018) — 단 무엇을 듣는지 알아야 한다.
import { scoreListening, KIND_TEXT } from '../core/learn/listening.js';

export function startListening({
  questions, demo, au, ensureCtx, clickAt, cancelClicks = () => {}, lagClickMs, samples, sr, onDone,
}) {
  const root = document.getElementById('listenView');
  const n = questions.length;
  let i = 0;
  const answers = [];
  let timer = null, heard = false, closed = false, answered = false, nextTimer = null;
  const prevRate = au.playbackRate || 1;
  au.playbackRate = 1;
  const $ = id => root.querySelector('#' + id);

  function stop() {
    clearInterval(timer); timer = null;
    if (!au.paused) au.pause();
    cancelClicks(); // 이미 예약된 카운트음이 답한 뒤/다음 예시 전에 울리지 않게
  }

  // 한 구간(win = {start, end, windowStart, clicks})을 틀고 카운트음을 얹는다.
  // 카운트음은 25ms마다 앞을 내다보며 예약(1 크게·5 중간·나머지 약하게).
  function playWindow(win, onStarted) {
    stop();
    const ctx = ensureCtx();
    let ptr = 0;
    au.currentTime = win.start;
    au.play().then(() => { if (!closed) onStarted?.(); }).catch(() => onStarted?.(false));
    timer = setInterval(() => {
      const now = au.currentTime;
      if (now >= win.end || (au.paused && now > win.start + 0.5)) { stop(); return; }
      const horizon = now + 0.15;
      while (ptr < win.clicks.length && win.clicks[ptr].time < horizon) {
        const c = win.clicks[ptr];
        if (c.time >= now - 0.01) {
          const when = ctx.currentTime + (c.time - now) + lagClickMs / 1000;
          clickAt(when, c.count === 1 ? 0 : c.count === 5 ? 1 : 2, 0.85);
        }
        ptr += 1;
      }
    }, 25);
  }

  // ── 가르침 화면 ─────────────────────────────────────────────────
  function showIntro() {
    root.innerHTML = `
      <div class="ovTop"><button class="ovClose" id="lsClose">✕</button><div class="ovTitle">청음</div><div class="ovRight"></div></div>
      <div class="lsBody" style="justify-content:flex-start; gap:16px; padding-top:8px; overflow-y:auto">
        <div class="lsQ" style="margin-top:8px">딱딱 소리가 박에 맞나요?</div>
        <div class="lsHint" style="text-align:left; max-width:340px">
          음악 위에 「딱 · 딱」 소리를 얹어 줄게요.<br>
          그 소리가 <b style="color:#fff">노래의 박에 딱 붙어 있으면 「맞아요」</b>,<br>
          <b style="color:#fff">박에서 밀려 어긋나면 「틀려요」</b>예요.<br>
          아래 두 개를 먼저 들어 보면 차이가 바로 느껴져요.
        </div>
        <button class="lsDemo" id="demoOk">✓ 맞는 소리 들어보기</button>
        <button class="lsDemo" id="demoNo">✗ 어긋난 소리 들어보기</button>
        <div class="lsFeedback" id="lsFeedback" style="min-height:20px"></div>
      </div>
      <div style="padding:0 16px 20px"><button class="primary" id="lsStart" style="width:100%; height:60px; font-size:17px; font-weight:700">시작하기 · 10문제</button></div>`;
    const label = (el, txt, color) => { const f = $('lsFeedback'); f.textContent = txt; f.style.color = color; void el; };
    $('demoOk').onclick = () => { if (demo) playWindow(demo.aligned, () => label(0, '이게 맞는 소리 — 딱이 박에 붙어 있어요', '#ffd644')); };
    $('demoNo').onclick = () => { if (demo) playWindow(demo.wrong, () => label(0, '이게 어긋난 소리 — 딱이 박 사이로 밀렸어요', '#c9cdd6')); };
    $('lsClose').onclick = () => { cleanup(); onDone(null); };
    $('lsStart').onclick = () => { stop(); showQuiz(); showQuestion(); };
  }

  // ── 문제 화면 ───────────────────────────────────────────────────
  let drawWave = () => {};
  function showQuiz() {
    root.innerHTML = `
      <div class="ovTop"><button class="ovClose" id="lsClose">✕</button><div class="ovTitle">청음</div><div class="ovRight" id="lsCount"></div></div>
      <div class="lsBars" id="lsBars"></div>
      <div class="lsBody">
        <div class="lsQ">딱딱 소리가 박에 맞나요?</div>
        <div class="lsHint">붙어 있으면 「맞아요」, 밀려 있으면 「틀려요」. 몇 번이고 다시 들어도 돼요.</div>
        <canvas id="lsWave"></canvas>
        <button class="lsPlay" id="lsPlay">▶ 들어보기</button>
        <div class="lsFeedback" id="lsFeedback"></div>
      </div>
      <div class="lsAnswers">
        <button id="lsNo" disabled>틀려요</button>
        <button id="lsYes" disabled>맞아요</button>
      </div>`;
    const canvas = $('lsWave');
    drawWave = q => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#262b34'; g.fillRect(0, 0, w, h);
      const span = q.end - q.windowStart;
      g.fillStyle = '#c9cdd6';
      for (let x = 0; x < w; x++) {
        const s0 = Math.floor((q.windowStart + (x / w) * span) * sr);
        const s1 = Math.floor((q.windowStart + ((x + 1) / w) * span) * sr);
        let mn = 0, mx = 0;
        for (let s = Math.max(0, s0); s < Math.min(samples.length, s1); s += 4) {
          const v = samples[s];
          if (v < mn) mn = v; else if (v > mx) mx = v;
        }
        g.fillRect(x, h / 2 + mn * h * 0.45, 1, Math.max(1, (mx - mn) * h * 0.45));
      }
      drawWave.cursor = t => {
        if (t < q.windowStart || t > q.end) return;
        g.fillStyle = '#ffd644';
        g.fillRect(((t - q.windowStart) / span) * w - 1, 0, 2, h);
      };
    };
    $('lsClose').onclick = () => { cleanup(); onDone(null); };
    $('lsPlay').onclick = () => {
      const q = questions[i];
      playWindow(q, ok => {
        if (ok === false) { const f = $('lsFeedback'); f.textContent = '재생을 시작하지 못했어요 — ▶를 다시 눌러 주세요'; f.style.color = '#c9cdd6'; return; }
        if (closed || answered) return;
        heard = true;
        $('lsNo').disabled = $('lsYes').disabled = false;
      });
    };
    $('lsNo').onclick = () => answer('no');
    $('lsYes').onclick = () => answer('yes');
  }

  function paintProgress() {
    $('lsCount').textContent = `${i + 1} / ${n}`;
    $('lsBars').innerHTML = questions.map((_, k) =>
      `<div class="${k < i ? 'done' : k === i ? 'cur' : ''}"></div>`).join('');
  }

  function showQuestion() {
    heard = false;
    answered = false;
    $('lsNo').disabled = $('lsYes').disabled = true;
    $('lsFeedback').textContent = '';
    paintProgress();
    drawWave(questions[i]);
  }

  function answer(a) {
    if (!heard || closed || answered) return; // 한 문제에 답은 한 번
    answered = true;
    stop();
    const q = questions[i];
    answers[i] = a;
    const right = a === q.answer;
    const fb = $('lsFeedback');
    fb.textContent = right ? '정답! ' + KIND_TEXT[q.kind] : '아쉬워요 — ' + KIND_TEXT[q.kind];
    fb.style.color = right ? '#ffd644' : '#c9cdd6';
    $('lsNo').disabled = $('lsYes').disabled = true;
    clearTimeout(nextTimer);
    nextTimer = setTimeout(() => {
      if (closed) return;
      i += 1;
      if (i >= n) { finish(); return; }
      showQuestion();
    }, 1300);
  }

  function cleanup() {
    closed = true;
    clearTimeout(nextTimer);
    stop();
    au.playbackRate = prevRate;
    root.hidden = true;
    root.innerHTML = '';
  }
  function finish() {
    const score = scoreListening(questions, answers);
    cleanup();
    onDone(score);
  }

  // 재생 커서 (문제 화면에서만 의미 있음)
  (function tick() {
    if (closed) return;
    if (!au.paused && drawWave.cursor && questions[i]) { drawWave(questions[i]); drawWave.cursor(au.currentTime); }
    requestAnimationFrame(tick);
  })();

  root.hidden = false;
  if (demo) showIntro();       // 처음이면 가르침부터
  else { showQuiz(); showQuestion(); }
  return { stop: cleanup };
}
