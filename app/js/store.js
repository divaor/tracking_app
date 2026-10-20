// In-memory item and project store persisted to IndexedDB. Deleted records
// are kept as tombstones so deletions sync to other devices.
import { kvGet, kvSet } from './kv.js';
import { getSettings } from './settings.js';
import {
  applyPatch,
  createItem,
  deleteProjectIn,
  mergeItems,
  mergeProjects,
  normalizeItem,
  normalizeProject,
  nowIso,
  pruneTombstones,
  renameProjectIn,
  retagItems,
  reviveItem,
  serializeDocument,
  tombstone,
  upsertProjectRecord,
} from './model.js';

const ITEMS_KEY = 'items';
const PROJECTS_KEY = 'projects';
const META_KEY = 'meta';

let items = [];
let visible = [];
let projects = [];
let liveProjects = [];
let meta = { dirty: false, lastSyncAt: null, sha: null };
let changeCounter = 0;
const listeners = new Set();
// Edits made here are attributed to this device's name (see notifications).
const author = () => getSettings().device || '';

function save() {
  kvSet(ITEMS_KEY, items).catch((err) => console.error('Saving items failed', err));
  kvSet(PROJECTS_KEY, projects).catch((err) => console.error('Saving projects failed', err));
  kvSet(META_KEY, meta).catch((err) => console.error('Saving sync state failed', err));
}

function setData(nextItems, nextProjects, reason) {
  items = nextItems;
  visible = items.filter((i) => !i.deleted);
  projects = nextProjects;
  liveProjects = projects.filter((p) => !p.deleted);
  for (const fn of listeners) fn(reason);
}

function commitLocal(nextItems, nextProjects = projects) {
  changeCounter++;
  meta = { ...meta, dirty: true };
  setData(nextItems, nextProjects, 'local');
  save();
}

const snapshot = (i, p) => serializeDocument(i, p);

export const store = {
  async load() {
    const savedItems = await kvGet(ITEMS_KEY);
    const savedProjects = await kvGet(PROJECTS_KEY);
    meta = { ...meta, ...((await kvGet(META_KEY)) ?? {}) };
    setData(
      Array.isArray(savedItems) ? savedItems.map(normalizeItem) : [],
      Array.isArray(savedProjects) ? savedProjects.map(normalizeProject) : [],
      'load',
    );
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  get changeCounter() {
    return changeCounter;
  },
  get meta() {
    return meta;
  },

  all: () => items,
  visible: () => visible,
  get: (id) => visible.find((i) => i.id === id),
  allProjects: () => projects,
  projects: () => liveProjects,

  add(fields) {
    const item = createItem({ ...fields, updatedBy: author() });
    commitLocal([...items, item]);
    return item;
  },

  update(id, patch) {
    let updated = null;
    commitLocal(items.map((i) => (i.id === id && !i.deleted ? (updated = applyPatch(i, { ...patch, updatedBy: author() })) : i)));
    return updated;
  },

  remove(id) {
    const previous = store.get(id);
    if (!previous) return null;
    commitLocal(items.map((i) => (i.id === id ? tombstone(i, undefined, author()) : i)));
    return previous;
  },

  restore(previous) {
    const current = items.find((i) => i.id === previous.id);
    const revived = { ...reviveItem(previous, current), updatedBy: author() };
    commitLocal(current ? items.map((i) => (i.id === previous.id ? revived : i)) : [...items, revived]);
  },

  // ---- Projects and tags ------------------------------------------------

  saveProject(name, patch = {}) {
    commitLocal(items, upsertProjectRecord(projects, name, patch, nowIso(), author()));
  },

  // Renames a project (merging into another if the new name exists) and
  // moves its items along.
  renameProject(from, to) {
    const next = renameProjectIn({ items, projects }, from, to, nowIso(), author());
    commitLocal(next.items, next.projects);
  },

  // Deletes a project; its items stay, without a project.
  deleteProject(name) {
    const next = deleteProjectIn({ items, projects }, name, nowIso(), author());
    commitLocal(next.items, next.projects);
  },

  renameTag(from, to) {
    commitLocal(retagItems(items, from, to, nowIso(), author()));
  },

  deleteTag(tag) {
    commitLocal(retagItems(items, tag, '', nowIso(), author()));
  },

  // ---- Import and sync --------------------------------------------------

  // Merges an exported file; for each item or project the newer version wins.
  importData(data) {
    const mergedItems = mergeItems(items, data.items.map(normalizeItem));
    const mergedProjects = mergeProjects(projects, (data.projects ?? []).map(normalizeProject));
    const added = mergedItems.length - items.length;
    if (snapshot(mergedItems, mergedProjects) !== snapshot(items, projects)) commitLocal(mergedItems, mergedProjects);
    return added;
  },

  // Applies the result of a sync round. Edits made while the round was in
  // flight are newer, so they win the merge and stay marked as unsynced.
  applySynced(syncedItems, counterAtStart, metaPatch = {}, syncedProjects = []) {
    const now = nowIso();
    const mergedItems = pruneTombstones(mergeItems(items, syncedItems), now);
    const mergedProjects = pruneTombstones(mergeProjects(projects, syncedProjects), now);
    const changed = snapshot(mergedItems, mergedProjects) !== snapshot(items, projects);
    meta = { ...meta, ...metaPatch, lastSyncAt: now, dirty: changeCounter !== counterAtStart };
    if (changed) setData(mergedItems, mergedProjects, 'remote');
    save();
  },

  markUnsynced() {
    meta = { ...meta, dirty: true, sha: null };
    save();
  },

  clear() {
    changeCounter++;
    meta = { dirty: false, lastSyncAt: null, sha: null };
    setData([], [], 'reset');
    save();
  },
};
