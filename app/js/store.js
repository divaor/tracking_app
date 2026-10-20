// In-memory item store persisted to IndexedDB. Deleted items are kept as
// tombstones so deletions sync to other devices.
import { kvGet, kvSet } from './kv.js';
import { getSettings } from './settings.js';
import {
  applyPatch,
  createItem,
  mergeItems,
  normalizeItem,
  nowIso,
  pruneTombstones,
  reviveItem,
  serializeDocument,
  tombstone,
} from './model.js';

const ITEMS_KEY = 'items';
const META_KEY = 'meta';

let items = [];
let visible = [];
let meta = { dirty: false, lastSyncAt: null, sha: null };
let changeCounter = 0;
const listeners = new Set();
// Edits made here are attributed to this device's name (see notifications).
const author = () => getSettings().device || '';

function save() {
  kvSet(ITEMS_KEY, items).catch((err) => console.error('Saving items failed', err));
  kvSet(META_KEY, meta).catch((err) => console.error('Saving sync state failed', err));
}

function setItems(next, reason) {
  items = next;
  visible = items.filter((i) => !i.deleted);
  for (const fn of listeners) fn(reason);
}

function commitLocal(next) {
  changeCounter++;
  meta = { ...meta, dirty: true };
  setItems(next, 'local');
  save();
}

export const store = {
  async load() {
    const saved = await kvGet(ITEMS_KEY);
    meta = { ...meta, ...((await kvGet(META_KEY)) ?? {}) };
    setItems(Array.isArray(saved) ? saved.map(normalizeItem) : [], 'load');
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

  // Merges items from an exported file; newer versions win.
  importItems(list) {
    const merged = mergeItems(items, list.map(normalizeItem));
    const added = merged.length - items.length;
    if (serializeDocument(merged) !== serializeDocument(items)) commitLocal(merged);
    return added;
  },

  // Applies the result of a sync round. Edits made while the round was in
  // flight are newer, so they win the merge and stay marked as unsynced.
  applySynced(synced, counterAtStart, metaPatch = {}) {
    const merged = pruneTombstones(mergeItems(items, synced));
    const changed = serializeDocument(merged) !== serializeDocument(items);
    meta = { ...meta, ...metaPatch, lastSyncAt: nowIso(), dirty: changeCounter !== counterAtStart };
    if (changed) setItems(merged, 'remote');
    save();
  },

  markUnsynced() {
    meta = { ...meta, dirty: true, sha: null };
    save();
  },

  clear() {
    changeCounter++;
    meta = { dirty: false, lastSyncAt: null, sha: null };
    setItems([], 'reset');
    save();
  },
};
