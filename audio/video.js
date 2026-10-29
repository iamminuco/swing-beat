import { isVideoFile, checkVideoSize, onsetCurve, estimateAlignmentAsync,
  musicPosition, needsResync, projectLayout } from '../core/video-sync.js';
import { layout } from '../core/songmap/songmap.js';
import { MODEL_SR } from './decode.js';

export async function hasVideoTrack(blob) {
  const el = document.createElement('video'), url = URL.createObjectURL(blob);
  el.preload = 'metadata'; el.playsInline = true;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('영상 정보를 읽지 못했어요')); }, 8000);
      function cleanup() { clearTimeout(timer); el.onloadedmetadata = null; el.onerror = null; }
      el.onloadedmetadata = () => { cleanup(); resolve(el.videoWidth > 0); };
      el.onerror = () => { cleanup(); reject(new Error('이 영상 형식을 읽지 못했어요')); };
      el.src = url; el.load();
    });
  } finally { el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); }
}
// Keep this synchronous: the play call must stay inside the user's tap.
export function primeMedia(el) {
  if (!el.paused) return;
  const muted = el.muted, position = el.currentTime;
  try {
    el.muted = true;
    Promise.resolve(el.play()).catch(() => {});
  } catch { /* A rejected warm-up must not block opening or playback. */ }
  finally {
    el.pause();
    el.muted = muted;
    if (Number.isFinite(position) && el.currentTime !== position) el.currentTime = position;
  }
}
const graphs = new WeakMap();
export function createVideoSession({ $, blob, pcm, videoMap, analyzeMusic, onChange, onClockChange, ensureCtx }) {
  checkVideoSize(blob);
  const v = $('video'), music = $('replacementAudio'), panel = $('videoPanel');
  // 소리 고르기는 버튼 두 개(10/29): 아이폰은 선택 상자를 바꾼 직후를 "누름"으로 치지 않아 파일 고르기 창과 음악 재생이 막혔다.
  const soundVideo = $('soundVideo'), soundMusic = $('soundMusic'), basis = $('videoBasis'), input = $('musicInput');
  const paintSound = choice => { soundVideo.className = choice === 'video' ? 'on' : ''; soundMusic.className = choice === 'music' ? 'on' : ''; };
  let message = '', trimWarning = false;
  const status = text => { message = text; trimWarning = false; $('videoStatus').textContent = text; };
  const trimMessage = '음악이 영상을 못 따라와요. 빠르기를 조금 조정하고 있어요. 계속 어긋나면 동영상 소리로 바꿔 주세요.';
  // Set once the music keeps needing automatic seeks; it stays visible until the user does something (realign).
  let cannotFollow = false;
  function clearTrimWarning() {
    if (trimWarning && !cannotFollow) { $('videoStatus').textContent = message; trimWarning = false; }
  }
  let dead = false, request = 0, replacement = null, musicUrl = null, alignmentController = null;
  let followerNotice = null, followerMessage = '';
  let fit = { offset: 0, ratio: 1 }, musicOn = false, waiting = false, starting = null;
  let videoFeatures = null, followerEpoch = 0, playEpoch = 0;
  let attempts = 0, trim = 0, followerBlocked = false, touchBlocked = false, over = 0, recommendation = null;
  const tolerance = 0.030;
  let startCheck = null;
  // A seek issued while the video plays aims ahead by (seek time + resume delay), each the smallest of its last 3 measurements,
  // so one slow seek or slow resume cannot make later seeks overshoot. Seek time = seek call to 'seeked'.
  // Resume delay = 'seeked' until the music clock actually moves (some devices keep the clock still for 100+ ms after a seek).
  const tick = 40; // ms, the follower timer period; the clock is only seen on ticks, so a measured delay is on average half a tick too long.
  let seekIssuedAt = null; const recentSeeks = [], recentResumes = [];
  let aimedAhead = 0, seekedAt = 0;
  const smallest = list => (list.length ? Math.min(...list) : 0);
  const keep = (list, value) => { list.push(Math.max(0, Math.min(0.5, value))); if (list.length > 3) list.shift(); };
  // Automatic music seeks (timer driven, no user action) in the last 10 s; 3 of them means the music cannot keep up.
  let autoSeeks = [];
  function realign() {
    attempts = 0; trim = 0; over = 0; startCheck = null; followerBlocked = false; touchBlocked = false; aimedAhead = 0;
    autoSeeks = []; cannotFollow = false; clearTrimWarning();
  }
  function noteAutoSeek() {
    const t = performance.now();
    autoSeeks = autoSeeks.filter(x => t - x <= 10000); autoSeeks.push(t);
    if (autoSeeks.length >= 3 && !cannotFollow && !followerBlocked) {
      cannotFollow = true; trimWarning = true; $('videoStatus').textContent = trimMessage;
    }
  }
  function followerFailed(err) {
    followerBlocked = true; touchBlocked = err?.name === 'NotAllowedError';
    if (!followerNotice) followerMessage = message;
    followerNotice = err?.name === 'NotAllowedError'
      ? '▶를 한 번 더 눌러 주세요'
      : '음악이 영상을 못 따라와요. ▶를 다시 누르거나 동영상 소리로 바꿔 주세요: ' + (err?.message || err);
    status(followerNotice);
  }
  const videoUrl = URL.createObjectURL(blob), listeners = [];
  panel.hidden = false; v.hidden = false; v.muted = false; music.muted = false; resetGain(); v.src = videoUrl; v.load();
  paintSound('video'); basis.value = 'video'; basis.disabled = true;
  $('syncRatio').value = '1'; $('syncOffset').textContent = '0.00초';
  $('musicRange').hidden = true;
  $('applyRecommendation').hidden = true; $('recommendedFit').textContent = '';
  status('');
  function on(el, event, fn) { el.addEventListener(event, fn); listeners.push([el, event, fn]); }
  function resetGain() {
    for (const el of [v, music]) {
      const g = graphs.get(el)?.gain;
      if (g) { g.gain.cancelScheduledValues(0); g.gain.value = 1; }
    }
  }
  function failed(err) {
    if (dead) return;
    transport.pause();
    status('재생을 시작하지 못했어요. ▶를 다시 눌러 주세요: ' + (err?.message || err));
  }
  function stopFollower() {
    followerEpoch++; starting = null; startCheck = null; aimedAhead = 0; music.pause();
  }
  function playFollower() {
    if (starting || !music.paused || followerBlocked) return;
    const epoch = followerEpoch;
    startCheck = { position: music.currentTime, movingAt: null, observing: false, at: performance.now() };
    let pending;
    try { pending = Promise.resolve(music.play()); } catch (err) { followerFailed(err); return; }
    starting = pending;
    pending.then(() => {
      if (epoch !== followerEpoch || dead || music.paused) return;
      if (followerNotice && message === followerNotice) status(followerMessage);
      followerNotice = null;
    }, err => {
      if (epoch === followerEpoch && !dead && !v.paused && !v.seeking && !waiting) followerFailed(err);
    }).finally(() => { if (starting === pending) starting = null; });
  }
  function sync(force = false) {
    if (dead) return;
    resetRate();
    if (!musicOn || !replacement) { stopFollower(); v.muted = false; $('musicRange').hidden = true; return; }
    v.muted = true;
    const pos = musicPosition(v.currentTime, replacement.m.song.duration, fit);
    $('musicRange').hidden = pos.active;
    music.muted = !pos.active;
    if (!pos.active || v.seeking || waiting || document.hidden) { stopFollower(); return; }
    // A start-up check that has not reached 10 ms within 4 s ends; the normal path (seek, then warning) takes over.
    if (startCheck && performance.now() - startCheck.at > 4000) { startCheck = null; attempts = 0; }
    if (!music.seeking && music.readyState > 0) {
      const error = (pos.time - music.currentTime) / fit.ratio;
      // The warning ends once the music has recovered: no automatic seek for 10 s and it is inside the 30 ms band right now.
      // (Still outside the band means it keeps failing without seeking any more, so the warning stays.)
      if (cannotFollow && Math.abs(error) <= tolerance + 1e-9 && !autoSeeks.some(x => performance.now() - x <= 10000)) {
        cannotFollow = false; autoSeeks = []; clearTrimWarning();
      }
      const startingUp = startCheck?.observing;
      const measuring = startingUp && (startCheck.movingAt === null || performance.now() - startCheck.movingAt < 200);
      // Right after a seek that aimed ahead by the resume delay on purpose, the music is ahead until its clock starts (before the first tick sees it).
      const holding = !startingUp && aimedAhead > 0 && error < 0 && startCheck?.movingAt === null;
      const trimming = !startingUp && trim && !trimWarning;
      // 10 ms is only where an active trim stops; whether to seek is always judged against 30 ms.
      const release = startingUp || trimming ? 0.010 : tolerance;
      const far = () => needsResync(v.currentTime, music.currentTime, fit);
      if (Math.abs(error) <= tolerance + 1e-9) over = 0;
      if (measuring || holding) {
        // Wait for the follower clock to move, then measure after 0.2 seconds.
      } else if (Math.abs(error) <= release + 1e-9) {
        trim = 0; attempts = 0;
        if (startCheck?.observing) startCheck = null;
        resetRate(); clearTrimWarning();
      } else if (trimming && Math.abs(error) <= tolerance + 1e-9) {
        // Between 10 and 30 ms while trimming (e.g. after a video stall): keep the same trim, never seek.
        resetRate();
      } else if ((startingUp && !(startCheck.afterSeek && far())) || (startCheck && !far())
        || (!force && attempts === 0 && !far())) {
        // Deliberately no seek during a play-start correction even beyond 80 ms: a seek would re-create the start delay.
        // A check that follows a music seek is only waited on up to 80 ms; a bigger or growing gap goes back to seek/warning.
        // Once the music is steadily playing, a new or reversed trim needs 3 consecutive ticks over 30 ms so noisy readings cannot toggle it.
        if (startingUp || startCheck || music.paused || Math.sign(error) === Math.sign(trim) || ++over >= 3) {
          trim = Math.sign(error) * 0.03;
          resetRate(); clearTrimWarning();
        }
      } else if (force || attempts > 0 || far()) {
        if (attempts < 2) {
          attempts++;
          if (!force) noteAutoSeek();
          const lead = v.paused ? 0 : (smallest(recentSeeks) + smallest(recentResumes)) * v.playbackRate * fit.ratio;
          aimedAhead = v.paused ? 0 : smallest(recentResumes) * v.playbackRate * fit.ratio;
          seekIssuedAt = performance.now();
          music.currentTime = Math.min(replacement.m.song.duration, pos.time + lead);
        } else {
          trim = Math.max(-0.03, Math.min(0.03, error * 0.5));
          resetRate();
          if (!followerBlocked) {
            trimWarning = true;
            $('videoStatus').textContent = trimMessage;
          }
        }
      }
    }
    if (v.paused) stopFollower(); else playFollower();
  }
  function resetRate() {
    if (replacement) {
      const rate = v.playbackRate * fit.ratio * (1 + trim);
      if (music.playbackRate !== rate) music.playbackRate = rate;
      music.preservesPitch = v.preservesPitch;
      music.webkitPreservesPitch = v.webkitPreservesPitch;
    }
  }
  function changed() {
    realign(); resetGain(); sync(true);
    $('syncOffset').textContent = fit.offset.toFixed(2) + '초';
    $('syncRatio').value = String(Math.round(fit.ratio * 1000) / 1000);
    onChange();
  }
  const transport = {
    get currentTime() { return v.currentTime; },
    set currentTime(t) {
      const end = Number.isFinite(v.duration) ? v.duration : videoMap.song.duration;
      realign(); v.currentTime = Math.max(0, Math.min(end, t)); resetGain(); sync(true); onClockChange();
    },
    get playbackRate() { return v.playbackRate; },
    set playbackRate(rate) { if (v.playbackRate === rate) return; realign(); v.playbackRate = rate; resetRate(); sync(true); onClockChange(); },
    get preservesPitch() { return v.preservesPitch; },
    set preservesPitch(x) { v.preservesPitch = x; resetRate(); },
    set webkitPreservesPitch(x) { v.webkitPreservesPitch = x; resetRate(); },
    get paused() { return v.paused; },
    get seeking() { return v.seeking || waiting; },
    get ended() { return v.ended; },
    get duration() { return v.duration; },
    get src() { return v.src; },
    addEventListener(...args) { v.addEventListener(...args); listeners.push([v, ...args]); },
    pause() { playEpoch++; v.pause(); stopFollower(); resetGain(); },
    play() {
      ensureCtx();
      if (dead) return Promise.reject(new Error('동영상이 닫혔어요'));
      const epoch = ++playEpoch;
      waiting = false; realign(); resetRate(); resetGain();
      v.muted = musicOn;
      if (musicOn && replacement) primeMedia(music);
      const vp = v.play();
      sync(true);
      return Promise.resolve(vp).then(() => {
        if (!dead && epoch === playEpoch) sync(true);
      }).catch(err => {
        if (dead || epoch !== playEpoch) return;
        failed(err); throw err;
      });
    },
  };
  on(v, 'pause', () => { playEpoch++; stopFollower(); resetGain(); });
  on(v, 'seeking', () => { playEpoch++; realign(); stopFollower(); resetGain(); onClockChange(); });
  on(v, 'seeked', () => { sync(true); onClockChange(); });
  on(v, 'waiting', () => { playEpoch++; waiting = true; stopFollower(); onClockChange(); });
  on(v, 'playing', () => { waiting = false; sync(true); onClockChange(); });
  on(v, 'ratechange', () => { resetRate(); sync(true); onClockChange(); });
  on(v, 'ended', () => { stopFollower(); resetGain(); });
  on(v, 'error', () => { transport.pause(); status('동영상을 재생하지 못했어요. 이 기기가 지원하는 다른 파일로 골라 주세요.'); });
  on(music, 'error', () => { stopFollower(); followerFailed(new Error('다른 음악 파일로 골라 주세요')); });
  on(music, 'seeking', () => { if (startCheck?.observing) startCheck = null; });
  on(music, 'seeked', () => {
    if (seekIssuedAt !== null) {
      keep(recentSeeks, (performance.now() - seekIssuedAt) / 1000); seekIssuedAt = null;
    }
    // A music-only seek while the video plays (offset/rate/recommendation change) restarts the follower clock like a start does,
    // so give it the same start-up check; while that check waits, an error up to 80 ms is trimmed, not re-sought.
    seekedAt = performance.now();
    if (!startCheck && !v.paused && !v.seeking && !waiting && !document.hidden && replacement && !music.paused
      && musicPosition(v.currentTime, replacement.m.song.duration, fit).active)
      startCheck = { position: music.currentTime, movingAt: null, observing: false, afterSeek: true, at: performance.now() };
    sync(true);
  });
  on(music, 'loadedmetadata', () => sync(true));
  const timer = setInterval(() => {
    if (document.hidden || v.paused) return;
    if (startCheck && !music.paused && !music.seeking && music.readyState >= 3) {
      const position = music.currentTime;
      startCheck.observing = true;
      if (startCheck.movingAt === null && position > startCheck.position + 1e-5) {
        startCheck.movingAt = performance.now();
        // Under one tick the delay cannot be told from the sampling error, and the start-up trim already absorbs it: no lead for normal devices.
        // Counted from the end of the last seek, also for a play-start check that began while that seek was still running (video seek).
        const delay = (startCheck.movingAt - Math.max(startCheck.at, seekedAt) - tick / 2) / 1000;
        keep(recentResumes, delay >= tick / 1000 ? delay : 0);
      }
      startCheck.position = position;
    }
    sync();
  }, tick);
  async function selectMusic(file) {
    const seq = ++request;
    alignmentController?.abort();
    const controller = alignmentController = new AbortController();
    transport.pause(); ensureCtx();
    if (isVideoFile(file)) { status('내 음악 파일은 오디오 파일로 골라 주세요'); return; }
    status('음악을 분석하고 동영상과 맞추는 중이에요…');
    try {
      const result = await analyzeMusic(file, text => { if (!dead && seq === request) status(text); });
      if (dead || seq !== request) return;
      await new Promise(resolve => setTimeout(resolve, 0));
      if (dead || seq !== request) return;
      let found = null;
      try {
        videoFeatures ||= onsetCurve(pcm, MODEL_SR);
        status('맞추는 중…');
        found = await estimateAlignmentAsync(videoFeatures, onsetCurve(result.pcm, MODEL_SR), 100, controller.signal);
      } catch (err) {
        if (dead || seq !== request) return;
        status('자동으로 못 맞췄어요: ' + (err?.message || err));
      }
      if (dead || seq !== request) return;
      stopFollower(); music.removeAttribute('src'); music.load();
      if (musicUrl) URL.revokeObjectURL(musicUrl);
      musicUrl = URL.createObjectURL(file); music.src = musicUrl; music.load();
      replacement = { m: result.m };
      recommendation = found && Number.isFinite(found.offset) && found.score > 0
        ? { offset: found.offset, ratio: found.ratio } : null;
      fit = found?.matched ? { ...recommendation } : { offset: 0, ratio: 1 };
      $('applyRecommendation').hidden = !recommendation || !!found?.matched;
      $('recommendedFit').textContent = recommendation
        ? '추천값: 음악 시작 ' + recommendation.offset.toFixed(2) + '초, 빠르기 ' + recommendation.ratio.toFixed(3)
        : '추천값을 찾지 못했어요';
      musicOn = true; paintSound('music'); basis.value = 'music'; basis.disabled = false;
      status(found?.matched ? '자동으로 맞췄어요. 들으며 확인하고 필요하면 0.1초씩 조정해 주세요.'
        : '자동으로 못 맞췄어요. 추천값 적용 또는 0.1초·1초 조정으로 맞춰 주세요. 재생은 할 수 있어요.');
      changed();
    } catch (err) {
      if (!dead && seq !== request) return;
      if (!dead && seq === request) { paintSound(musicOn ? 'music' : 'video'); status('음악 분석 실패: ' + (err?.message || err)); }
    } finally { if (alignmentController === controller) alignmentController = null; }
  }
  soundVideo.onclick = () => {
    ensureCtx();
    if (!musicOn) return;
    musicOn = false; paintSound('video'); changed();
  };
  soundMusic.onclick = () => {
    ensureCtx();
    if (!replacement) { input.click(); return; }
    if (musicOn) return;
    musicOn = true; paintSound('music'); changed();
  };
  $('chooseMusic').onclick = () => { ensureCtx(); input.click(); };
  input.onchange = e => {
    const file = e.target.files[0]; e.target.value = '';
    if (file) return selectMusic(file);
  };
  basis.onchange = () => onChange();
  $('applyRecommendation').onclick = () => {
    if (recommendation) { fit = { ...recommendation }; changed(); }
  };
  $('offsetEarlierLarge').onclick = () => { fit = { ...fit, offset: fit.offset - 1 }; changed(); };
  $('offsetLaterLarge').onclick = () => { fit = { ...fit, offset: fit.offset + 1 }; changed(); };
  $('offsetEarlier').onclick = () => { fit = { ...fit, offset: fit.offset - 0.1 }; changed(); };
  $('offsetLater').onclick = () => { fit = { ...fit, offset: fit.offset + 0.1 }; changed(); };
  $('syncRatio').onchange = e => {
    const ratio = Number(e.target.value);
    if (!Number.isFinite(ratio) || ratio < 0.8 || ratio > 1) { e.target.value = String(fit.ratio); return; }
    fit = { ...fit, ratio }; changed();
  };
  return {
    transport, resetGain, sync,
    cancelAlignment() { request++; alignmentController?.abort(); },
    recoverTap() {
      // Only a touch-fixable denial (NotAllowedError) takes the tap; any other failure lets the button play/pause normally.
      if (!touchBlocked || !followerBlocked || !musicOn || !replacement || dead) return false;
      transport.play().catch(() => {});
      return true;
    },
    get usesMusicMap() { return !!replacement && basis.value === 'music'; },
    get basisMap() { return replacement && basis.value === 'music' ? replacement.m : videoMap; },
    layout(base) {
      return replacement && basis.value === 'music'
        ? projectLayout({ ...layout(replacement.m), phraseLen: replacement.m.phraseLen }, fit, videoMap.song.duration) : base;
    },
    ensureMediaGraph(ctx) {
      const el = musicOn && replacement ? music : v;
      if (!graphs.has(el)) {
        const source = ctx.createMediaElementSource(el), gain = ctx.createGain();
        source.connect(gain).connect(ctx.destination); graphs.set(el, { source, gain });
      }
      return graphs.get(el).gain;
    },
    dispose() {
      if (dead) return;
      dead = true; request++; alignmentController?.abort(); clearInterval(timer); transport.pause();
      for (const [el, event, fn] of listeners) el.removeEventListener(event, fn);
      for (const el of [v, music]) { el.muted = false; el.removeAttribute('src'); el.load(); }
      URL.revokeObjectURL(videoUrl); if (musicUrl) URL.revokeObjectURL(musicUrl);
      for (const el of [soundVideo, soundMusic, basis, input, $('chooseMusic'), $('offsetEarlier'), $('offsetLater'), $('syncRatio'), $('applyRecommendation'), $('offsetEarlierLarge'), $('offsetLaterLarge')])
        { el.onchange = null; el.onclick = null; }
      panel.hidden = true; v.hidden = true;
    },
  };
}
