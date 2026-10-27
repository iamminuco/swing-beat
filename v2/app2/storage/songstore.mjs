import { clone, createSongMap, validateSongMap, validateEngineResult, validateUser } from '../songmap/schema.mjs';
import { migrateSongMap, songKey } from '../songmap/migrate.mjs';
export const V2_PREFIX = 'songmap:v2:';
export const V1_PREFIX = 'songmap:v1:';
export const DB_NAME = 'swing-songmaps-v2';
const keyOf = song => typeof song === 'string' ? song : songKey(song);
const message = error => error?.message ?? String(error);
export function createSongStore(options = {}) {
  const idb = options.indexedDB ?? globalThis.indexedDB;
  let dbPromise;
  const listeners = new Set();
  const factory = options.channelFactory === undefined
    ? (typeof window !== 'undefined' && globalThis.BroadcastChannel
      ? name => new BroadcastChannel(name) : null) : options.channelFactory;
  let channel = null;
  try { channel = factory?.(DB_NAME) ?? null; } catch { /* storage is still usable */ }
  const announce = data => { for (const fn of listeners) { try { fn(data); } catch {} } };
  if (channel) channel.onmessage = event => announce(event.data);
  function published(map) {
    const data = { songKey: map.songKey, revision: map.revision };
    try { channel?.postMessage(data); } catch {}
    announce(data);
  }
  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      if (!idb) { reject(new Error('IndexedDB unavailable')); return; }
      let request, settled = false;
      try { request = idb.open(DB_NAME, 1); } catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('maps')) db.createObjectStore('maps');
        if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups');
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        request.result.onversionchange = () => { request.result.close(); dbPromise = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { settled = true; reject(request.error ?? new Error('open failed')); };
      request.onblocked = () => { settled = true; reject(new Error('IndexedDB upgrade blocked')); };
    }).catch(error => { dbPromise = undefined; throw error; });
    return dbPromise;
  }
  async function transaction(body) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let tx, result, thrown;
      const guard = fn => (...args) => {
        try { fn(...args); } catch (error) { thrown = error; tx.abort(); }
      };
      try {
        tx = db.transaction(['maps', 'backups'], 'readwrite');
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(thrown ?? tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => {}; // Default IndexedDB error handling aborts the transaction.
        const get = (store, key, callback) => {
          const r = tx.objectStore(store).get(key);
          r.onsuccess = guard(() => callback(r.result));
        };
        body({ tx, get, done: value => { result = value; } });
      } catch (error) {
        if (tx) { thrown = error; try { tx.abort(); } catch { reject(error); } }
        else reject(error);
      }
    });
  }
  function decode(raw, key) {
    if (typeof raw !== 'string') throw new RangeError('stored value must be JSON text');
    const result = migrateSongMap(JSON.parse(raw));
    if (result.map.songKey !== key) throw new RangeError('song identity mismatch');
    return result;
  }
  function backup(ctx, storageKey, raw, done) {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (text === undefined) throw new RangeError('unbackable original');
    const key = [storageKey, text];
    ctx.get('backups', key, old => {
      if (old === undefined) ctx.tx.objectStore('backups').put({ storageKey, raw: clone(raw) }, key);
      done();
    });
  }
  function persist(ctx, map) {
    ctx.tx.objectStore('maps').put(JSON.stringify(map), V2_PREFIX + map.songKey);
    ctx.done({ status: 'persisted', map: clone(map) });
  }
  async function finish(work) {
    try {
      const result = await transaction(work);
      if (result?.status === 'persisted') published(result.map);
      return result;
    } catch (error) { return { status: 'failed', error: message(error) }; }
  }
  async function read(song) {
    try {
      const key = keyOf(song);
      const result = await transaction(ctx => ctx.get('maps', V2_PREFIX + key, stored => {
        let raw = stored, source = 'v2';
        if (raw === undefined) {
          source = 'v1';
          const legacy = Object.hasOwn(options, 'legacyStorage') ? options.legacyStorage : globalThis.localStorage;
          raw = legacy?.getItem(V1_PREFIX + key) ?? null;
          if (raw === null) { ctx.done({ status: 'none' }); return; }
        }
        let decoded;
        try { decoded = decode(raw, key); }
        catch (error) {
          backup(ctx, (source === 'v1' ? V1_PREFIX : V2_PREFIX) + key, raw, () => {
            const result = { status: 'corrupt', source, raw: clone(raw), error: message(error) };
            if (source === 'v1') {
              result.map = createSongMap(key).map;
              result.recovered = result.imported = true;
              ctx.tx.objectStore('maps').put(JSON.stringify(result.map), V2_PREFIX + key);
            }
            ctx.done(result);
          });
          return;
        }
        const complete = () => {
          const map = decoded.map;
          if (source === 'v1') {
            map.revision = 1;
            ctx.tx.objectStore('maps').put(JSON.stringify(map), V2_PREFIX + key);
          }
          ctx.done({ status: 'ok', map, source, autoRejected: decoded.autoRejected,
            autoError: decoded.autoError, imported: source === 'v1' });
        };
        if (decoded.autoRejected) backup(ctx, (source === 'v1' ? V1_PREFIX : V2_PREFIX) + key, raw, complete);
        else complete();
      }));
      if (result.imported) published(result.map);
      return result;
    } catch (error) { return { status: 'error', error: message(error) }; }
  }
  async function save(input, expectedRevision) {
    let map;
    try {
      const checked = validateSongMap(input);
      if (checked.autoRejected) throw new RangeError(checked.autoError);
      map = checked.map;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new RangeError('expectedRevision required');
    } catch (error) { return { status: 'failed', error: message(error) }; }
    return finish(ctx => ctx.get('maps', V2_PREFIX + map.songKey, raw => {
      let current = null, decoded;
      if (raw !== undefined) {
        try { decoded = decode(raw, map.songKey); current = decoded.map; }
        catch {
          backup(ctx, V2_PREFIX + map.songKey, raw, () => ctx.done({ status: 'failed', error: 'corrupt; read/recover first' }));
          return;
        }
      } else {
        // A never-imported legacy map must be read before creating its v2 replacement.
        const legacy = Object.hasOwn(options, 'legacyStorage') ? options.legacyStorage : globalThis.localStorage;
        if (legacy?.getItem(V1_PREFIX + map.songKey) != null) {
          ctx.done({ status: 'failed', error: 'legacy map requires read/import first' }); return;
        }
      }
      if ((current?.revision ?? 0) !== expectedRevision) {
        ctx.done({ status: 'conflict', revision: current?.revision ?? 0 }); return;
      }
      // A user-only save writes the stored auto back as it was; the read-time restarts: [] is not persisted.
      const stored = raw === undefined ? undefined : JSON.parse(raw).auto;
      const next = current ? { ...current, auto: decoded.autoRejected || stored === undefined ? current.auto : stored,
        user: validateUser(map.user) } : map;
      next.revision = expectedRevision + 1;
      if (!Number.isSafeInteger(next.revision)) throw new RangeError('revision overflow');
      const write = () => persist(ctx, next);
      if (decoded?.autoRejected) backup(ctx, V2_PREFIX + map.songKey, raw, write); else write();
    }));
  }
  async function saveAnalysis(song, engine) {
    let key, auto;
    try { key = keyOf(song); auto = validateEngineResult(engine); }
    catch (error) { return { status: 'failed', error: message(error) }; }
    return finish(ctx => ctx.get('maps', V2_PREFIX + key, raw => {
      if (raw === undefined) { ctx.done({ status: 'failed', error: 'read/create first' }); return; }
      let checked;
      try { checked = decode(raw, key); }
      catch {
        backup(ctx, V2_PREFIX + key, raw, () => ctx.done({ status: 'failed', error: 'corrupt; recover first' }));
        return;
      }
      const next = { ...checked.map, auto, revision: checked.map.revision + 1 };
      if (!Number.isSafeInteger(next.revision)) throw new RangeError('revision overflow');
      const write = () => persist(ctx, next);
      if (checked.autoRejected) backup(ctx, V2_PREFIX + key, raw, write); else write();
    }));
  }
  async function recover(song, replacement, expectedRaw) {
    let key, map;
    try {
      key = keyOf(song);
      const checked = validateSongMap(replacement);
      if (checked.autoRejected || checked.map.songKey !== key) throw new RangeError('replacement invalid');
      map = checked.map;
    } catch (error) { return { status: 'failed', error: message(error) }; }
    return finish(ctx => ctx.get('maps', V2_PREFIX + key, raw => {
      if (raw !== expectedRaw) { ctx.done({ status: 'conflict' }); return; }
      try { decode(raw, key); ctx.done({ status: 'failed', error: 'original is valid' }); return; } catch {}
      let oldRevision = 0;
      try { oldRevision = JSON.parse(raw).revision; } catch {}
      map.revision = Number.isSafeInteger(oldRevision) && oldRevision >= 0 ? oldRevision + 1 : 1;
      if (!Number.isSafeInteger(map.revision)) throw new RangeError('revision overflow');
      backup(ctx, V2_PREFIX + key, raw, () => persist(ctx, map));
    }));
  }
  return { read, save, saveAnalysis, recover,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async close() {
      channel?.close(); listeners.clear();
      if (dbPromise) { try { (await dbPromise).close(); } catch {} }
    } };
}
