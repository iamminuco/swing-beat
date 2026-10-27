import { createUiStore, currentCount } from './state.mjs';
import { createSongMap } from '../songmap/schema.mjs';
import { songKey } from '../songmap/migrate.mjs';
import { swapOneFive } from '../songmap/apply.mjs';
import { makeChart, createGameState, judgeTap, sweepMisses, gameStats } from '../learn/judge.mjs';
import { makeListeningQuiz, scoreListening } from '../learn/listening.mjs';
import { recordResult, lastResults, describeTiming } from '../learn/results.mjs';

export function createUiController({ session, songs, engine, cues, resultStorage,
  visibility = globalThis.document, rng = Math.random }) {
  const store = createUiStore();
  let chain = Promise.resolve(), closed = false, gestureContext = null;
  const send = (type, value, request = store.get().request, openToken) =>
    store.send({ type, value, request, openToken });
  const current = (r, t) => !closed && store.get().request === r &&
    store.get().openToken === t && session.isCurrentOpenToken(t);
  const serial = fn => { const job = chain.then(fn); chain = job.catch(() => {}); return job; };
  function gesture() {
    const ready = session.unlockFromGesture();
    session.activateElementFromGesture();
    return Promise.resolve(ready).then(ctx => { gestureContext = ctx; cues.setContext(ctx); return ctx; });
  }
  function sync() {
    const s = store.get(), p = s.practice;
    const custom = p?.kind !== 'tap' && (s.view?.counts.some(c => c.provenance === 'user') ||
      s.view?.beats.length !== s.map?.auto?.beats.length);
    const listening = p?.kind === 'listening';
    session.scheduler.configure({ clickOn: !listening && !custom && s.clickOn,
      accent: !listening && !custom && s.clickOn ? s.accent : 'OFF',
      lagClickMs: Math.max(0, (s.map?.user.latency.click ?? 0) * 1000) });
    const plan = listening ? (p.running ? p.question.clicks : []) : custom ? s.view.counts
      .filter(c => !['no_pulse', 'beat_uncertain'].includes(c.automaticReason)) : [];
    cues.setPlan(plan, { enabled: listening || s.clickOn, accent: listening ? 'ONE_FIVE' : s.accent,
      lag: Math.max(0, s.map?.user.latency.click ?? 0) });
  }
  function applySaved(saved, r, t) {
    if (!current(r, t)) return;
    send('SAVED', saved, r, t);
    const s = store.get();
    if (saved.status === 'persisted') {
      session.clock.setRate(s.rate, { learning: true });
      if (saved.map.auto) session.setResultForOpen(t, saved.map.auto);
    }
    sync();
  }
  function remember(kind, stats) {
    try {
      const data = recordResult(kind, stats, resultStorage);
      if (JSON.stringify(lastResults(resultStorage)[kind]) !== JSON.stringify(data)) throw new Error('not persisted');
    } catch { send('PATCH', { notice: '연습 기록을 저장 못 함 · 이번 결과는 화면에서 확인해 주세요' }); }
  }
  async function openFile(file) {
    if (!file || closed) return;
    session.clock.pause(); cues.setPlan([]);
    send('OPEN', { name: file.name });
    const r = store.get().request;
    let t, stage = 'decode';
    try {
      const ready = gesture();
      // Attach rejection handling before decode can yield; both gesture calls above are synchronous.
      ready.catch(() => {});
      const opening = session.openFile(file, { key: p => songKey({ name: file.name, size: file.size, duration: p.duration }) });
      t = session.getOpenToken(); send('TOKEN', { token: t }, r);
      session.setResultForOpen(t, null);
      send('PROGRESS', { text: '오디오를 여는 중…' }, r, t);
      const opened = await opening;
      if (!current(r, t) || opened.status !== 'opened') return;
      if (opened.duration < 30) { send('ERROR', { message: '30초보다 짧은 곡은 아직 분석할 수 없어요' }, r, t); return; }
      await ready;
      if (!current(r, t)) return;
      stage = 'analysis';
      send('ANALYZING', { audioSaved: opened.saved === true }, r, t);
      const progress = (text, heartbeat, token) => {
        if (current(r, t) && token === t) send('PROGRESS', { text, heartbeat }, r, t);
      };
      const prepared = await engine.prepareAnalysis({ openToken: t, progress });
      if (!current(r, t) || prepared.openToken !== t) return;
      const reply = await engine.analyzePcmInWorker(opened.samples, { openToken: t, progress });
      if (!current(r, t) || reply.openToken !== t) return;
      session.setResultForOpen(t, reply.result);
      stage = 'storage';
      await serial(async () => {
        if (!current(r, t)) return;
        const key = songKey({ name: file.name, size: file.size, duration: opened.duration });
        const read = await songs.read(key);
        if (!current(r, t)) return;
        const base = read.map ?? createSongMap(key).map;
        session.clock.setRate(base.user.rate, { learning: true });
        send('READY', { map: { ...base, auto: reply.result } }, r, t);
        if (!['ok', 'none'].includes(read.status)) {
          applySaved({ status: 'failed' }, r, t); return;
        }
        if (read.status === 'none') {
          const created = await songs.save(base, 0);
          if (!current(r, t)) return;
          if (created.status !== 'persisted') { applySaved(created, r, t); return; }
        }
        const saved = await songs.saveAnalysis(key, reply.result);
        applySaved(saved, r, t);
      });
    } catch {
      if (r !== store.get().request || closed) return;
      if (stage === 'storage') { send('SAVED', { status: 'failed' }, r, t); sync(); }
      else send('ERROR', { message: stage === 'decode' ? '오디오를 열지 못했어요. 다른 파일을 골라 주세요'
        : '분석에 실패했어요. 파일을 다시 골라 주세요' }, r, t);
    }
  }
  function edit(change) {
    const { request: r, openToken: t } = store.get();
    return serial(async () => {
      const s = store.get();
      if (!current(r, t) || !s.writable || s.practice) return;
      const user = change(structuredClone(s.map.user), s);
      if (user.swapBlocked) { send('PATCH', { notice: '이 위치에서는 1과 5를 바꿀 수 없어요' }); return; }
      send('PATCH', { save: 'saving', writable: false, notice: '' });
      try { applySaved(await songs.save({ ...s.map, user }, s.map.revision), r, t); }
      catch { applySaved({ status: 'failed' }, r, t); }
    });
  }
  const unsubscribe = songs.subscribe(({ songKey: key, revision }) => {
    const { request: r, openToken: t } = store.get();
    serial(async () => {
      const s = store.get();
      if (!current(r, t) || key !== s.map?.songKey || revision <= s.map.revision) return;
      const read = await songs.read(key);
      if (!current(r, t)) return;
      if (read.status === 'ok') {
        session.clock.pause();
        send('PATCH', { practice: null, rate: s.rateTransient ? s.rate : read.map.user.rate,
          accent: read.map.user.accent, notice: '다른 탭의 변경을 다시 읽었어요' });
        applySaved({ status: 'persisted', map: read.map }, r, t);
      } else applySaved({ status: 'failed' }, r, t);
    });
  });
  async function play() {
    const s = store.get(), r = s.request, t = s.openToken;
    if (s.phase !== 'ready' || s.practice?.kind === 'listening') return;
    if (!session.clock.snapshot().paused) { session.clock.pause(); return; }
    try { const ready = gesture(), playing = session.clock.play(); await Promise.all([ready, playing]); }
    catch { if (current(r, t)) send('PATCH', { error: '재생하지 못했어요. 재생 버튼을 다시 눌러 주세요' }); }
  }
  function finishTap(p) {
    session.clock.pause();
    const stats = gameStats(p.game);
    send('PATCH', { practice: { ...p, running: false, result: stats,
      text: '앱 안내와 일치 · ' + (stats.perfect + stats.good) + '/' + stats.total + '박 · ' + describeTiming(stats.meanMs) } });
    remember('tap', stats); sync();
  }
  function tick() {
    if (closed) return;
    const snap = session.clock.snapshot();
    send('PATCH', { ...snap, hidden: !!visibility?.hidden });
    let s = store.get(), p = s.practice;
    if (visibility?.hidden) {
      if (p?.running) {
        session.clock.pause();
        send('PATCH', { practice: { ...p, running: false, heard: false }, notice: '화면이 숨겨져 연습을 멈췄어요. 다시 시작해 주세요' });
        sync();
      }
      cues.reset(); return;
    }
    if (p?.running && (!snap.paused || snap.ended) && !snap.seeking) {
      if (p.kind === 'tap') {
        const game = structuredClone(p.game);
        sweepMisses(game, snap.position - s.map.user.latency.screen * snap.rate, snap.rate);
        p = { ...p, game }; send('PATCH', { practice: p });
        if (game.hit.every(Boolean)) finishTap(p);
      } else if (snap.position >= p.question.end || snap.ended) {
        session.clock.pause();
        send('PATCH', { practice: { ...p, running: false, heard: true } }); sync();
      }
    }
    cues.tick();
  }
  async function startTap() {
    const s = store.get(); if (s.phase !== 'ready') return;
    const chart = makeChart(s.map.auto, 'all', { from: s.position + .35, limit: 16 });
    if (!chart.length) { send('PATCH', { notice: '지금 이후에 연습할 수 있는 박이 없어요. 앞부분으로 이동해 주세요' }); return; }
    session.clock.pause();
    send('PATCH', { error: '', notice: '', practice: { kind: 'tap', game: createGameState(chart), running: true } });
    session.clock.seek(Math.max(0, chart[0].time - .35)); sync();
    await play();
  }
  function tap() {
    const s = store.get(), p = s.practice, snap = session.clock.snapshot();
    if (p?.kind !== 'tap' || !p.running || snap.paused || snap.seeking || visibility?.hidden) return;
    if (gestureContext?.state !== 'running') {
      const failed = () => { if (current(s.request, s.openToken))
        send('PATCH', { error: '카운트음을 켜지 못했어요. 재생 버튼을 다시 눌러 주세요' }); };
      try { gesture().catch(failed); } catch { failed(); }
    }
    const game = structuredClone(p.game);
    judgeTap(game, snap.position - s.map.user.latency.screen * snap.rate, snap.rate);
    const next = { ...p, game }; send('PATCH', { practice: next });
    if (game.hit.every(Boolean)) finishTap(next);
  }
  function startListening() {
    const s = store.get(); if (s.phase !== 'ready') return;
    const question = makeListeningQuiz(s.map.auto, {}, 2, rng)[0];
    if (!question) { send('PATCH', { notice: '확신할 수 있는 16박 구간이 없어 청음을 시작할 수 없어요' }); return; }
    session.clock.pause();
    send('PATCH', { error: '', notice: '', practice: { kind: 'listening', question, running: false, heard: false } }); sync();
  }
  async function hear() {
    const s = store.get(), p = s.practice, r = s.request, t = s.openToken;
    if (p?.kind !== 'listening' || p.result || p.running) return;
    try {
      const ready = gesture();
      session.clock.pause(); session.clock.seek(p.question.start);
      send('PATCH', { practice: { ...p, running: true, heard: false } }); sync();
      const playing = session.clock.play(); await Promise.all([ready, playing]);
    } catch {
      if (current(r, t) && store.get().practice?.question === p.question) {
        session.clock.pause(); send('PATCH', { error: '청음을 재생하지 못했어요. 다시 들어 주세요',
          practice: { ...p, running: false, heard: false } }); sync();
      }
    }
  }
  function answer(value) {
    const s = store.get(), p = s.practice;
    if (p?.kind !== 'listening' || !p.heard || p.running || p.result || !['yes', 'no'].includes(value)) return;
    const stats = scoreListening([p.question], [value], s.map.auto);
    send('PATCH', { practice: { ...p, result: stats, text: '앱 안내와 일치 · ' + stats.correct + '/' + stats.total + '문항' } });
    remember('listening', stats); sync();
  }
  return { store, openFile, play, tick, startTap, tap, startListening, hear, answer,
    seek(time) { const s = store.get(); if (s.phase === 'ready' && !s.practice) session.clock.seek(time); },
    setRate(rate) {
      if (!Number.isFinite(rate) || rate < .5 || rate > 1.25 || store.get().phase !== 'ready' || store.get().practice) return;
      session.clock.setRate(rate, { learning: true }); send('PATCH', { rate, rateTransient: rate > 1 });
      if (rate <= 1) return edit(u => ({ ...u, rate }));
    },
    setClick(clickOn) { send('PATCH', { clickOn }); sync(); },
    setAccent(accent) {
      if (!['EVEN', 'ONE_FIVE', 'OFF'].includes(accent)) return;
      send('PATCH', { accent }); sync(); return edit(u => ({ ...u, accent }));
    },
    setEnabled(enabled) { send('ENABLED', { enabled }); sync(); },
    setOne() {
      return edit((u, s) => {
        const c = currentCount({ ...s, position: session.clock.snapshot().position });
        if (!c) { send('PATCH', { notice: '현재 박이 없어요. 박이 있는 위치로 이동해 주세요' }); return u; }
        u.corrections.oneAnchorTime = c.time; u.corrections.oneFiveReturnTime = null;
        u.corrections.source = 'user'; delete u.swapReturn;
        return u;
      });
    },
    swap() { return edit((u, s) => swapOneFive(u, s.map.auto, { time: session.clock.snapshot().position })); },
    leavePractice() { session.clock.pause(); send('PATCH', { practice: null }); sync(); },
    dispose() { closed = true; unsubscribe(); cues.dispose(); session.dispose(); songs.close(); },
    settled: () => chain,
  };
}
