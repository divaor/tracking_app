// Release boards (pure; the connector uses it too): one file per project, boards/<slug>.json, with
// what a release board shows (releases, features, tests, decisions, events, sessions, repos, the
// actions waiting on the person, briefs and a log). Records merge one by one: the one changed last
// wins, deletions are tombstones, so Claude's sessions and the devices never lose each other's
// changes. A board file of the standalone page (`window.NAME = { … }`) imports and exports as it is.
import { bumpTime, nowIso, slugify } from './model.js';

export const BOARDS_DIR = 'boards';
export const BOARD_VERSION = 1;
// The parts of a board; every record in them has an `id`.
export const BOARD_PARTS = ['releases', 'features', 'tests', 'decisions', 'events', 'sessions', 'repos', 'actions', 'briefs', 'log'];
// Parts whose records have no id in a board data file: made from this field (sessions, repos,
// briefs) or from the text (actions, log), and left out again on export.
const NATURAL_ID = { sessions: 'name', repos: 'repo', briefs: 'code' };
const DERIVED_IDS = new Set(['sessions', 'repos', 'briefs', 'actions', 'log']);
// Fields the board keeps on each record and on `meta` / `now` (not part of the data file).
const STAMPS = ['updatedAt', 'updatedBy'];
export const MAX_LOG = 500;
export const MAX_CHANGES = 200;
const MAX_RECORD_CHARS = 60_000;
const TOMBSTONE_DAYS = 180;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const STATUS_LABELS = {
  live: 'Live', closed: 'Closed', testing: 'Testing', deploying: 'Deploying', merged: 'Merged, not deployed', built: 'Built on a branch',
  in_progress: 'In progress', planned: 'Planned', proposal: 'Proposal', blocked: 'Blocked', waiting: 'Waiting', partly_live: 'Partly live',
  open: 'Open', decided: 'Decided', passed: 'Passed', failed: 'Failed', scheduled: 'Scheduled', done: 'Done', pending: 'Pending', held: 'Held',
};
export const STATUSES = Object.keys(STATUS_LABELS);
// What counts as there: a feature live, a release out (fully or partly), a test passed.
const LIVE = new Set(['live', 'closed', 'done']);
const RELEASE_OUT = new Set(['live', 'closed', 'partly_live', 'deploying', 'testing']);
const TEST_PASSED = new Set(['passed', 'done']);

export const statusLabel = (status) => STATUS_LABELS[status] ?? String(status ?? '').replace(/_/g, ' ');
export const isLive = (status) => LIVE.has(status);

/** The board file of a project: boards/<slug of its name>.json. */
export const boardSlug = (project) => slugify(project, 60);
export const boardPath = (project) => `${BOARDS_DIR}/${boardSlug(project)}.json`;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// FNV-1a: short, stable ids for records that came without one.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** An id that is safe as a key: trimmed, at most 120 characters, or '' when there is none. */
export const cleanId = (id) => str(id).trim().slice(0, 120);

function idFor(part, record) {
  if (record.id != null && cleanId(record.id)) return cleanId(record.id);
  if (NATURAL_ID[part] && cleanId(record[NATURAL_ID[part]])) return cleanId(record[NATURAL_ID[part]]);
  if (part === 'log') return `l-${hash(`${str(record.time)}\u0000${str(record.text)}`)}`;
  if (part === 'actions') return `a-${hash(str(record.text))}`;
  return '';
}

/** "2026-10-31 01:02" in UTC: the board's own way of writing a time (sorts as text). */
export const boardTime = (iso = nowIso()) => iso.slice(0, 16).replace('T', ' ');
const sortKey = (time) => str(time).replace('T', ' ');

export function emptyBoard(project) {
  const board = { version: BOARD_VERSION, project: str(project).trim(), meta: {}, now: {} };
  for (const part of BOARD_PARTS) board[part] = [];
  return board;
}

/** A board read from its file's text (or object): null when it is not one (never written over). */
export function parseBoard(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isObject(data) || typeof data.version !== 'number') return null;
  const board = { ...data, project: str(data.project), meta: isObject(data.meta) ? data.meta : {}, now: isObject(data.now) ? data.now : {} };
  for (const part of BOARD_PARTS) {
    const seen = new Set();
    board[part] = (Array.isArray(data[part]) ? data[part] : []).filter((r) => {
      if (!isObject(r)) return false;
      const id = cleanId(r.id);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return board;
}

export const serializeBoard = (board) => `${JSON.stringify(board, null, 1)}\n`;

const newer = (a, b) => str(b?.updatedAt) > str(a?.updatedAt);

/** Two copies of a board as one: each record (and meta, now) as it was changed last; the log newest first. */
export function mergeBoards(base, other) {
  if (!other) return base;
  if (!base) return other;
  const merged = { ...other, ...base, meta: newer(base.meta, other.meta) ? other.meta : base.meta, now: newer(base.now, other.now) ? other.now : base.now };
  for (const part of BOARD_PARTS) {
    const byId = new Map((base[part] ?? []).map((r) => [r.id, r]));
    const order = (base[part] ?? []).map((r) => r.id);
    for (const r of other[part] ?? []) {
      if (!byId.has(r.id)) order.push(r.id);
      if (!byId.has(r.id) || newer(byId.get(r.id), r)) byId.set(r.id, r);
    }
    merged[part] = order.map((id) => byId.get(id));
  }
  merged.log = sortLog(merged.log);
  return merged;
}

const sortLog = (log) => [...log].sort((a, b) => (sortKey(b.time) > sortKey(a.time) ? 1 : sortKey(b.time) < sortKey(a.time) ? -1 : 0));

/** Live records of a part (no tombstones), in the board's order (`order` first when given). */
export function liveRecords(board, part) {
  const list = (board?.[part] ?? []).filter((r) => !r.deleted);
  if (part === 'log') return list;
  return list.some((r) => typeof r.order === 'number')
    ? list.map((r, i) => [r, i]).sort((a, b) => (a[0].order ?? Infinity) - (b[0].order ?? Infinity) || a[1] - b[1]).map(([r]) => r)
    : list;
}

// A copy of `target` with `value` at the dotted `path` ("dates.deployed", "steps.2.done"); null removes it.
function setPath(target, path, value) {
  const keys = String(path).split('.');
  if (keys.some((k) => !k || BAD_KEYS.has(k))) throw new Error(`“${path}” is not a field name.`);
  const root = Array.isArray(target) ? [...target] : { ...target };
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = node[k];
    const index = /^\d+$/.test(keys[i + 1]);
    node[k] = Array.isArray(next) ? [...next] : isObject(next) ? { ...next } : index ? [] : {};
    node = node[k];
  }
  const last = keys.at(-1);
  if (value === null) {
    if (Array.isArray(node) && /^\d+$/.test(last)) node.splice(Number(last), 1);
    else delete node[last];
  } else node[last] = value;
  return root;
}

/**
 * Applies changes to a board: [{ part, id, set: { field or "a.b.c": value (null removes) }, remove }].
 * A record not there yet is added (at the end). Stamps each changed record with `at` and `by`.
 * Returns { board, changed: [{ part, id, action }] }; throws on a change that cannot be made.
 */
export function applyBoardChanges(board, changes, { at = nowIso(), by = '' } = {}) {
  if (!Array.isArray(changes)) throw new Error('changes must be a list.');
  if (changes.length > MAX_CHANGES) throw new Error(`At most ${MAX_CHANGES} changes at once.`);
  const next = { ...board };
  const changed = [];
  for (const c of changes) {
    const part = str(c?.part);
    if (!BOARD_PARTS.includes(part)) throw new Error(`“${part}” is not a part of a board (${BOARD_PARTS.join(', ')}).`);
    const list = [...next[part]];
    const set = isObject(c.set) ? c.set : {};
    const id = cleanId(c.id) || (c.remove ? '' : idFor(part, set));
    if (!id) throw new Error(`A change to ${part} needs an id.`);
    const at_ = bumpTime(list.find((r) => r.id === id)?.updatedAt, at);
    const index = list.findIndex((r) => r.id === id);
    const before = index >= 0 ? list[index] : null;
    let record;
    if (c.remove) {
      if (!before || before.deleted) continue;
      record = { id, deleted: true, updatedAt: at_, updatedBy: by };
      changed.push({ part, id, action: 'removed' });
    } else {
      record = before && !before.deleted ? { ...before } : { id };
      delete record.deleted;
      for (const [path, value] of Object.entries(set)) {
        if (path === 'id' || STAMPS.includes(path)) continue;
        record = setPath(record, path, value);
      }
      record.updatedAt = at_;
      record.updatedBy = by;
      if (JSON.stringify(record).length > MAX_RECORD_CHARS) throw new Error(`${part} ${id} would be too large (over ${MAX_RECORD_CHARS.toLocaleString('en')} characters).`);
      changed.push({ part, id, action: before && !before.deleted ? 'changed' : 'added' });
    }
    if (index >= 0) list[index] = record;
    else list.push(record);
    next[part] = list;
  }
  next.log = sortLog(next.log);
  return { board: next, changed };
}

/** The board with a log entry added (newest first): { text, release?, item? }. */
export function addLog(board, { text, release, item } = {}, { at = nowIso(), by = '' } = {}) {
  const words = str(text).trim();
  if (!words) return board;
  const entry = { time: boardTime(at), text: words, ...(release ? { release: str(release) } : {}), ...(item ? { item: str(item) } : {}), by };
  entry.id = idFor('log', entry);
  entry.updatedAt = at;
  entry.updatedBy = by;
  return { ...board, log: sortLog([entry, ...board.log.filter((l) => l.id !== entry.id)]) };
}

/** Sets the board's headline and summary ("where it stands"). */
export function setNow(board, { headline, summary } = {}, { at = nowIso(), by = '' } = {}) {
  const now = { ...board.now };
  if (headline != null) now.headline = str(headline);
  if (summary != null) now.summary = str(summary);
  return { ...board, now: { ...now, updatedAt: bumpTime(board.now?.updatedAt, at), updatedBy: by } };
}

/**
 * Keeps the newest MAX_LOG log entries and tombstones younger than TOMBSTONE_DAYS.
 * Returns { board, older }: the log entries let go (for an archive file).
 */
export function tidyBoard(board, now = nowIso()) {
  const cutoff = new Date(Date.parse(now) - TOMBSTONE_DAYS * 86400000).toISOString();
  const next = { ...board };
  for (const part of BOARD_PARTS) next[part] = next[part].filter((r) => !r.deleted || str(r.updatedAt) > cutoff);
  const log = sortLog(next.log);
  next.log = log.slice(0, MAX_LOG);
  return { board: next, older: log.slice(MAX_LOG).filter((l) => !l.deleted) };
}

// ---- The standalone page's data file ------------------------------------------------------

// The object literal starting at `from` (strings and escapes respected), or null.
function objectAt(text, from) {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/**
 * The data of a board file: JSON, a script (`window.NAME = { … };`), or a whole page holding one.
 * Returns { data, variable } (variable: NAME, or '' for plain JSON); throws when there is none.
 */
export function readBoardData(input) {
  if (isObject(input)) return { data: input, variable: '' };
  const text = str(input);
  const assign = /window\.([A-Za-z_$][\w$]*)\s*=\s*\{/.exec(text);
  const start = assign ? assign.index + assign[0].length - 1 : text.indexOf('{');
  const literal = start >= 0 ? objectAt(text, start) : null;
  if (!literal) throw new Error('That is not a release board file (no board data found in it).');
  let data;
  try {
    data = JSON.parse(literal);
  } catch (err) {
    throw new Error(`The board data in that file cannot be read: ${err.message}`);
  }
  if (!isObject(data) || !BOARD_PARTS.some((p) => Array.isArray(data[p]))) throw new Error('That file has no releases, features or other board parts.');
  return { data, variable: assign?.[1] ?? '' };
}

/**
 * A board from a board data file (readBoardData's), every record stamped `at` / `by`. Ids are kept,
 * or made for the parts that have none. Unknown top-level parts are kept for export.
 */
export function boardFromData(input, { project, at = nowIso(), by = '' } = {}) {
  const { data, variable } = readBoardData(input);
  const board = emptyBoard(project);
  const stamp = { updatedAt: at, updatedBy: by };
  board.meta = { ...(isObject(data.meta) ? data.meta : {}), ...(variable ? { export_variable: variable } : {}), ...stamp };
  board.now = { ...(isObject(data.now) ? data.now : {}), ...stamp };
  for (const part of BOARD_PARTS) {
    const seen = new Set();
    for (const raw of Array.isArray(data[part]) ? data[part] : []) {
      if (!isObject(raw)) continue;
      let id = idFor(part, raw);
      if (!id) continue;
      for (let n = 2; seen.has(id); n++) id = `${idFor(part, raw)}-${n}`;
      seen.add(id);
      const record = { ...raw, ...(part === 'log' ? { time: sortKey(raw.time) } : {}), id, ...stamp };
      board[part].push(record);
    }
  }
  board.log = sortLog(board.log);
  const other = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'meta' && k !== 'now' && !BOARD_PARTS.includes(k)));
  if (Object.keys(other).length) board.other = other;
  return board;
}

const unstamped = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !STAMPS.includes(k)));

/** The board in the standalone page's data layout (no stamps, tombstones or made-up ids). */
export function boardData(board) {
  const meta = unstamped(board.meta);
  delete meta.export_variable;
  const out = { meta, now: unstamped(board.now) };
  for (const part of ['actions', 'releases', 'features', 'tests', 'decisions', 'events', 'sessions', 'repos', 'log', 'briefs']) {
    out[part] = liveRecords(board, part).map((r) => {
      const plain = unstamped(r);
      if (DERIVED_IDS.has(part)) delete plain.id;
      if (part === 'log') delete plain.by;
      return plain;
    });
  }
  return { ...out, ...(board.other ?? {}) };
}

/** The board as the standalone page's data script: window.NAME = { … }; */
export function boardScript(board, variable = board.meta?.export_variable || 'BOARD_DATA') {
  if (!/^[A-Za-z_$][\w$]*$/.test(variable)) throw new Error(`“${variable}” cannot be a script variable.`);
  return `window.${variable} = ${JSON.stringify(boardData(board), null, 1)};\n`;
}

// ---- What the board says ---------------------------------------------------------------------

/** A date or time of the board ("2026-11-02", "2026-11-02 16:00", ISO) in UTC; a date alone is noon. */
export function boardDate(value, { start = false, end = false } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(str(value));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : end ? 24 : start ? 0 : 12, m[5] ? +m[5] : 0));
}

/** How far a release is: its steps done, or 100 when it has none and is out. */
export function releaseProgress(release) {
  const steps = Array.isArray(release?.steps) ? release.steps : [];
  if (!steps.length) return { done: 0, total: 0, percent: LIVE.has(release?.status) ? 100 : 0 };
  const done = steps.filter((s) => s?.done).length;
  return { done, total: steps.length, percent: Math.round((done * 100) / steps.length) };
}

/** The milestones still to come (events and releases' milestones), soonest first. */
export function upcoming(board, now = new Date()) {
  const out = [];
  for (const e of liveRecords(board, 'events')) if (e.status !== 'done') out.push({ date: boardDate(e.date), title: str(e.title), kind: 'event', id: e.id, release: e.release });
  for (const r of liveRecords(board, 'releases')) {
    for (const m of Array.isArray(r.milestones) ? r.milestones : []) {
      if (m?.state !== 'done') out.push({ date: boardDate(m.date), title: `${r.id}: ${str(m.label)}`, kind: 'release', id: r.id, release: r.id });
    }
  }
  return out.filter((x) => x.date && x.date > now).sort((a, b) => a.date - b.date);
}

/** Counts for the board's tiles and its releases' cards. */
export function boardSummary(board, now = new Date()) {
  const releases = liveRecords(board, 'releases');
  const features = liveRecords(board, 'features');
  const tests = liveRecords(board, 'tests');
  const decisions = liveRecords(board, 'decisions');
  const byId = (list) => new Map(list.map((r) => [r.id, r]));
  const featureOf = byId(features);
  const testOf = byId(tests);
  return {
    releases: { out: releases.filter((r) => RELEASE_OUT.has(r.status)).length, total: releases.length },
    features: { live: features.filter((f) => LIVE.has(f.status)).length, total: features.length },
    tests: { passed: tests.filter((t) => TEST_PASSED.has(t.status)).length, total: tests.length },
    actions: liveRecords(board, 'actions').length,
    openDecisions: decisions.filter((d) => d.status === 'open').length,
    next: upcoming(board, now).slice(0, 2),
    cards: releases.map((r) => {
      const f = (Array.isArray(r.features) ? r.features : []).map((id) => featureOf.get(id)).filter(Boolean);
      const t = (Array.isArray(r.tests) ? r.tests : []).map((id) => testOf.get(id)).filter(Boolean);
      return {
        id: r.id,
        progress: releaseProgress(r),
        features: { live: f.filter((x) => LIVE.has(x.status)).length, total: f.length },
        tests: { passed: t.filter((x) => TEST_PASSED.has(x.status)).length, total: t.length },
        merges: Array.isArray(r.merges) ? r.merges.length : 0,
      };
    }),
  };
}

/** Records changed after `since` (an ISO time), newest first: [{ part, id, record }]. */
export function changedSince(board, since) {
  const out = [];
  for (const part of BOARD_PARTS) for (const r of board[part] ?? []) if (str(r.updatedAt) > since) out.push({ part, id: r.id, record: r });
  return out.sort((a, b) => (str(b.record.updatedAt) > str(a.record.updatedAt) ? 1 : -1));
}

/** When the board last changed and who changed it: { at, by } of its newest stamp. */
export function boardUpdated(board) {
  let last = { at: str(board?.now?.updatedAt), by: str(board?.now?.updatedBy) };
  const consider = (o) => {
    if (str(o?.updatedAt) > last.at) last = { at: str(o.updatedAt), by: str(o.updatedBy) };
  };
  consider(board?.meta);
  for (const part of BOARD_PARTS) for (const r of board?.[part] ?? []) consider(r);
  return last;
}

/** The title a record goes by (releases: "R4 · …", features: name, …). */
export function recordTitle(part, r) {
  if (!r) return '';
  if (part === 'releases') return [r.id, r.title].filter(Boolean).join(' · ');
  return str(r.title || r.name || r.text || r.label || r.repo || r.code || r.id);
}
