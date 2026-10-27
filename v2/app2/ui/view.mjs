import { currentCount, uncertaintyText, saveText, restartText } from './state.mjs';

export function timelineMarkup(s) {
  const cs = s.view?.counts ?? [];
  return Array.from({ length: Math.ceil(cs.length / 8) }, (_, row) => {
    const cells = cs.slice(row * 8, row * 8 + 8);
    return '<div class="beatRow" data-row="' + row + '">' + cells.map(c =>
      '<button class="beat" type="button" data-beat="' + c.beat + '" data-time="' + c.time +
      '" aria-label="' + c.time.toFixed(1) + '초, ' + (c.count === null ? '번호 없는 박' : c.count + '박') +
      '"><span>' + (c.count === null ? '·' : c.count) + '</span></button>').join('') +
      (cells.some(c => c.automaticReason) ? '<small>앱이 확신 못 함</small>' : '') + '</div>';
  }).join('') || '<p>표시할 박이 없어요</p>';
}
const time = n => Math.floor((n || 0) / 60) + ':' + String(Math.floor((n || 0) % 60)).padStart(2, '0');
export function mountUi(doc, controller) {
  const $ = id => doc.getElementById(id);
  let view, active = null;
  const off = controller.store.subscribe(s => {
    const ready = s.phase === 'ready', p = s.practice, listening = !!p;
    $('progress').textContent = s.progress;
    $('progress').setAttribute('aria-busy', String(['opening', 'analyzing'].includes(s.phase)));
    $('error').textContent = s.error; $('notice').textContent = s.notice;
    $('songTitle').textContent = s.name || '곡을 골라 주세요';
    $('songSub').textContent = ready ? time(s.position) + ' / ' + time(s.map.auto.duration) + ' · 음악 카운트' : '오디오 파일 · 30초 이상';
    $('songView').hidden = !ready;
    if (!ready) return;
    $('saveStatus').textContent = saveText(s);
    $('uncertainty').textContent = uncertaintyText(s);
    $('restartNotice').textContent = restartText(s);
    $('correctionNotice').textContent = s.view.applyFailed ? '내 보정을 적용하지 못한 위치가 있어요' :
      s.view.counts.some(c => c.provenance === 'user' && c.count !== s.map.auto.counts[c.beat]?.count)
        ? '내가 맞춘 1과 앱의 1이 다름' : '';
    $('timeline').hidden = listening;
    $('currentBeat').hidden = listening;
    if (view !== s.view) { view = s.view; $('timeline').innerHTML = timelineMarkup(s); active = null; }
    const count = currentCount(s), next = count ? $('timeline').querySelector('[data-beat="' + count.beat + '"]') : null;
    if (active !== next) {
      active?.classList.remove('current'); active?.removeAttribute('aria-current');
      next?.classList.add('current'); next?.setAttribute('aria-current', 'true');
      if (next && !s.hidden && !listening) {
        const row = next.parentElement, box = $('timeline');
        if (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
          box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2);
      }
      active = next;
    }
    $('currentBeat').textContent = count?.count ?? '·';
    $('playBtn').textContent = s.paused ? '재생' : '일시정지';
    $('playBtn').disabled = p?.kind === 'listening';
    $('seek').max = s.map.auto.duration; $('seek').value = s.position; $('seek').disabled = !!p;
    $('rate').value = s.rate; $('rate').disabled = !!p;
    $('clickOn').checked = s.clickOn; $('clickOn').disabled = !!p;
    $('accent').value = s.accent; $('accent').disabled = !!p;
    $('correctionOn').checked = s.enabled; $('correctionOn').disabled = !!p;
    for (const id of ['setOneBtn', 'swapBtn']) $(id).disabled = !s.writable || !s.enabled || !!p;
    for (const id of ['tapPracticeBtn', 'listenPracticeBtn']) $(id).disabled = !!p;
    $('practice').hidden = !p;
    if (p) {
      $('practiceTitle').textContent = p.kind === 'tap' ? '연습 · 들리는 박마다 탭' : '청음 · 딱 소리가 음악의 박에 붙어 있나요?';
      $('practiceHint').textContent = p.kind === 'tap' ? '자동 분석의 박 시각과 비교해요. 현재 기기의 지연이 결과에 영향을 줄 수 있어요.'
        : '끝까지 들은 뒤 붙어 있어요 / 어긋나요를 골라 주세요.';
      $('tapPad').hidden = p.kind !== 'tap' || !!p.result;
      $('tapPad').disabled = !p.running || s.paused || s.hidden;
      $('hearBtn').hidden = p.kind !== 'listening' || !!p.result;
      $('hearBtn').disabled = !!p.running;
      for (const id of ['answerYes', 'answerNo']) { $(id).hidden = p.kind !== 'listening' || !!p.result; $(id).disabled = !p.heard || p.running; }
      $('practiceResult').textContent = p.text ?? (p.kind === 'tap' && !p.running ? '연습을 나간 뒤 다시 시작해 주세요' : '');
    }
  });
  $('fileInput').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) controller.openFile(f); });
  $('playBtn').addEventListener('click', controller.play);
  $('seek').addEventListener('input', e => controller.seek(Number(e.target.value)));
  $('rate').addEventListener('change', e => controller.setRate(Number(e.target.value)));
  $('clickOn').addEventListener('change', e => controller.setClick(e.target.checked));
  $('accent').addEventListener('change', e => controller.setAccent(e.target.value));
  $('correctionOn').addEventListener('change', e => controller.setEnabled(e.target.checked));
  $('setOneBtn').addEventListener('click', controller.setOne);
  $('swapBtn').addEventListener('click', controller.swap);
  $('tapPracticeBtn').addEventListener('click', controller.startTap);
  $('listenPracticeBtn').addEventListener('click', controller.startListening);
  $('tapPad').addEventListener('pointerdown', e => { e.preventDefault(); controller.tap(); });
  $('tapPad').addEventListener('keydown', e => { if (!e.repeat && [' ', 'Enter'].includes(e.key)) { e.preventDefault(); controller.tap(); } });
  $('hearBtn').addEventListener('click', controller.hear);
  $('answerYes').addEventListener('click', () => controller.answer('yes'));
  $('answerNo').addEventListener('click', () => controller.answer('no'));
  $('leavePracticeBtn').addEventListener('click', controller.leavePractice);
  $('timeline').addEventListener('click', e => { const b = e.target.closest('[data-time]'); if (b) controller.seek(Number(b.dataset.time)); });
  return off;
}
