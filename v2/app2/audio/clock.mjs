// The media element is authoritative; do not extrapolate across a suspended clock.
export function createAudioClock(media) {
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(); };
  const events = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'emptied'];
  for (const type of events) media.addEventListener(type, notify);
  return {
    snapshot: () => ({ position: media.currentTime, rate: media.playbackRate,
      paused: media.paused, seeking: media.seeking, ended: !!media.ended }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    seek(time) {
      if (!Number.isFinite(time) || time < 0) throw new RangeError('seek time');
      media.currentTime = Number.isFinite(media.duration) ? Math.min(time, media.duration) : time;
      notify();
    },
    setRate(rate, { learning = false } = {}) {
      if (!Number.isFinite(rate) || rate <= 0) throw new RangeError('playback rate');
      media.playbackRate = rate;
      media.preservesPitch = !learning; media.webkitPreservesPitch = !learning;
      notify();
    },
    play: () => media.play(),
    pause() { media.pause(); notify(); },
    replaceSource(url) { media.pause(); media.src = url; media.load?.(); notify(); },
    dispose() { for (const type of events) media.removeEventListener(type, notify); listeners.clear(); },
  };
}
