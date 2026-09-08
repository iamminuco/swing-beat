// 학습 기록 — 학습 탭의 「지난번 결과」와 박자 테스트 결과 화면이 읽는다.
// 종류별 마지막 결과만 보관한다(추세 그래프는 v2). 저장 실패는 조용히 무시:
// 기록이 안 돼도 학습 자체는 돼야 한다. 저장소는 주입 가능(테스트).
const KEY = 'beatapp_results_v1';
export const RESULT_KINDS = ['listening', 'tap', 'intro', 'test'];

function backend(storage) {
  return storage ?? globalThis.localStorage ?? null;
}

export function lastResults(storage) {
  try {
    const s = backend(storage);
    const raw = s?.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return typeof obj === 'object' && obj !== null ? obj : {};
  } catch {
    return {};
  }
}

export function recordResult(kind, data, storage, now = Date.now()) {
  if (!RESULT_KINDS.includes(kind)) throw new RangeError('Unknown result kind: ' + kind);
  const all = lastResults(storage);
  all[kind] = { ...data, at: now };
  try { backend(storage)?.setItem(KEY, JSON.stringify(all)); } catch { /* 저장 거부 */ }
  return all[kind];
}

// 「32ms 늦음」 같은 사람용 문구. 학습 카드·결과 화면이 같은 말을 쓰게 한 곳에 둔다.
export function describeTiming(meanMs) {
  if (meanMs === null || meanMs === undefined) return '기록 없음';
  if (Math.abs(meanMs) <= 8) return '정확함';
  return `${Math.abs(Math.round(meanMs))}ms ${meanMs > 0 ? '늦음' : '빠름'}`;
}

// 박자 테스트 뒤 재생 화면 기본값 제안. 문턱값은 우리 설정이지 논문 수치가 아니다
// (설계 §5). 청음이 약하면 보조를 전부 켜고, 탭이 흔들리면 카운트음을 켜고,
// 둘 다 좋으면 카운트 숫자만 남긴다.
export function suggestDefaults({ listening, tap }) {
  const hearing = listening ? listening.correct / listening.total : 1;
  const shaky = tap && (Math.abs(tap.meanMs ?? 0) > 40 || (tap.sdMs ?? 0) > 40);
  if (hearing < 0.75) {
    return { countMode: 2, click: true, accent: true, text: '카운트·선 켬 · 카운트음 켬 · 짝수 강세 켬' };
  }
  if (shaky) {
    return { countMode: 1, click: true, accent: true, text: '카운트 켬 · 카운트음 켬 · 짝수 강세 켬' };
  }
  return { countMode: 1, click: false, accent: true, text: '카운트 켬 · 카운트음 끔 · 짝수 강세 켬' };
}
