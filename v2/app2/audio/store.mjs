// Audio bytes only. Reuses the v1 audio database; never touches SongMap storage.
function sameBytes(a, b) {
  const words = a.byteLength >> 2, x = new Uint32Array(a, 0, words), y = new Uint32Array(b, 0, words);
  for (let i = 0; i < words; i++) if (x[i] !== y[i]) return false;
  const p = new Uint8Array(a), q = new Uint8Array(b);
  for (let i = words << 2; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}
export function createAudioStore({ indexedDB = globalThis.indexedDB, navigator = globalThis.navigator } = {}) {
  function database() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('beatapp', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('audio')) req.result.createObjectStore('audio'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function get(db, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(['audio'], 'readonly').objectStore('audio').get(key);
      req.onsuccess = () => resolve(req.result ?? null); req.onerror = () => reject(req.error);
    });
  }
  return {
    async saveAudio(key, blob) {
      let db;
      try {
        const buf = await blob.arrayBuffer();
        if (!buf.byteLength) return false;
        db = await database();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['audio'], 'readwrite');
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
          tx.objectStore('audio').put({ buf, type: blob.type || '', name: blob.name || '', size: buf.byteLength }, key);
        });
        const back = await get(db, key);
        return back?.buf instanceof ArrayBuffer && back.buf.byteLength === buf.byteLength && sameBytes(back.buf, buf);
      } catch { return false; }
      finally { db?.close(); }
    },
    async listAudioKeys() {
      let db;
      try {
        db = await database();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(['audio'], 'readonly').objectStore('audio').getAllKeys();
          req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
      } catch { return []; }
      finally { db?.close(); }
    },
    async deleteAudio(key) {
      let db;
      try {
        db = await database();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['audio'], 'readwrite');
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
          tx.objectStore('audio').delete(key);
        });
        return true;
      } catch { return false; }
      finally { db?.close(); }
    },
    requestPersistence() {
      try { Promise.resolve(navigator?.storage?.persist?.()).catch(() => {}); } catch { /* unsupported */ }
    },
    async loadAudio(key) {
      let db;
      try {
        db = await database(); const raw = await get(db, key);
        if (raw instanceof Blob) return raw.size ? raw : null;
        return raw?.buf instanceof ArrayBuffer && raw.buf.byteLength ? new Blob([raw.buf], { type: raw.type || '' }) : null;
      } catch { return null; }
      finally { db?.close(); }
    },
  };
}
