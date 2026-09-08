// 곡 파일 자체를 기기 안(IndexedDB)에 저장한다 — 서버로는 아무것도 안 나간다.
// 이게 없으면 페이지를 다시 열 때마다 파일을 다시 골라야 해서 「초기화」처럼
// 느껴진다(9/8 사용자 실보고). 키는 SongMap과 같은 songKey. 실패는 조용히
// null/false — 저장이 안 돼도 앱은 다시-선택 방식으로 계속 동작해야 한다.
// 저장 형식 v2(9/8): File 객체가 아니라 {buf: ArrayBuffer, type, name}으로 넣는다.
// iOS Safari에서 File/Blob 구조 복제가 조용히 실패하거나 빈 blob으로 남는 사례가
// 있어(사용자 아이폰 4곡 보고), 가장 단순한 바이트 배열로 저장하고 쓴 뒤 읽어 확인한다.
// v1(Blob 그대로 저장)도 읽을 수 있다.
const DB_NAME = 'beatapp';
const STORE = 'audio';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getRaw(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function toBlob(raw) {
  if (!raw) return null;
  if (raw instanceof Blob) return raw.size > 0 ? raw : null; // v1
  if (raw.buf && raw.buf.byteLength > 0) return new Blob([raw.buf], { type: raw.type || '' });
  return null;
}

export async function saveAudio(key, blob) {
  try {
    const buf = await blob.arrayBuffer();
    if (!buf.byteLength) return false;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ buf, type: blob.type || '', name: blob.name || '', size: buf.byteLength }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    // 쓴 것을 바로 읽어 확인한다 — 「저장됐다」는 말은 읽힐 때만 한다
    const back = await getRaw(db, key);
    return !!(back && back.buf && back.buf.byteLength === buf.byteLength);
  } catch {
    return false; // 저장 공간 거부 등 — 다시-선택 경로가 살아 있다
  }
}

export async function loadAudio(key) {
  try {
    const db = await openDb();
    return toBlob(await getRaw(db, key));
  } catch {
    return null;
  }
}

export async function listAudioKeys() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function deleteAudio(key) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

// 브라우저에 「용량 부족해도 이 사이트 저장소는 지우지 말라」고 요청한다.
export function requestPersistence() {
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* 미지원 */ }
}
