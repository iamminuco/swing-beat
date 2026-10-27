import { reapplyCorrections } from '../songmap/apply.mjs';

const initial = () => ({ request: 0, openToken: null, phase: 'idle', name: '', progress: '',
  error: '', notice: '', map: null, view: null, writable: false, save: 'none', audioSaved: null,
  enabled: true, clickOn: true, accent: 'EVEN', rate: 1, rateTransient: false,
  position: 0, paused: true, seeking: false, hidden: false, practice: null });
const derive = s => ({ ...s, view: s.map?.auto ? reapplyCorrections(s.map.auto, s.map.user,
  { enabled: s.enabled }) : null });
export function createUiStore() {
  let state = initial();
  const listeners = new Set();
  return {
    get: () => state,
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    send(event) {
      if (event.type !== 'OPEN' && (event.request !== state.request ||
          (event.openToken !== undefined && event.openToken !== state.openToken))) return false;
      const p = event.value ?? {};
      switch (event.type) {
        case 'OPEN': state = { ...initial(), request: state.request + 1, phase: 'opening', name: p.name }; break;
        case 'TOKEN': state = { ...state, openToken: p.token }; break;
        case 'PROGRESS':
          if (!['opening', 'analyzing'].includes(state.phase)) return false;
          state = { ...state, progress: p.text }; break;
        case 'ANALYZING': state = { ...state, phase: 'analyzing', audioSaved: p.audioSaved }; break;
        case 'READY': state = derive({ ...state, phase: 'ready', progress: '', map: p.map,
          writable: false, save: 'saving', rate: p.map.user.rate, accent: p.map.user.accent }); break;
        case 'SAVED': state = derive({ ...state, save: p.status, writable: p.status === 'persisted',
          ...(p.status === 'persisted' ? { map: p.map,
            rate: state.rateTransient ? state.rate : p.map.user.rate, accent: p.map.user.accent } : {}) }); break;
        case 'ENABLED': state = derive({ ...state, enabled: p.enabled }); break;
        case 'PATCH': state = { ...state, ...p }; break;
        case 'ERROR': state = { ...state, phase: 'error', progress: '', error: p.message, practice: null }; break;
        default: throw new RangeError('Unknown UI event');
      }
      for (const fn of listeners) fn(state);
      return true;
    },
  };
}
export function currentCount(state) {
  const cs = state.view?.counts ?? [], t = state.position;
  let lo = 0, hi = cs.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (cs[m].time <= t) lo = m + 1; else hi = m; }
  const c = cs[lo - 1];
  return c && t < c.end ? c : null;
}
export function uncertaintyText(state) {
  const segment = state.map?.auto?.segments.find(s => s.start <= state.position && state.position < s.end);
  return segment?.reason ? '앱이 확신 못 함' : '';
}
export function saveText(state) {
  if (state.rateTransient) return '저장 못 함 · 1.0배 초과 속도는 이번 재생에만 적용돼요';
  if (state.save === 'saving') return '저장 중…';
  if (state.save !== 'persisted') return state.save === 'conflict'
    ? '저장 못 함 · 다른 탭에서 바뀌었어요. 파일을 다시 열어 주세요'
    : '저장 못 함 · 저장소를 확인하고 파일을 다시 열어 주세요';
  return state.audioSaved === true ? '기기에 저장됨' : '저장 못 함 · 음원 파일 저장에 실패했어요';
}
export function restartText(state) {
  return (state.view?.restarts ?? []).map(r =>
    (r.applied ? '음악 묶음에 맞춰 1로 다시 셌어요' : r.message) + ' · ' + r.rawTime.toFixed(1) + '초').join(' / ');
}
