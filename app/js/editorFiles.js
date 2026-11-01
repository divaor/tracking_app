// Tracker Editor's files, read for Find by asking (2.6, across apps): editor/index.json through the
// data client (GitHub, or the data on this device), the texts fetched when a search needs them and
// kept by blob sha (up to KEEP_BYTES in all, the oldest go first). Encrypted files (`encrypted`, or a
// text that starts with the mark) are never fetched, kept or read: they are found by name only. Read
// again after each sync once a search has used them.
import { editorEncrypted, editorTextPath, EDITOR_INDEX, ENCRYPTED_MARK, parseEditorIndex } from './findSources.js';
import { kvDel, kvGet, kvSet } from './kv.js';
import { dataClient, onSynced } from './syncManager.js';

// Texts larger than this are not searched (as the connector's search).
export const MAX_EDITOR_TEXT = 300 * 1024;
const KEEP_BYTES = 20 * 1024 * 1024;

let records = null; // the live records last read (null: never asked)
let reading = null;
let kept = null; // [{ sha, size }], oldest first (kv 'editorTexts')

async function readIndex() {
  const { client, branch } = await dataClient();
  const file = await client.getFile(EDITOR_INDEX, branch || undefined);
  const list = file ? parseEditorIndex(file.text) : [];
  // An index that cannot be read: what was read before stays.
  if (list) {
    records = list;
    await kvSet('editorIndex', list).catch(() => {});
  }
  return records ?? [];
}

/** The editor's files (live records), read from the data (`fresh`) or as read last ([] when there is no editor data). */
export async function editorRecords({ fresh = false } = {}) {
  if (records && !fresh) return records;
  reading ??= (async () => {
    try {
      return await readIndex();
    } catch {
      records ??= (await kvGet('editorIndex').catch(() => null)) ?? [];
      return records;
    } finally {
      reading = null;
    }
  })();
  return reading;
}

const loadKept = async () => (kept ??= (await kvGet('editorTexts').catch(() => null)) ?? []);

async function keep(sha, text) {
  await loadKept();
  kept = [...kept.filter((k) => k.sha !== sha), { sha, size: text.length }];
  let total = kept.reduce((n, k) => n + k.size, 0);
  while (total > KEEP_BYTES && kept.length > 1) {
    const old = kept.shift();
    total -= old.size;
    kvDel(`editorText:${old.sha}`).catch(() => {});
  }
  await kvSet(`editorText:${sha}`, text).catch(() => {});
  await kvSet('editorTexts', kept).catch(() => {});
}

/**
 * The texts of the editor's files (not encrypted, not too large): kept ones at once, the rest fetched,
 * newest first, at most `fetch` of them within `budgetMs`. Returns Map(id → text); a text that turns
 * out encrypted comes back as the mark alone (never kept, nothing of it read).
 */
export async function editorTexts(list, { fetch = 60, budgetMs = 4000 } = {}) {
  const out = new Map();
  const missing = [];
  for (const r of list) {
    if (editorEncrypted(r) || (r.size ?? 0) > MAX_EDITOR_TEXT) continue;
    const text = r.sha ? await kvGet(`editorText:${r.sha}`).catch(() => null) : null;
    if (typeof text === 'string') out.set(r.id, text);
    else missing.push(r);
  }
  if (!missing.length || fetch <= 0) return out;
  let client;
  let branch;
  try {
    ({ client, branch } = await dataClient());
  } catch {
    return out;
  }
  const until = Date.now() + budgetMs;
  const newest = missing.sort((a, b) => String(b.modifiedAt ?? b.updatedAt ?? '').localeCompare(String(a.modifiedAt ?? a.updatedAt ?? ''))).slice(0, fetch);
  for (let i = 0; i < newest.length && Date.now() < until; i += 6) {
    const batch = await Promise.all(newest.slice(i, i + 6).map((r) => client.getFile(editorTextPath(r), branch || undefined).then((f) => [r, f], () => [r, null])));
    for (const [r, file] of batch) {
      if (!file) continue;
      if (editorEncrypted(r, file.text)) {
        out.set(r.id, ENCRYPTED_MARK);
        continue;
      }
      out.set(r.id, file.text);
      if (file.sha || r.sha) keep(file.sha || r.sha, file.text).catch(() => {});
    }
  }
  return out;
}

// Once a search used them, the editor's files are read again after each sync (they change elsewhere).
onSynced(() => {
  if (records) editorRecords({ fresh: true }).catch(() => {});
});
