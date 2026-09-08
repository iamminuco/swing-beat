// SongMap persistence v1: localStorage only. The audio itself is never stored;
// a map is matched to a re-picked file by name+size+duration (원본 보존 정책 v1).
// The storage backend is injectable so core behavior is testable in node.
import { migrateSongMap, songKey } from '../core/songmap/schema.js';

const PREFIX = 'songmap:v1:';

function backend(storage) {
  const s = storage ?? globalThis.localStorage;
  if (!s) throw new Error('No storage backend available');
  return s;
}

export function saveSongMap(map, storage) {
  const valid = migrateSongMap(map);
  backend(storage).setItem(PREFIX + songKey(valid.song), JSON.stringify(valid));
  return valid;
}

// Returns the stored map for this song, or null when absent or unreadable.
// A corrupted entry is reported, not thrown: analysis can always be redone.
// A map whose own song identity differs from the requested key is treated as
// corrupted too — never hand back another song's judgments.
export function loadSongMap(song, storage) {
  try {
    // Everything inside the try: a malformed song identity, a throwing storage
    // backend, or a corrupted entry all mean the same thing to the caller —
    // no usable saved map; analysis can be redone.
    const raw = backend(storage).getItem(PREFIX + songKey(song));
    if (raw === null) return null;
    const map = migrateSongMap(JSON.parse(raw));
    return songKey(map.song) === songKey(song) ? map : null;
  } catch {
    return null;
  }
}

export function removeSongMap(song, storage) {
  backend(storage).removeItem(PREFIX + songKey(song));
}

export function listSongMaps(storage) {
  let s;
  try {
    s = backend(storage);
    void s.length;
  } catch {
    return []; // a throwing storage backend means no saved maps are reachable
  }
  const maps = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      maps.push(migrateSongMap(JSON.parse(s.getItem(key))));
    } catch {
      // skip unreadable entries; they can be rebuilt from the audio file
    }
  }
  return maps.sort((a, b) => a.song.name.localeCompare(b.song.name));
}
