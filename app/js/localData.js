// Where the data on this device is kept in "on this computer" mode (localRepo.js
// does the rest): the desktop app's data folder, through its main process (the
// other desktop app uses the same folder), or else IndexedDB, which the tracker
// and the editor share in the browser (one site, divaor.github.io). Also says
// when the other app changed it, so this one syncs at once. The tracker and the
// editor keep the same copy of this file.
import { createLocalRepo } from './localRepo.js';

const DB_NAME = 'tracker-data';
const CHANNEL = 'tracker-data';

function idbBackend() {
  let opening = null;
  const db = () =>
    (opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async (mode, fn) => {
    const tx = (await db()).transaction('kv', mode);
    const store = tx.objectStore('kv');
    return new Promise((resolve, reject) => {
      let result;
      Promise.resolve(fn(store, (value) => (result = value))).catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  const request = (req) => new Promise((resolve, reject) => ((req.onsuccess = () => resolve(req.result)), (req.onerror = () => reject(req.error))));
  return {
    get: (key) => run('readonly', async (s, done) => done((await request(s.get(key)))?.value ?? null)),
    put: (key, value) => run('readwrite', (s) => void s.put({ value, time: Date.now() }, key)),
    // One transaction: reading and writing cannot interleave with the other app's.
    cas: (key, expected, value) =>
      run('readwrite', async (s, done) => {
        const current = (await request(s.get(key)))?.value ?? null;
        if (current !== expected) return done(false);
        s.put({ value, time: Date.now() }, key);
        done(true);
      }),
    del: (key) => run('readwrite', (s) => void s.delete(key)),
    list: (prefix) =>
      run('readonly', async (s, done) => {
        const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
        const [keys, values] = await Promise.all([request(s.getAllKeys(range)), request(s.getAll(range))]);
        done(keys.map((key, i) => ({ key, time: values[i]?.time ?? 0 })));
      }),
  };
}

// A branch head moved here: the other app (another tab or the installed one) syncs.
function announcing(backend) {
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  return {
    ...backend,
    async cas(key, expected, value) {
      const done = await backend.cas(key, expected, value);
      if (done && key.startsWith('ref/')) channel?.postMessage({ key });
      return done;
    },
  };
}

let repo = null;

/** The data repo on this device (one per page, so its cache is shared). */
export function localRepo() {
  if (!repo) {
    const bridge = window.desktop?.data;
    repo = createLocalRepo(bridge ? bridge : announcing(idbBackend()));
  }
  return repo;
}

/** Calls `fn` when the other app changed the data on this device; returns a stop function. */
export function onLocalDataChange(fn) {
  const bridge = window.desktop?.data;
  if (bridge?.onChanged) return bridge.onChanged(fn);
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => fn();
  return () => channel.close();
}

/** Where the data is, for Settings: { dir } on desktop (the folder), { browser: true } on the web. */
export async function localDataInfo() {
  return window.desktop?.data ? await window.desktop.data.info() : { browser: true };
}
