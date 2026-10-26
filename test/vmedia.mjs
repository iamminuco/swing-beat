// Spec-like media element on the virtual clock: start latency after play()/seek, seek latency, optional reading noise
// (seeded), optional clock drift, optional play() denial until unlocked inside a "tap", optional permanent failure.
import { vnow } from './vclock.mjs';
const sec = () => vnow() / 1000;
const q = fn => setTimeout(fn, 0);
export class VMedia extends EventTarget {
  constructor(name, { duration = 60, seekLatency = 0.03, startLatency = 0, noise = 0, drift = 0, seed = 1 } = {}) {
    super(); Object.assign(this, { name, duration, seekLatency, startLatency, noise, drift });
    this.paused = true; this.seeking = false; this.readyState = 4; this.ended = false; this.muted = false; this.src = '';
    this.hidden = false; this.value = ''; this.textContent = ''; this.preservesPitch = true;
    this._pos = 0; this._t0 = 0; this._startAt = 0; this._req = 1; this._rate = 1 - drift; this._pending = [];
    this.seeks = 0; this.playCalls = 0; this._seed = seed >>> 0; this.denyUntilTap = false; this.unlocked = false; this.inTap = false; this.broken = false;
  }
  _rnd() { this._seed = (1664525 * this._seed + 1013904223) >>> 0; return this._seed / 4294967296; }
  _advancing() { return !this.paused && !this.seeking && this.readyState >= 3 && sec() >= this._startAt; }
  _clean() {
    if (this.seeking) return this._target;
    if (this._advancing()) return Math.min(this.duration, this._pos + (sec() - Math.max(this._t0, this._startAt)) * this._rate);
    return this._pos;
  }
  _freeze() { this._pos = this._clean(); this._t0 = sec(); }
  get currentTime() { const t = this._clean(); return this._advancing() && this.noise ? t + (this._rnd() * 2 - 1) * this.noise : t; }
  set currentTime(t) {
    this._freeze(); this.seeks++; this.seeking = true; this._target = t; if (this.readyState > 1) this.readyState = 1;
    q(() => this._fire('seeking'));
    clearTimeout(this._seekTimer);
    this._seekTimer = setTimeout(() => {
      this.seeking = false; this._pos = t; this._t0 = sec(); this.readyState = 4;
      if (!this.paused) this._startAt = sec() + this.startLatency;
      this._fire('seeked');
      if (!this.paused) { const p = this._pending; this._pending = []; this._fire('playing'); p.forEach(x => x.res()); }
    }, this.seekLatency * 1000);
  }
  get playbackRate() { return this._req; }
  set playbackRate(r) { this._freeze(); this._req = r; this._rate = r * (1 - this.drift); q(() => this._fire('ratechange')); }
  play() {
    this.playCalls++;
    if (this.broken) return Promise.reject(Object.assign(new Error('no supported sources'), { name: 'NotSupportedError' }));
    if (this.denyUntilTap) { if (this.inTap) this.unlocked = true; if (!this.unlocked) return Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' })); }
    return new Promise((res, rej) => {
      if (this.paused) {
        this.paused = false; this._t0 = sec(); if (this.readyState >= 3) this._startAt = sec() + this.startLatency;
        q(() => this._fire('play'));
        if (this.readyState <= 2) { q(() => this._fire('waiting')); this._pending.push({ res, rej }); }
        else { const p = [...this._pending, { res, rej }]; this._pending = []; q(() => { this._fire('playing'); p.forEach(x => x.res()); }); }
      } else if (this.readyState >= 3) q(() => res()); else this._pending.push({ res, rej });
    });
  }
  pause() {
    if (this.paused) return;
    this._freeze(); this.paused = true; const p = this._pending; this._pending = [];
    q(() => { this._fire('pause'); p.forEach(x => x.rej(Object.assign(new Error('interrupted by pause()'), { name: 'AbortError' }))); });
  }
  load() {} removeAttribute(n) { if (n === 'src') this.src = ''; } click() {}
  _fire(type) { this.dispatchEvent(new Event(type)); }
}
