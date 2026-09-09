// Click engine + lookahead scheduler, ported from the proven template.html one
// (sine + short decay — square waves pierce over music, a user-confirmed call).
// Accent levels come from the SongMap accent mode:
//   EVEN     → counts 2·4·6·8 loud (사용자 요구: 짝수 박 강세)
//   ONE_FIVE → count 1 loudest, 5 middle (the old app's scheme)
//   OFF      → uniform
// Browser-only; the caller owns the AudioContext and the layout.
export function createClickEngine(getCtx) {
  // 모든 클릭을 이 마스터 게인으로 모아 상한을 둔다(0.55). 안 그러면 매 박자 클릭이
  // 음악과 합쳐지며 하드웨어 믹서에서 찢어진다(사용자 「1 찾기 음질 다 깨짐」 9/9).
  let master = null, masterCtx = null;
  function bus() {
    const ctx = getCtx();
    if (master && masterCtx === ctx) return master;
    master = ctx.createGain();
    master.gain.value = 0.9; // 카운트음이 음악에 안 묻히게 — 카운트음은 박자당 1발이라 이 정도로 안 찢어진다
    master.connect(ctx.destination);
    masterCtx = ctx;
    return master;
  }
  // 예약했지만 아직 안 울린 노드. 정지·탐색·학습 종료 때 cancelPending()으로
  // 지운다 — 안 그러면 카운트음 지연 300ms일 때 이전 구간의 클릭이 뒤늦게 들린다.
  const live = new Set();
  function track(osc, gain) {
    const node = { osc, gain };
    live.add(node);
    osc.onended = () => { live.delete(node); try { gain.disconnect(); } catch { /* already */ } };
  }
  function cancelPending() {
    const ctx = getCtx();
    const now = ctx.currentTime;
    for (const { osc, gain } of live) {
      // 즉시 하드컷(osc.stop(now))은 톡 하고 팝이 난다 — 3ms 페이드로 눕히고 끈다.
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.003);
      } catch { /* node gone */ }
      try { osc.stop(now + 0.004); } catch { /* not started — silent */ }
    }
    live.clear();
  }

  function levelFor(count, accent) {
    if (accent === 'EVEN') return count % 2 === 0 ? 0 : 2;
    if (accent === 'ONE_FIVE') return count === 1 ? 0 : count === 5 ? 1 : 2;
    return 1;
  }

  function click(when, level, volume) {
    const ctx = getCtx();
    // 0.98 상한: 사용자가 크기를 끝까지 키워도 클릭 하나가 절대 안 찢어지게(크게만·깨끗하게).
    const vol = Math.min(0.98, volume * (level === 0 ? 0.85 : level === 1 ? 0.55 : 0.3));
    if (vol <= 0) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = level === 0 ? 1050 : level === 1 ? 840 : 660;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(vol, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
    osc.connect(gain).connect(bus());
    osc.start(when);
    osc.stop(when + 0.05);
    track(osc, gain);
  }

  // Schedule upcoming counts a little ahead of the audio clock. state carries
  // nextIdx across calls; resync() after every seek. lagClickMs is the click
  // half of the two-value latency correction (screen lag is separate).
  function schedule(state, counts, nowMusic, rate, opts) {
    const ctx = getCtx();
    const horizon = nowMusic + 0.15 * rate;
    while (state.nextIdx < counts.length && counts[state.nextIdx].time < horizon) {
      const c = counts[state.nextIdx];
      if (c.time >= nowMusic - 0.01) {
        const when = ctx.currentTime + (c.time - nowMusic) / rate + opts.lagClickMs / 1000;
        // 붐칙(P1): 1은 낮은 둠(베이스처럼), 나머지는 강세에 따른 틱. EVEN 강세면 2·4·6·8이 밝고
        // 3·5·7이 여려서 "1=낮음, 2·4=높음"의 스윙 구조가 카운트음만으로 들린다(교수법 조사 #1).
        if (c.count === 1) kick(when, opts.volume);
        else click(when, levelFor(c.count, opts.accent), opts.volume);
      }
      state.nextIdx += 1;
    }
  }

  // 카운트인: 5·6·7·8 four clicks at the local beat interval, returns the real
  // seconds until the music should actually start.
  function countIn(interval, rate, opts) {
    const ctx = getCtx();
    const step = interval / rate;
    for (let i = 0; i < 4; i++) {
      click(ctx.currentTime + i * step + opts.lagClickMs / 1000,
        levelFor(5 + i, opts.accent), opts.volume);
    }
    return 4 * step;
  }

  // 「1」 전용 낮은 둠(kick). 스윙에서 1은 저역(베이스드럼/워킹베이스)이고 큰 2·4는 고역이다
  // (교습 조사 9/9). 그 구조를 귀로 가르치려 1은 낮게 낸다. 단 폰 스피커가 진짜 저음을 못
  // 내므로 ~330→180Hz로 떨어지는 "둠"(폰에서도 들리는 낮은 대역)으로 만든다.
  function kick(when, volume) {
    const ctx = getCtx();
    const vol = Math.min(0.98, volume);
    if (vol <= 0) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(330, when);
    osc.frequency.exponentialRampToValueAtTime(180, when + 0.08);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(vol, when + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
    osc.connect(gain).connect(bus());
    osc.start(when);
    osc.stop(when + 0.16);
    track(osc, gain);
  }

  // 짝수 강세 방식 ②(설계 §6): 카운트음과 다른 음색(삼각파·짧은 우드블록 느낌)으로
  // 짝수 박만 찍는다. 카운트음이 꺼져 있어도 강세만 들을 수 있다.
  function accentClick(when, volume) {
    const ctx = getCtx();
    if (volume <= 0) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1500, when);
    osc.frequency.exponentialRampToValueAtTime(900, when + 0.03);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(volume, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    osc.connect(gain).connect(bus());
    osc.start(when);
    osc.stop(when + 0.06);
    track(osc, gain);
  }

  return { schedule, countIn, clickAt: click, kick, accentClick, cancelPending };
}
