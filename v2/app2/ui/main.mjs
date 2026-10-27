import { createAudioSession } from '../audio/session.mjs';
import { createAudioStore } from '../audio/store.mjs';
import { createSongStore } from '../storage/songstore.mjs';
import * as engine from '../engine/client.mjs';
import { createCuePlayer } from './cues.mjs';
import { createUiController } from './controller.mjs';
import { mountUi } from './view.mjs';

const audioStore = createAudioStore();
const session = createAudioSession({ media: document.getElementById('audio'), store: audioStore });
const cues = createCuePlayer({ clock: session.clock });
const controller = createUiController({ session, cues, songs: createSongStore(), engine });
mountUi(document, controller);
const timer = setInterval(controller.tick, 25);
document.addEventListener('visibilitychange', controller.tick);
window.addEventListener('pagehide', e => {
  session.clock.pause(); cues.reset();
  if (!e.persisted) { clearInterval(timer); controller.dispose(); }
});
