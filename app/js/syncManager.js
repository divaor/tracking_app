// Decides when to sync: on start, shortly after local edits, every few
// minutes while visible, when the network comes back and when the app is
// backgrounded with unsynced changes. In local mode ("on this computer") the
// same sync goes to the data on this device (localData.js), at once when Tracker
// Editor changed it; switchStorage moves the data between it and GitHub.
import { describeChanges } from './changes.js';
import { createGitHubClient } from './github.js';
import { notifyChanges } from './notifier.js';
import { isDesktopApp } from './platform.js';
import { syncOnce } from './sync.js';
import { getSettings, getToken, isLocal, isSyncConfigured, saveSettings } from './settings.js';
import { store } from './store.js';
import { mergeItems, mergeProjects, parseData, serializeDocument } from './model.js';
import { localRepo, onLocalDataChange } from './localData.js';
import { moveData } from './moveData.js';

// The data file in local mode (Tracker Editor reads it there too).
const LOCAL_PATH = 'tracker.json';
const pathOf = (settings) => (isLocal(settings) ? LOCAL_PATH : settings.path);

/** Where the data is now: { client, branch, path, local } (the data on this device, or GitHub's repo). */
export async function dataClient(settings = getSettings()) {
  if (isLocal(settings)) return { client: localRepo(), branch: '', path: LOCAL_PATH, local: true };
  const token = await getToken();
  if (!isSyncConfigured(settings) || !token) throw new Error('Set up GitHub sync in Settings first.');
  return { client: createGitHubClient({ token, owner: settings.owner, repo: settings.repo }), branch: settings.branch, path: settings.path, local: false };
}

// tracker.json from two places, item by item (theirs unreadable: nothing is written).
const mergeTracker = (theirs, ours) => {
  const a = parseData(theirs);
  const b = parseData(ours);
  return serializeDocument(mergeItems(a.items, b.items), mergeProjects(a.projects, b.projects), a.extra);
};

/**
 * Moves the data to GitHub ('github', with `patch`: owner, repo, branch, path…, the
 * token already saved) or back to this device ('local'): synced where it is, copied
 * to the other place (nothing removed there), then synced there. The data on this
 * device remembers where it went, so Tracker Editor offers to follow.
 */
export async function switchStorage(to, patch = {}) {
  await syncNow();
  const before = await dataClient();
  const settings = { ...getSettings(), ...patch, storage: to };
  const after = await dataClient(settings);
  if (to === 'github') await after.client.getRepo();
  const result = await moveData({
    from: before.client,
    to: after.client,
    fromBranch: before.branch,
    toBranch: after.branch,
    fromTrackerPath: before.path,
    toTrackerPath: after.path,
    mergeTracker,
    device: settings.device || 'this device',
  });
  await localRepo().setMeta({ movedTo: to === 'github' ? { owner: settings.owner, repo: settings.repo, branch: settings.branch || '', path: settings.path, at: new Date().toISOString(), by: settings.device || '' } : null });
  saveSettings({ ...patch, storage: to });
  if (to === 'local') watchLocal();
  await syncNow();
  return result;
}

/** Where the data on this device went (Tracker Editor or this app moved it to GitHub): { owner, repo, branch } or null. */
export async function movedTo() {
  if (!isLocal()) return null;
  return (await localRepo().getMeta().catch(() => ({}))).movedTo ?? null;
}

let watchingLocal = false;
function watchLocal() {
  if (watchingLocal) return;
  watchingLocal = true;
  onLocalDataChange(() => isLocal() && syncNow());
}

// The data on this device is tidied (old versions dropped) once a day.
async function tidyLocal(client) {
  const { prunedAt } = await client.getMeta();
  if (prunedAt && Date.now() - Date.parse(prunedAt) < 86400000) return;
  await client.prune();
}

const EDIT_DELAY = 4000;
const INTERVAL = 5 * 60 * 1000;
// The desktop app checks every minute, also in the background, so it can
// notify about changes from Claude and other devices.
const DESKTOP_INTERVAL = 60 * 1000;
const FOCUS_MIN_GAP = 60 * 1000;

let state = { phase: 'idle', error: null, lastSyncAt: null, lastPushAt: null };
const listeners = new Set();
const syncedListeners = new Set();

/** Runs `fn` after each sync that worked (files attached meanwhile go up then). */
export function onSynced(fn) {
  syncedListeners.add(fn);
  return () => syncedListeners.delete(fn);
}
let running = null;
let again = false;
let timer = null;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

async function run() {
  const settings = getSettings();
  const local = isLocal(settings);
  const token = local ? null : await getToken();
  if (!local && (!isSyncConfigured(settings) || !token)) {
    set({ phase: 'disabled', error: null });
    return;
  }
  if (!local && navigator.onLine === false) {
    set({ phase: 'offline' });
    return;
  }
  set({ phase: 'syncing', error: null });
  const counter = store.changeCounter;
  try {
    const client = local ? localRepo() : createGitHubClient({ token, owner: settings.owner, repo: settings.repo });
    const result = await syncOnce({
      client,
      path: pathOf(settings),
      branch: local ? '' : settings.branch,
      localItems: store.all(),
      localProjects: store.allProjects(),
      device: settings.device || 'unknown device',
    });
    const before = store.all();
    // The first download on a device is not news; later changes are.
    const firstSync = !store.meta.lastSyncAt;
    store.applySynced(result.items, counter, { sha: result.sha }, result.projects);
    if (!firstSync) notifyChanges(describeChanges(before, store.all(), { self: settings.device }));
    const at = new Date().toISOString();
    set({ phase: 'idle', error: null, lastSyncAt: at, lastPushAt: result.pushed ? at : state.lastPushAt });
    if (local) tidyLocal(client).catch((err) => console.warn('Could not tidy the data on this device', err));
    for (const fn of syncedListeners) fn();
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
  // The desktop app syncs every minute, also in the background; the Android app every minute
  // while it is in front (closed, it looks for changes itself: Changes.java).
  const desktop = isDesktopApp();
  setInterval(
    () => {
      if (getSettings().autoSync && (desktop || document.visibilityState === 'visible')) syncNow();
    },
    window.desktop ? DESKTOP_INTERVAL : INTERVAL,
  );
  window.addEventListener('online', () => getSettings().autoSync && syncNow());
  // Tracker Editor changed the data on this device: sync at once (local mode only, so GitHub users get no data folder).
  if (isLocal()) watchLocal();
  window.addEventListener('offline', () => set({ phase: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (!getSettings().autoSync) return;
    if (document.visibilityState === 'hidden' && store.meta.dirty) syncNow();
    if (document.visibilityState === 'visible' && sinceLast() > FOCUS_MIN_GAP) syncNow();
  });
  if (getSettings().autoSync || isLocal()) syncNow();
  else getToken().then((token) => (isSyncConfigured() && token) || set({ phase: 'disabled' }));
}
