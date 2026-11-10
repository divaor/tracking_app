// The assistant's chats on this device (assistantChats.js says what one is): the list in kv
// `assistantChats` (rows, newest first), each chat in `assistantChat:<id>`, written a moment after
// it changes (flush() writes at once: main.js calls it as the page goes away). `current` is the
// chat the panel showed last (kv `assistantChats:current`), taken up when it opens again; null
// means New chat was asked for. Nothing here is synced. (Tracker Editor's chatStore.js, for one panel.)
import { chatRow, MAX_CHATS, pruneIndex, shrinkChat, withRow } from './assistantChats.js';
import { kvDel, kvGet, kvSet } from './kv.js';

const INDEX = 'assistantChats';
const CURRENT = 'assistantChats:current';
const recordKey = (id) => `assistantChat:${id}`;

/** A plain copy (no functions), as IndexedDB keeps it. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** `get`/`set`/`del`: the storage (kv.js's in the app, a Map in the tests). */
export function createChatStore({ get, set, del, wait = 300, max = MAX_CHATS, now = () => new Date().toISOString() }) {
  let index = null;
  let current; // id | null | undefined (none known)
  let loading = null;
  const records = new Map();
  const dirty = new Set();
  let indexDirty = false;
  let currentDirty = false;
  let timer = null;
  const listeners = new Set();

  const ready = () =>
    (loading ??= Promise.all([get(INDEX), get(CURRENT)])
      .then(([rows, cur]) => {
        index = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
        current = typeof cur === 'string' || cur === null ? cur : undefined;
      })
      .catch(() => {
        index = [];
        current = undefined;
      }));
  const emit = () => listeners.forEach((fn) => fn());
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), wait);
  };

  // Every write starts at once: as the page goes away, only what has started gets written.
  async function flush() {
    clearTimeout(timer);
    timer = null;
    const writes = [...dirty].map((id) => records.get(id) && set(recordKey(id), records.get(id)));
    dirty.clear();
    if (indexDirty) writes.push(set(INDEX, index));
    if (currentDirty) writes.push(set(CURRENT, current ?? null));
    indexDirty = currentDirty = false;
    await Promise.all(writes);
  }

  function keep(chat, { touch = true } = {}) {
    const at = now();
    const kept = shrinkChat(plain({ ...chat, createdAt: chat.createdAt ?? at, updatedAt: touch || !chat.updatedAt ? at : chat.updatedAt }));
    records.set(kept.id, kept);
    dirty.add(kept.id);
    const pruned = pruneIndex(withRow(index, chatRow(kept)), max);
    index = pruned.index;
    for (const id of pruned.dropped) {
      records.delete(id);
      dirty.delete(id);
      Promise.resolve(del(recordKey(id))).catch(() => {});
    }
    indexDirty = true;
    schedule();
    emit();
    return kept;
  }

  const store = {
    ready,
    /** The rows, newest first ([] until ready()). */
    list: () => index ?? [],
    async load(id) {
      await ready();
      if (records.has(id)) return records.get(id);
      if (!index.some((r) => r.id === id)) return null;
      const chat = await get(recordKey(id)).catch(() => null);
      if (chat?.id !== id) return null;
      records.set(id, chat);
      return chat;
    },
    /** Keeps a chat made or changed (first in the list); kept at once once ready. */
    save(chat) {
      return index ? Promise.resolve(keep(chat)) : ready().then(() => keep(chat));
    },
    /** Keeps a chat as it was (Undo of a delete): its place in the list by when it last changed. */
    async restore(chat) {
      await ready();
      return keep(chat, { touch: false });
    },
    async setSaved(id, saved) {
      const chat = await store.load(id);
      return chat ? keep({ ...chat, saved: Boolean(saved) }, { touch: false }) : null;
    },
    async rename(id, title) {
      const chat = await store.load(id);
      const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return chat && name ? keep({ ...chat, title: name, named: true }, { touch: false }) : null;
    },
    /** Deletes a chat; returns it (Undo keeps it again). */
    async remove(id) {
      const chat = await store.load(id);
      index = index.filter((r) => r.id !== id);
      records.delete(id);
      dirty.delete(id);
      if (current === id) {
        current = undefined;
        currentDirty = true;
      }
      indexDirty = true;
      await Promise.resolve(del(recordKey(id))).catch(() => {});
      await flush();
      emit();
      return chat;
    },
    /** Deletes every chat (the saved ones too, unless `keepSaved`); returns how many went. */
    async removeAll({ keepSaved = false } = {}) {
      await ready();
      const going = index.filter((r) => !(keepSaved && r.saved)).map((r) => r.id);
      for (const id of going) {
        records.delete(id);
        dirty.delete(id);
        await Promise.resolve(del(recordKey(id))).catch(() => {});
      }
      const gone = new Set(going);
      index = index.filter((r) => !gone.has(r.id));
      if (gone.has(current)) current = undefined;
      indexDirty = currentDirty = true;
      await flush();
      emit();
      return going.length;
    },
    /** The chat the panel showed last (undefined: none known; null: New chat was asked for). */
    current: () => (current && !index?.some((r) => r.id === current) ? undefined : current),
    setCurrent(id) {
      if (current === (id ?? null)) return;
      current = id ?? null;
      currentDirty = true;
      schedule();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    flush,
  };
  return store;
}

/** The app's assistant chats (kv: IndexedDB). */
export const assistantChats = createChatStore({ get: kvGet, set: kvSet, del: kvDel, wait: 60 });
