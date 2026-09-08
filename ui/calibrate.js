// 두드려 재기 화면. 계산은 core/learn/calibrate.js(template.html에서 옮긴 검증본).
// 반 속도로 틀고 들리는 박에 맞춰 8번 두드리면 화면 지연(lag.screen)이 잡힌다.
// 카운트음 지연은 여기서 손대지 않는다 — 옛 문구가 둘 다 맞췄다고 말해
// 안 맞은 카운트음을 맞았다고 믿게 한 일이 있다.
import { foldTaps, tapSample, TAPS_NEEDED } from '../core/learn/calibrate.js';
import { countAt } from '../core/analysis/analyze.js';

export function startCalibration({ au, getLayout, setRate, setScreenLag, silenceClicks, onClose }) {
  const root = document.getElementById('calView');
  const prevRate = au.playbackRate || 1;
  const restoreClicks = silenceClicks();
  let taps = [];
  root.innerHTML = `
    <div class="ovTop">
      <button class="ovClose" id="calClose">✕</button>
      <div class="ovTitle">두드려 재기</div>
      <div class="ovRight" id="calCount">0 / ${TAPS_NEEDED}</div>
    </div>
    <div class="lsBody">
      <div class="lsQ">느리게 틀어 드릴게요</div>
      <div class="lsHint" id="calMsg"><b>들리는 박자에 맞춰</b> 아래 칸을 ${TAPS_NEEDED}번 두드려 주세요.<br>
        눈으로 맞추면 0.1초쯤 어긋나도 맞아 보여요 — 그래서 두드려서 재요.</div>
    </div>
    <div class="calPad" id="calPad"><div>탭</div><div class="calSub">박마다 한 번</div></div>`;
  root.hidden = false;
  const $ = id => root.querySelector('#' + id);

  setRate(0.5);
  if (au.paused) au.play();

  $('calPad').onpointerdown = () => {
    if (au.paused) { au.play(); return; }
    const lay = getLayout();
    const t = au.currentTime;
    const item = lay ? countAt(lay, t) : null;
    if (!item) return;
    const s = tapSample(item, t, au.playbackRate || 1);
    if (!s) return;
    taps.push(s);
    $('calCount').textContent = `${taps.length} / ${TAPS_NEEDED}`;
    if (taps.length < TAPS_NEEDED) return;
    const r = foldTaps(taps);
    taps = [];
    $('calCount').textContent = `0 / ${TAPS_NEEDED}`;
    if (r.ms === null) {
      $('calMsg').innerHTML = `두드린 간격이 들쭉날쭉해서 못 맞췄어요. <b>한 박씩 또박또박</b> 다시 ${TAPS_NEEDED}번 두드려 주세요.`;
      return;
    }
    setScreenLag(r.ms);
    $('calMsg').innerHTML = r.ms > 0
      ? `맞췄어요 — 화면 표시를 <b>${r.ms}ms</b> 늦췄어요. 카운트음이 아직 어긋나면 설정의 「카운트음」 줄에서 따로 맞춰 주세요.`
      : '이미 잘 맞고 있어요. 늦출 필요가 없네요.';
  };

  function close() {
    au.pause();
    setRate(prevRate);
    restoreClicks();
    root.hidden = true;
    root.innerHTML = '';
    onClose();
  }
  $('calClose').onclick = close;
  return { stop: close };
}
