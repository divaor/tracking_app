// Decides when to sync: on start, shortly after local edits, every few
// minutes while visible, when the network comes back and when the app is
// backgrounded with unsynced changes.
import { createGitHubClient } from './github.js';
import { syncOnce } from './sync.js';
import { getSettings, getToken, isSyncConfigured } from './settings.js';
import { store } from './store.js';

const EDIT_DELAY = 4000;
const INTERVAL = 5 * 60 * 1000;
const FOCUS_MIN_GAP = 60 * 1000;

let state = { phase: 'idle', error: null, lastSyncAt: null, lastPushAt: null };
const listeners = new Set();
let running = null;
let again = false;
let timer = null;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

async function run() {
  const settings = getSettings();
  const token = await getToken();
  if (!isSyncConfigured(settings) || !token) {
    set({ phase: 'disabled', error: null });
    return;
  }
  if (navigator.onLine === false) {
    set({ phase: 'offline' });
    return;
  }
  set({ phase: 'syncing', error: null });
  const counter = store.changeCounter;
  try {
    const client = createGitHubClient({ token, owner: settings.owner, repo: settings.repo });
    const result = await syncOnce({
      client,
      path: settings.path,
      branch: settings.branch,
      localItems: store.all(),
      device: settings.device || 'unknown device',
    });
    store.applySynced(result.items, counter, { sha: result.sha });
    const at = new Date().toISOString();
    set({ phase: 'idle', error: null, lastSyncAt: at, lastPushAt: result.pushed ? at : state.lastPushAt });
  } catch (err) {
    console.warn('Sync failed', err);
    set({ phase: 'error', error: err?.message ?? String(err) });
  }
}

export function syncNow() {
  clearTimeout(timer);
  if (running) {
    again = true;
    return running;
  }
  running = run().finally(() => {
    running = null;
    if (again || (store.meta.dirty && state.phase === 'idle')) {
      again = false;
      requestSync(1500);
    }
  });
  return running;
}

export function requestSync(delay = EDIT_DELAY) {
  if (!getSettings().autoSync) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export const getSyncState = () => ({ ...state, dirty: store.meta.dirty, lastSyncAt: state.lastSyncAt ?? store.meta.lastSyncAt });

export function onSyncState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startSync() {
  store.subscribe((reason) => {
    if (reason === 'local') {
      requestSync();
      set({});
    }
  });
  const sinceLast = () => Date.now() - Date.parse(getSyncState().lastSyncAt ?? 0);
  setInterval(() => {
    if (getSettings().autoSync && document.visibilityState === 'visible') syncNow();
  }, INTERVAL);
  window.addEventListener('online', () => getSettings().autoSync && syncNow());
  window.addEventListener('offline', () => set({ phase: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (!getSettings().autoSync) return;
    if (document.visibilityState === 'hidden' && store.meta.dirty) syncNow();
    if (document.visibilityState === 'visible' && sinceLast() > FOCUS_MIN_GAP) syncNow();
  });
  if (getSettings().autoSync) syncNow();
  else getToken().then((token) => (isSyncConfigured() && token) || set({ phase: 'disabled' }));
}
