// Spec-like HTMLMediaElement mock: play() promise pending while readyState<=2, pause() rejects pending
// promises with AbortError, seeking freezes currentTime at target and drops readyState to HAVE_METADATA.
import { performance } from 'node:perf_hooks';
const now = () => performance.now() / 1000;
const queue = fn => setImmediate(fn);
export const log = [];
export class SpecMedia extends EventTarget {
  constructor(name, { duration = 60, seekLatency = 0.03 } = {}) {
    super(); this.name = name; this.duration = duration; this.seekLatency = seekLatency;
    this.paused = true; this.seeking = false; this.readyState = 4; this.ended = false;
    this._pos = 0; this._t0 = now(); this._rate = 1; this._pending = []; this._seekTimer = null;
    this.muted = false; this.src = ''; this.hidden = false; this.value = ''; this.seeks = 0; this.playCalls = 0;
    this.preservesPitch = true; this.audibleAt = []; // samples of (time, producing?) for analysis
  }
  _advancing() { return !this.paused && !this.seeking && this.readyState >= 3; }
  get currentTime() {
    if (this.seeking) return this._target;
    if (this._advancing()) return Math.min(this.duration, this._pos + (now() - this._t0) * this._rate);
    return this._pos;
  }
  _freeze() { this._pos = this.currentTime; this._t0 = now(); }
  set currentTime(t) {
    this._freeze(); this.seeks++;
    this.seeking = true; this._target = t; if (this.readyState > 1) this.readyState = 1;
    queue(() => this._fire('seeking'));
    clearTimeout(this._seekTimer);
    this._seekTimer = setTimeout(() => {
      this.seeking = false; this._pos = t; this._t0 = now(); this.readyState = 4;
      this._fire('seeked');
      if (!this.paused) { const p = this._pending; this._pending = []; this._fire('playing'); p.forEach(x => x.res()); }
    }, this.seekLatency * 1000);
  }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._freeze(); this._rate = r; queue(() => this._fire('ratechange')); }
  play() {
    this.playCalls++;
    return new Promise((res, rej) => {
      if (this.paused) {
        this.paused = false; this._t0 = now();
        queue(() => this._fire('play'));
        if (this.readyState <= 2) { queue(() => this._fire('waiting')); this._pending.push({ res, rej }); }
        else { const p = [...this._pending, { res, rej }]; this._pending = []; queue(() => { this._fire('playing'); p.forEach(x => x.res()); }); }
      } else if (this.readyState >= 3) queue(() => res());
      else this._pending.push({ res, rej });
    });
  }
  pause() {
    if (this.paused) return;
    this._freeze(); this.paused = true;
    const p = this._pending; this._pending = [];
    queue(() => { this._fire('pause');
      p.forEach(x => x.rej(Object.assign(new Error('The play() request was interrupted by a call to pause().'), { name: 'AbortError' }))); });
  }
  load() {} removeAttribute(n) { if (n === 'src') this.src = ''; } click() { this.clicked = true; }
  _fire(type) { log.push(`${this.name}:${type}`); this.dispatchEvent(new Event(type)); }
}
