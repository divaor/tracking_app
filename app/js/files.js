// Files attached to items: stored in the data repo (or, in local mode, in the data on this
// device); items keep a reference ({ path, name, size, sha, … }). Contents are cached by
// blob sha, so each version is downloaded once per device. Files attached here are kept on
// this device until they are uploaded (at once, or with the next sync when offline).
import { blobSha } from './localRepo.js';
import { kvDel, kvGet, kvSet } from './kv.js';
import { attachmentKind, filesFolder, freeFilePath, mimeOf } from './model.js';
import { getSettings } from './settings.js';
import { store } from './store.js';
import { dataClient, onSynced } from './syncManager.js';

/** The largest file that can be attached. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Photos larger than this are made smaller (unless kept at full size) to this many pixels on the long side.
export const SHRINK_OVER = 4 * 1024 * 1024;
const SHRINK_TO = 2560;
// Downloaded versions are kept on this device up to this much in all (the oldest go first), each up to CACHE_EACH.
const CACHE_TOTAL = 200 * 1024 * 1024;
const CACHE_EACH = 16 * 1024 * 1024;
const THUMB_SIZE = 360;

const author = () => getSettings().device || 'unknown device';
const notFound = (file, local) =>
  new Error(local ? `${file.name} is not in the data on this computer (yet).` : `${file.name} is not in ${getSettings().owner}/${getSettings().repo} (yet). It may still be uploading from another device; try syncing.`);

export async function loadFileText(file) {
  const key = file.sha ? `file:${file.sha}` : '';
  if (key) {
    const cached = await kvGet(key);
    if (typeof cached === 'string') return cached;
  }
  const pending = await kvGet(`pending:${file.path}`);
  if (pending?.bytes) return new TextDecoder().decode(pending.bytes);
  const { client, branch, local } = await dataClient();
  const result = await client.getFile(file.path, branch || undefined);
  if (!result) throw notFound(file, local);
  kvSet(`file:${result.sha}`, result.text).catch(() => {});
  return result.text;
}

// Writes an edited file back (ticked checklists) and returns its new sha.
// Sending the sha it was loaded at means a version changed elsewhere in the
// meantime is never overwritten: the store answers 409 or 422 instead.
export async function saveFileText(file, text) {
  const { client, branch } = await dataClient();
  const { sha } = await client.putFile(file.path, {
    text,
    sha: file.sha,
    branch: branch || undefined,
    message: `Tracker: update ${file.name} (from ${author()})`,
  });
  kvSet(`file:${sha}`, text).catch(() => {});
  return sha;
}

// ---- Bytes: pictures, PDFs, documents… -------------------------------------------------

// The cached versions, oldest first: [{ sha, size }] (kv 'bytesIndex').
let cacheIndex = null;
const loadIndex = async () => (cacheIndex ??= (await kvGet('bytesIndex')) ?? []);

async function cacheBytes(sha, bytes) {
  if (!sha || bytes.length > CACHE_EACH) return;
  const index = (await loadIndex()).filter((e) => e.sha !== sha);
  index.push({ sha, size: bytes.length });
  let total = index.reduce((n, e) => n + e.size, 0);
  while (total > CACHE_TOTAL && index.length > 1) {
    const old = index.shift();
    total -= old.size;
    kvDel(`bytes:${old.sha}`).catch(() => {});
    kvDel(`thumb:${old.sha}`).catch(() => {});
  }
  cacheIndex = index;
  await kvSet(`bytes:${sha}`, bytes).catch(() => {});
  kvSet('bytesIndex', index).catch(() => {});
}

/** A file's bytes: waiting to upload here, cached, or downloaded (and cached). */
export async function loadFileBytes(file) {
  const pending = await kvGet(`pending:${file.path}`);
  if (pending?.bytes) return pending.bytes;
  if (file.sha) {
    const cached = await kvGet(`bytes:${file.sha}`);
    if (cached instanceof Uint8Array) return cached;
  }
  const { client, branch, local } = await dataClient();
  let bytes;
  try {
    bytes = file.sha ? await client.getBlobBytes(file.sha) : (await client.getFileBytes(file.path, branch || undefined))?.bytes;
  } catch (err) {
    if (err?.status === 404) throw notFound(file, local);
    throw err;
  }
  if (!bytes) throw notFound(file, local);
  await cacheBytes(file.sha, bytes);
  return bytes;
}

export const blobOf = (file, bytes) => new Blob([bytes], { type: mimeOf(file) });

/** A small picture of an image attachment (a Blob, kept by sha), or null when the browser cannot draw it (HEIC…). */
export async function thumbnailOf(file) {
  const key = file.sha ? `thumb:${file.sha}` : '';
  if (key) {
    const cached = await kvGet(key);
    if (cached instanceof Blob) return cached;
  }
  const bytes = await loadFileBytes(file);
  if (mimeOf(file) === 'image/svg+xml' || mimeOf(file) === 'image/gif') return blobOf(file, bytes);
  const thumb = await scaledImage(blobOf(file, bytes), THUMB_SIZE, 'image/webp', 0.8).catch(() => null);
  if (thumb && key) kvSet(key, thumb).catch(() => {});
  return thumb;
}

// A picture drawn at most `size` pixels on its long side, as `type` (null when it is already smaller).
async function scaledImage(blob, size, type, quality, { onlyIfSmaller = false } = {}) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  if (onlyIfSmaller && scale === 1) {
    bitmap.close?.();
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the picture'))), type, quality));
}

// A photo made smaller: { bytes, type, name } (the name's extension follows the type), or null to keep it.
async function shrinkPhoto(blob, name) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) return null;
  const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const smaller = await scaledImage(blob, SHRINK_TO, type, 0.85, { onlyIfSmaller: true }).catch(() => null);
  if (!smaller || smaller.size >= blob.size) return null;
  const ext = type === 'image/png' ? '.png' : '.jpg';
  return { bytes: new Uint8Array(await smaller.arrayBuffer()), type, name: name.replace(/\.[^.]+$/, '') + ext };
}

const looksLikeText = (bytes) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

// A name for a picture pasted or taken without one ("image.png"): when it came in, here.
function nameFor(file) {
  const name = (file.name || '').trim();
  if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name;
  const ext = (/\/(\w+)/.exec(file.type)?.[1] ?? 'png').replace('jpeg', 'jpg');
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `Pasted ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}.${ext}`;
}

// ---- Attaching, uploading, removing ----------------------------------------------------

// Paths waiting to upload from this device (kv 'pendingFiles'), and who wants to know.
let pending = null;
const pendingListeners = new Set();
const loadPending = async () => (pending ??= new Set((await kvGet('pendingFiles')) ?? []));
const savePending = () => kvSet('pendingFiles', [...pending]).catch(() => {});
const announce = () => pendingListeners.forEach((fn) => fn(new Set(pending)));

/** Calls `fn(paths)` with the files waiting to upload from this device, now and when it changes. */
export function onPendingFiles(fn) {
  pendingListeners.add(fn);
  loadPending().then(() => fn(new Set(pending)));
  return () => pendingListeners.delete(fn);
}

/**
 * Attaches `files` (File objects: picked, dropped, pasted, from the camera) to an item. Photos over
 * SHRINK_OVER are made smaller unless `fullSize`. Returns { added: [records], skipped: [{ name, reason }],
 * shrunk: [{ path, file, from, to }] } (the photos made smaller, with the original File); they upload at
 * once, or with the next sync.
 */
export async function attachFiles(itemId, files, { fullSize = false } = {}) {
  const item = store.get(itemId);
  if (!item) return { added: [], skipped: [], shrunk: [] };
  await loadPending();
  const folder = filesFolder(item);
  const taken = new Set(item.files.map((f) => f.path));
  const added = [];
  const skipped = [];
  const shrunk = [];
  for (const file of files) {
    const at = new Date().toISOString();
    let name = nameFor(file);
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ name, reason: `over ${MAX_FILE_BYTES / 1024 / 1024} MB` });
      continue;
    }
    let bytes = new Uint8Array(await file.arrayBuffer());
    let type = file.type || mimeOf({ name });
    let smaller = null;
    if (!fullSize && bytes.length > SHRINK_OVER && attachmentKind({ name }) === 'image') {
      smaller = await shrinkPhoto(new Blob([bytes], { type }), name);
      if (smaller) {
        shrunk.push({ file, from: bytes.length, to: smaller.bytes.length });
        ({ bytes, type, name } = smaller);
      }
    }
    const path = freeFilePath(folder, name, taken);
    if (smaller) shrunk.at(-1).path = path;
    taken.add(path);
    const sha = await blobSha(bytes);
    const record = { path, name, size: bytes.length, sha, addedAt: at, type, ...(attachmentKind({ name }) === 'text' && !looksLikeText(bytes) ? { binary: true } : {}) };
    await kvSet(`pending:${path}`, { bytes, sha, name, itemId, at });
    await cacheBytes(sha, bytes);
    pending.add(path);
    added.push(record);
  }
  if (added.length) {
    savePending();
    announce();
    const latest = store.get(itemId);
    store.update(itemId, { files: [...(latest?.files ?? []), ...added] });
    uploadPending().catch(() => {});
  }
  return { added, skipped, shrunk };
}

let uploading = null;
/** Uploads the files waiting on this device; those that fail stay for the next sync. */
export function uploadPending() {
  uploading ??= (async () => {
    try {
      await loadPending();
      if (!pending.size) return;
      const { client, branch } = await dataClient();
      for (const path of [...pending]) {
        const entry = await kvGet(`pending:${path}`);
        if (!entry?.bytes) {
          pending.delete(path);
          continue;
        }
        const item = store.get(entry.itemId);
        if (!item?.files.some((f) => f.path === path)) {
          // Removed from its item (Undo may bring it back): kept a day, then let go.
          if (Date.now() - Date.parse(entry.at) > 86400000) {
            pending.delete(path);
            kvDel(`pending:${path}`).catch(() => {});
          }
          continue;
        }
        const message = `Tracker: attach ${entry.name} to “${item.title}” (from ${author()})`;
        try {
          await client.putFileBytes(path, { bytes: entry.bytes, branch: branch || undefined, message });
        } catch (err) {
          if (err?.status !== 422 && err?.status !== 409) throw err;
          // There already: the same version (an upload whose answer was lost), or another to replace.
          const there = await client.getFileBytes(path, branch || undefined);
          if (there?.sha !== entry.sha) await client.putFileBytes(path, { bytes: entry.bytes, sha: there?.sha, branch: branch || undefined, message });
        }
        pending.delete(path);
        await kvDel(`pending:${path}`);
        savePending();
        announce();
      }
    } finally {
      uploading = null;
    }
  })();
  return uploading;
}

onSynced(() => uploadPending().catch((err) => console.warn('Files are still waiting to upload', err)));

/** Removes a file from its item (Undo puts it back); the file stays in the data's history. */
export function detachFile(itemId, path) {
  const item = store.get(itemId);
  const file = item?.files.find((f) => f.path === path);
  if (!file) return null;
  store.update(itemId, { files: item.files.filter((f) => f.path !== path) });
  return () => {
    const latest = store.get(itemId);
    if (latest && !latest.files.some((f) => f.path === path)) store.update(itemId, { files: [...latest.files, file] });
    uploadPending().catch(() => {});
  };
}

/** Saves a file to the device (the browser's downloads). */
export async function downloadFile(file) {
  const url = URL.createObjectURL(blobOf(file, await loadFileBytes(file)));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Opens a file with its program: the desktop app hands a copy to the program set for its type;
 * a browser downloads it. Resolves 'opened' or 'downloaded'.
 */
export async function openFileOutside(file) {
  const bytes = await loadFileBytes(file);
  if (window.desktop?.openFile) {
    await window.desktop.openFile(file.name, bytes);
    return 'opened';
  }
  await downloadFile(file);
  return 'downloaded';
}
