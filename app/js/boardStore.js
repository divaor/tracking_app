// Release boards kept with the data (boards.js says what they hold): listed and read from the data
// repo (or the data on this device), kept here so they show at once and offline, read again after
// each sync (only those whose file changed). Importing a board file merges it with what is there.
import { kvGet, kvSet } from './kv.js';
import { boardFromData, boardPath, boardScript, BOARDS_DIR, boardSlug, mergeBoards, parseBoard, serializeBoard } from './boards.js';
import { nowIso } from './model.js';
import { getSettings } from './settings.js';
import { dataClient, onSynced } from './syncManager.js';

let index = null; // [{ slug, project, sha }]
const boards = new Map(); // slug → { sha, board }
const listeners = new Set();
let loading = null;

const announce = () => listeners.forEach((fn) => fn());

/** Calls `fn()` whenever the boards listed or read here change. */
export function onBoards(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The boards known here: [{ slug, project, sha }], by project name. */
export const cachedBoards = () => index ?? [];
/** A board read here (null when not read yet). */
export const cachedBoard = (slug) => boards.get(slug)?.board ?? null;

async function loadKept() {
  if (index) return;
  index = (await kvGet('boards:index').catch(() => null)) ?? [];
  for (const { slug } of index) {
    const kept = await kvGet(`board:${slug}`).catch(() => null);
    const board = kept?.board && parseBoard(kept.board);
    if (board) boards.set(slug, { sha: kept.sha ?? '', board });
  }
  if (index.length) announce();
}

async function keep(slug, sha, board) {
  boards.set(slug, { sha, board });
  await kvSet(`board:${slug}`, { sha, board }).catch(() => {});
}

const byName = (a, b) => a.project.localeCompare(b.project, undefined, { sensitivity: 'base' });

/** Lists the boards in the data and reads those that changed. Returns the list. */
export function refreshBoards() {
  loading ??= (async () => {
    try {
      await loadKept();
      const { client, branch } = await dataClient();
      const entries = ((await client.listDir(BOARDS_DIR, branch || undefined)) ?? []).filter((e) => e.type === 'file' && /\.json$/.test(e.name));
      const next = [];
      for (const entry of entries) {
        const slug = entry.name.replace(/\.json$/, '');
        const known = boards.get(slug);
        let board = known?.board;
        if (!known || (entry.sha && known.sha !== entry.sha)) {
          const file = await client.getFile(entry.path, branch || undefined);
          board = file && parseBoard(file.text);
          if (board) await keep(slug, file.sha ?? entry.sha, board);
        }
        if (board) next.push({ slug, project: board.project || slug, sha: boards.get(slug)?.sha ?? '' });
      }
      next.sort(byName);
      const changed = JSON.stringify(next) !== JSON.stringify(index);
      index = next;
      await kvSet('boards:index', index).catch(() => {});
      if (changed) announce();
    } catch {
      await loadKept().catch(() => {});
    } finally {
      loading = null;
    }
    return index;
  })();
  return loading;
}

/**
 * Imports a board file (the standalone page, its data script or JSON) into `project`'s board:
 * merged with what is there (nothing deleted), written at the version read, retried when it moved.
 * Returns { slug, project, counts }.
 */
export async function importBoardFile(text, project) {
  const name = String(project ?? '').trim();
  if (!name) throw new Error('Choose the project the board belongs to.');
  const device = getSettings().device || 'this device';
  const imported = boardFromData(text, { project: name, at: nowIso(), by: device });
  const { client, branch } = await dataClient();
  const path = boardPath(name);
  for (let attempt = 0; attempt < 4; attempt++) {
    const file = await client.getFile(path, branch || undefined);
    const there = file ? parseBoard(file.text) : null;
    if (file && !there) throw new Error(`${path} cannot be read, so it was left as it is.`);
    const board = there ? mergeBoards(there, { ...imported, project: there.project || name }) : imported;
    try {
      const { sha } = await client.putFile(path, { text: serializeBoard(board), sha: file?.sha, branch: branch || undefined, message: `Tracker: release board “${board.project}” imported (from ${device})` });
      const slug = boardSlug(name);
      await keep(slug, sha ?? '', board);
      index = [...(index ?? []).filter((b) => b.slug !== slug), { slug, project: board.project, sha: sha ?? '' }].sort(byName);
      await kvSet('boards:index', index).catch(() => {});
      announce();
      const counts = {};
      for (const part of ['releases', 'features', 'tests', 'decisions']) counts[part] = imported[part].length;
      return { slug, project: board.project, counts };
    } catch (err) {
      if (err?.status !== 409 && err?.status !== 422) throw err;
    }
  }
  throw new Error('The board kept changing elsewhere; try again.');
}

/** The months of a board's older log (boards/<slug>/log-<month>.json, the connector's archive), newest first. */
export async function olderLogMonths(slug) {
  const { client, branch } = await dataClient();
  const entries = (await client.listDir(`${BOARDS_DIR}/${slug}`, branch || undefined)) ?? [];
  return entries
    .map((e) => e.type === 'file' && /^log-(.+)\.json$/.exec(e.name)?.[1])
    .filter(Boolean)
    .sort()
    .reverse();
}

/** A month of a board's older log, newest first ([] when it cannot be read). */
export async function olderLog(slug, month) {
  const { client, branch } = await dataClient();
  const file = await client.getFile(`${BOARDS_DIR}/${slug}/log-${month}.json`, branch || undefined);
  try {
    const log = JSON.parse(file?.text ?? '{}').log;
    return Array.isArray(log) ? log.filter((l) => l && !l.deleted) : [];
  } catch {
    return [];
  }
}

/** The board as its standalone page's data script: { name, text }. */
export function exportBoardFile(slug) {
  const board = cachedBoard(slug);
  if (!board) throw new Error('That board is not read yet.');
  return { name: `${slug}-board.js`, text: boardScript(board) };
}

onSynced(() => refreshBoards().catch(() => {}));
