// Release boards (pure; the connector uses it too): one file per project, boards/<slug>.json, with
// what a release board shows (releases, features, tests, decisions, events, sessions, repos, the
// actions waiting on the person, briefs and a log). Records merge one by one: the one changed last
// wins, deletions are tombstones, so Claude's sessions and the devices never lose each other's
// changes. A board file of the standalone page (`window.NAME = { … }`) imports and exports as it is.
import { bumpTime, CLAUDE_AUTHOR, findWords, foldSearch, newId, nowIso, slugify } from './model.js';

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
      const mine = byId.get(r.id);
      if (!mine) order.push(r.id);
      byId.set(r.id, mine ? withBothComments(newer(mine, r) ? r : mine, mine, r) : r);
    }
    merged[part] = order.map((id) => byId.get(id));
  }
  merged.log = sortLog(merged.log);
  return merged;
}

// A record's comments from both copies (each at its latest), so a comment is never lost to a change
// made meanwhile elsewhere; the rest of the record is the newer copy's.
function withBothComments(winner, a, b) {
  if (winner.deleted || (!Array.isArray(a.comments) && !Array.isArray(b.comments))) return winner;
  const comments = unionComments([...(a.comments ?? []), ...(b.comments ?? [])]);
  return JSON.stringify(comments) === JSON.stringify(winner.comments ?? []) ? winner : { ...winner, comments };
}

const commentTime = (c) => str(c?.editedAt || c?.at);
function unionComments(list) {
  const byId = new Map();
  for (const c of list) {
    if (!isObject(c) || !str(c.id)) continue;
    const prev = byId.get(c.id);
    if (!prev || commentTime(c) > commentTime(prev) || (commentTime(c) === commentTime(prev) && c.deleted && !prev.deleted)) byId.set(c.id, c);
  }
  return [...byId.values()].sort((x, y) => (str(x.at) < str(y.at) ? -1 : str(x.at) > str(y.at) ? 1 : 0));
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
        if (path === 'id' || STAMPS.includes(path) || path.split('.')[0] === 'comments') continue;
        record = setPath(record, path, value);
      }
      if (c.comment != null || c.uncomment != null) {
        if (!before || before.deleted) throw new Error(`There is no ${part} ${id} to comment on.`);
        record.comments = commentChange(record, c, { at, by });
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

const MAX_COMMENT_CHARS = 20_000;

// A record's comments after a change's `comment` (text, on its `command` for a release's command)
// or `uncomment` (a comment's id: left as a tombstone, so a merge does not bring it back).
function commentChange(record, c, { at, by }) {
  const comments = Array.isArray(record.comments) ? record.comments : [];
  const latest = comments.reduce((l, x) => (commentTime(x) > l ? commentTime(x) : l), '');
  const when = latest ? bumpTime(latest, at) : at;
  if (c.uncomment != null) {
    return comments.map((x) => (x.id === str(c.uncomment) && !x.deleted ? { id: x.id, by: x.by, at: x.at, editedAt: when, deleted: true, ...(x.command ? { command: x.command } : {}) } : x));
  }
  const words = str(c.comment).trim();
  if (!words) throw new Error('A comment needs some text.');
  const command = cleanId(c.command);
  if (command && !(Array.isArray(record.commands) && record.commands.some((x) => x?.id === command))) throw new Error(`There is no command “${command}” on ${record.id} to comment on.`);
  return [...comments, { id: newId(), by, at: when, text: words.slice(0, MAX_COMMENT_CHARS), ...(command ? { command } : {}) }];
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
    out[part] = liveRecords(board, part)
      .filter((r) => !(part === 'actions' && r.done))
      .map((r) => {
        const plain = unstamped(r);
        delete plain.comments;
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
    actions: waitingActions(board).length,
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

// ---- The board's views (the app's Release board) ------------------------------------------------

const DAY_MS = 86_400_000;
// The timeline shows at most this many days (around now when the board's dates spread wider).
export const MAX_TIMELINE_DAYS = 180;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n) => String(n).padStart(2, '0');
const arr = (v) => (Array.isArray(v) ? v : []);
const utcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
/** The day a feature shipped, else the day it is expected ('' when neither). */
export const featureDate = (f) => str(f?.shipped || f?.expected);

/**
 * The days the timeline shows, { start, end, days } (whole UTC days): meta.timeline_start and
 * timeline_end when the board names them, else its dates (phases, milestones, events, features) with
 * a few days around them and never less than ten days back and two weeks ahead of now.
 */
export function timelineRange(board, now = new Date()) {
  const meta = board?.meta ?? {};
  let start = boardDate(meta.timeline_start);
  let end = boardDate(meta.timeline_end);
  if (!start || !end || end < start) {
    const times = [];
    const add = (d) => d && times.push(d.getTime());
    for (const r of liveRecords(board, 'releases')) {
      for (const p of arr(r.phases)) add(boardDate(p?.from)), add(boardDate(p?.to));
      for (const m of arr(r.milestones)) add(boardDate(m?.date));
    }
    for (const e of liveRecords(board, 'events')) add(boardDate(e.date));
    for (const f of liveRecords(board, 'features')) add(boardDate(featureDate(f)));
    start = new Date(Math.min(now - 10 * DAY_MS, ...times.map((t) => t - 2 * DAY_MS)));
    end = new Date(Math.max(now.getTime() + 14 * DAY_MS, ...times.map((t) => t + 3 * DAY_MS)));
  }
  start = utcDay(start);
  end = new Date(utcDay(end).getTime() + DAY_MS);
  if ((end - start) / DAY_MS > MAX_TIMELINE_DAYS) {
    start = new Date(Math.max(start, utcDay(now).getTime() - 60 * DAY_MS));
    end = new Date(Math.min(end, start.getTime() + MAX_TIMELINE_DAYS * DAY_MS));
  }
  return { start, end, days: Math.round((end - start) / DAY_MS) };
}

// Places spans of [left, left + width) in the first lane they fit in (the page's packing).
function lanes() {
  const ends = [];
  return {
    place(left, width) {
      let i = 0;
      while (ends[i] != null && ends[i] > left - 6) i++;
      ends[i] = left + width;
      return i;
    },
    get count() {
      return ends.length;
    },
  };
}

/**
 * The timeline drawn in pixels, `dayW` per day: the days (left, label, weekday, weekend, today),
 * where now is (null when outside), and its rows: each release's phases and milestones, with
 * `features` its dated features as chips (headline ones; the rest as "+N more"), and the events.
 */
export function timelineLayout(board, { now = new Date(), dayW = 64, features = true } = {}) {
  const range = timelineRange(board, now);
  const x = (d) => ((d - range.start) / DAY_MS) * dayW;
  const width = range.days * dayW;
  const today = utcDay(now).getTime();
  const days = Array.from({ length: range.days }, (_, i) => {
    const d = new Date(range.start.getTime() + i * DAY_MS);
    return { left: i * dayW, label: `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`, weekday: WEEKDAYS[d.getUTCDay()], weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6, today: d.getTime() === today };
  });
  const featureOf = new Map(liveRecords(board, 'features').map((f) => [f.id, f]));
  const rows = [];
  for (const r of liveRecords(board, 'releases')) {
    const segs = [];
    for (const p of arr(r.phases)) {
      const a = boardDate(p?.from, { start: true });
      const b = boardDate(p?.to, { end: true });
      if (!a || !b) continue;
      const left = x(a);
      segs.push({ left, width: Math.max(x(b) - left, 10), label: str(p.label), state: str(p.state), from: str(p.from), to: str(p.to) });
    }
    const milestones = [];
    for (const m of arr(r.milestones)) {
      const d = boardDate(m?.date);
      if (d) milestones.push({ left: x(d), label: str(m.label), short: str(m.short), done: m.state === 'done', date: str(m.date) });
    }
    rows.push({ kind: 'release', release: r, height: 66, segs, milestones });
    if (!features) continue;
    const dated = arr(r.features).map((id) => featureOf.get(id)).filter((f) => f && boardDate(featureDate(f)));
    const shown = dated.filter((f) => f.headline !== false).sort((a, b) => boardDate(featureDate(a)) - boardDate(featureDate(b)));
    if (!shown.length) continue;
    const packed = lanes();
    const chips = shown.map((f) => {
      const left = x(boardDate(featureDate(f))) - 6;
      return { left, top: 8 + packed.place(left, 30 + str(f.name).length * 6.4) * 28, feature: f, missing: !LIVE.has(f.status) };
    });
    if (dated.length > shown.length) {
      const label = `+${dated.length - shown.length} more`;
      const left = x(boardDate(featureDate(shown.at(-1)))) - 6;
      chips.push({ left, top: 8 + packed.place(left, 30 + label.length * 6.4) * 28, more: dated.length - shown.length, label });
    }
    rows.push({ kind: 'features', release: r, height: 16 + packed.count * 28, chips, count: dated.length });
  }
  const events = liveRecords(board, 'events')
    .map((e) => ({ e, d: boardDate(e.date) }))
    .filter(({ d }) => d)
    .sort((a, b) => a.d - b.d);
  if (events.length) {
    const packed = lanes();
    const marks = events.map(({ e, d }) => ({ left: x(d), top: 14 + packed.place(x(d), 24 + str(e.title).length * 6.2) * 26, event: e, done: e.status === 'done' }));
    rows.push({ kind: 'events', height: 18 + packed.count * 26, marks });
  }
  const nowX = x(now);
  return { range, width, dayW, days, now: nowX >= 0 && nowX <= width ? nowX : null, rows };
}

/** The views a board has something for, in order (Overview always). */
export function boardTabs(board) {
  const releases = liveRecords(board, 'releases');
  const has = (part) => liveRecords(board, part).length > 0;
  return [
    'overview',
    (releases.some((r) => arr(r.phases).length || arr(r.milestones).length) || has('events')) && 'timeline',
    (releases.length || has('repos') || has('sessions') || has('briefs')) && 'releases',
    has('features') && 'features',
    has('tests') && 'tests',
    has('decisions') && 'decisions',
    releases.some((r) => arr(r.commands).length) && 'commands',
    board?.log?.some((l) => !l.deleted) && 'log',
  ].filter(Boolean);
}

// Records of `part` grouped by their release, in the releases' order, then releases the board does
// not have (by id), then those without one: [{ id, release (record or null), records }].
function byRelease(board, records) {
  const order = liveRecords(board, 'releases');
  const groups = new Map(order.map((r) => [r.id, []]));
  const none = [];
  for (const rec of records) {
    const id = str(rec.release);
    if (!id) none.push(rec);
    else groups.set(id, [...(groups.get(id) ?? []), rec]);
  }
  const relOf = new Map(order.map((r) => [r.id, r]));
  const out = [...groups].filter(([, list]) => list.length).map(([id, list]) => ({ id, release: relOf.get(id) ?? null, records: list }));
  if (none.length) out.push({ id: '', release: null, records: none });
  return out;
}

const matcher = (query) => {
  const words = findWords(query);
  return (...fields) => {
    if (!words.length) return true;
    const hay = foldSearch(fields.flat().map(str).join('\u0001'));
    return words.every((w) => hay.includes(w));
  };
};

/**
 * The Features view: the features that pass the filters (`release` an id, 'none' for those in no
 * release; `repo`; `query` words; `missing` not live yet; `statuses` any of them), grouped by
 * release, with what the filters offer (statuses as they come, repos sorted) and the counts.
 */
export function featureView(board, { release = '', repo = '', query = '', missing = false, statuses = [] } = {}) {
  const all = liveRecords(board, 'features');
  const matches = matcher(query);
  const wanted = new Set(statuses);
  const shown = all.filter(
    (f) =>
      (!release || (release === 'none' ? !f.release : f.release === release)) &&
      (!repo || arr(f.repos).includes(repo)) &&
      (!missing || !LIVE.has(f.status)) &&
      (!wanted.size || wanted.has(f.status)) &&
      matches(f.name, f.what, f.detail, f.session, f.branch, arr(f.repos)),
  );
  return {
    total: all.length,
    missing: all.filter((f) => !LIVE.has(f.status)).length,
    shown: shown.length,
    statuses: [...new Set(all.map((f) => str(f.status)).filter(Boolean))],
    repos: [...new Set(all.flatMap((f) => arr(f.repos).map(str)).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    groups: byRelease(board, shown),
  };
}

/** The Tests view: tests by release, each group with how many passed. */
export const testGroups = (board) => byRelease(board, liveRecords(board, 'tests')).map((g) => ({ ...g, passed: g.records.filter((t) => TEST_PASSED.has(t.status)).length }));

/** The Commands view: each release's commands, those to do first. */
export const commandGroups = (board) =>
  liveRecords(board, 'releases')
    .filter((r) => arr(r.commands).length)
    .map((r) => ({ release: r, pending: r.commands.filter((c) => c?.status !== 'done'), done: r.commands.filter((c) => c?.status === 'done') }));

// What the board's search looks through, part by part (commands come from their releases).
const SEARCH_GROUPS = [
  ['releases', 'Releases'],
  ['features', 'Features'],
  ['tests', 'Tests'],
  ['decisions', 'Decisions'],
  ['actions', 'Waiting on you'],
  ['events', 'Events'],
  ['commands', 'Commands'],
  ['sessions', 'Sessions'],
  ['briefs', 'Workstreams'],
  ['repos', 'Repos'],
  ['log', 'Log'],
];
const NOT_SEARCHED = new Set([...STAMPS, 'order', 'color', 'deleted', 'headline']);
// A release's own text: not its commands (searched apart) or the ids of its features, tests, decisions.
const RELEASE_NOT_SEARCHED = new Set([...NOT_SEARCHED, 'commands', 'features', 'tests', 'decisions']);

function textOf(value, skip, out = []) {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) textOf(v, NOT_SEARCHED, out);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) if (!skip.has(k)) textOf(v, NOT_SEARCHED, out);
  return out;
}

/**
 * The board's search: every word (a "quoted phrase" as one) in a record's text, accents and case
 * aside. { words, total, groups: [{ part, label, total, hits: [{ part, id, record, release? }] }] },
 * at most `limit` hits a group (`total` counts them all).
 */
export function searchBoard(board, query, { limit = 50 } = {}) {
  const words = findWords(query);
  if (!words.length) return { words, total: 0, groups: [] };
  const hit = (record, skip = NOT_SEARCHED) => {
    const hay = foldSearch(textOf(record, skip).join('\u0001'));
    return words.every((w) => hay.includes(w));
  };
  const groups = [];
  for (const [part, label] of SEARCH_GROUPS) {
    let hits;
    if (part === 'commands') {
      hits = liveRecords(board, 'releases').flatMap((r) => arr(r.commands).filter((c) => isObject(c) && hit(c)).map((c) => ({ part, id: str(c.id), record: c, release: r.id })));
    } else {
      const skip = part === 'releases' ? RELEASE_NOT_SEARCHED : NOT_SEARCHED;
      hits = (part === 'log' ? board.log.filter((l) => !l.deleted) : liveRecords(board, part)).filter((r) => hit(r, skip)).map((r) => ({ part, id: r.id, record: r }));
    }
    if (hits.length) groups.push({ part, label, total: hits.length, hits: hits.slice(0, limit) });
  }
  return { words, total: groups.reduce((n, g) => n + g.total, 0), groups };
}

// ---- The board in the rest of the tracker: ticks, decisions, comments, links, events --------------

/** What waits on the person: the actions not ticked done, in the board's order. */
export const waitingActions = (board) => liveRecords(board, 'actions').filter((a) => !a.done);

// Claude's writes: the connector's device ("Claude", "Claude Code"), with its session after " · ".
const fromClaude = (by) => new RegExp(`^${CLAUDE_AUTHOR}\\b`).test(str(by));
const stepLabel = (s) => (typeof s === 'string' ? s : str(s?.label));
const findStep = (steps, index, label) => (stepLabel(steps[index]) === str(label) || label == null ? index : steps.findIndex((s) => stepLabel(s) === str(label)));
const findCommand = (commands, command) => commands.findIndex((c) => str(c?.id) === str(command) || (!c?.id && str(c?.label) === str(command)));

/**
 * Ticks something on the board done or not, as the person does in the app, with a log line:
 * `{ kind: 'step', part ('releases' | 'events'), id, index, label }` (found by its label when the
 * steps moved), `{ kind: 'command', release, command }` (its id, or its label when it has none) or
 * `{ kind: 'action', id }`. Read again before each write, so it applies to the board as it is then.
 */
export function boardTick(board, target, done, { at = nowIso(), by = '' } = {}) {
  const day = boardTime(at);
  if (target?.kind === 'action') {
    const a = liveRecords(board, 'actions').find((x) => x.id === target.id);
    if (!a) throw new Error('That step is no longer on the board.');
    const { board: next } = applyBoardChanges(board, [{ part: 'actions', id: a.id, set: done ? { done: true, done_at: day, done_by: by } : { done: null, done_at: null, done_by: null } }], { at, by });
    return addLog(next, { text: `${done ? 'Done' : 'Not done after all'}: ${str(a.text)}`, release: a.release, item: a.item }, { at, by });
  }
  if (target?.kind === 'step') {
    const part = target.part === 'events' ? 'events' : 'releases';
    const r = liveRecords(board, part).find((x) => x.id === target.id);
    const steps = Array.isArray(r?.steps) ? r.steps : [];
    const index = findStep(steps, Number(target.index), target.label);
    if (!r || index < 0 || index >= steps.length) throw new Error('That step is no longer on the board.');
    const old = steps[index];
    const step = { ...(typeof old === 'string' ? { label: old } : old), done: Boolean(done) };
    if (done) Object.assign(step, { date: day.slice(0, 10), by });
    else {
      delete step.date;
      delete step.by;
    }
    const { board: next } = applyBoardChanges(board, [{ part, id: r.id, set: { [`steps.${index}`]: step } }], { at, by });
    return addLog(next, { text: `${r.id}: ${done ? 'done' : 'not done after all'}: ${stepLabel(old)}`, release: part === 'releases' ? r.id : r.release }, { at, by });
  }
  if (target?.kind === 'command') {
    const r = liveRecords(board, 'releases').find((x) => x.id === target.release);
    const commands = Array.isArray(r?.commands) ? r.commands : [];
    const index = findCommand(commands, target.command);
    if (!r || index < 0) throw new Error('That command is no longer on the board.');
    const set = done ? { [`commands.${index}.status`]: 'done', [`commands.${index}.done_at`]: day, [`commands.${index}.done_by`]: by } : { [`commands.${index}.status`]: 'pending', [`commands.${index}.done_at`]: null, [`commands.${index}.done_by`]: null };
    const { board: next } = applyBoardChanges(board, [{ part: 'releases', id: r.id, set }], { at, by });
    return addLog(next, { text: `${r.id}: ${done ? 'ran' : 'not run after all'}: ${str(commands[index].label)}`, release: r.id }, { at, by });
  }
  throw new Error('Nothing to tick.');
}

/**
 * Decides an open decision (`choice`: one of its `options`, or the person's words) or opens it again
 * (`choice` null). Its question stays in `question`; `choice` becomes what was decided.
 */
export function decideBoard(board, id, choice, { at = nowIso(), by = '' } = {}) {
  const d = liveRecords(board, 'decisions').find((x) => x.id === id);
  if (!d) throw new Error('That decision is no longer on the board.');
  const label = d.code || d.title || d.id;
  let set;
  if (choice == null) {
    set = { status: 'open', decided: null, decided_at: null, decided_by: null, ...(d.question != null ? { choice: d.question, question: null } : {}) };
  } else {
    const words = str(choice).trim();
    if (!words) throw new Error('Say what you decided.');
    set = { status: 'decided', decided: words, decided_at: boardTime(at), decided_by: by, choice: words, ...(d.question == null && d.status === 'open' ? { question: str(d.choice) } : {}) };
  }
  const { board: next } = applyBoardChanges(board, [{ part: 'decisions', id, set }], { at, by });
  return addLog(next, { text: choice == null ? `${label}: open again` : `Decided ${label}: ${str(choice).trim()}`, release: d.release, item: d.item }, { at, by });
}

/** A record's comments that show, oldest first (a release's own, or those on its `command`). */
export const recordComments = (record, command = '') => (Array.isArray(record?.comments) ? record.comments : []).filter((c) => !c.deleted && str(c.command) === str(command));

/** Records whose latest comment is the person's (Claude has not answered): [{ part, id, title, command?, comment }]. */
export function commentsAwaiting(board) {
  const out = [];
  for (const part of BOARD_PARTS) {
    if (part === 'log') continue;
    for (const r of liveRecords(board, part)) {
      const live = (Array.isArray(r.comments) ? r.comments : []).filter((c) => !c.deleted);
      for (const command of new Set(live.map((c) => str(c.command)))) {
        const last = live.filter((c) => str(c.command) === command).at(-1);
        if (last && !fromClaude(last.by)) out.push({ part, id: r.id, title: recordTitle(part, r), ...(command ? { command } : {}), comment: last });
      }
    }
  }
  return out.sort((a, b) => (str(a.comment.at) < str(b.comment.at) ? -1 : str(a.comment.at) > str(b.comment.at) ? 1 : 0));
}

/** What on the board points to a tracker item (in a field or its text): records, then log entries. */
export function boardLinksTo(board, itemId) {
  const id = str(itemId);
  if (!id) return { records: [], log: [] };
  const records = [];
  for (const part of ['releases', 'features', 'tests', 'decisions', 'events', 'actions', 'briefs', 'sessions']) {
    for (const r of liveRecords(board, part)) {
      if (part === 'actions' && r.done) continue;
      if (JSON.stringify({ ...r, comments: undefined }).includes(id)) records.push({ part, id: r.id, title: recordTitle(part, r), status: part === 'actions' ? 'waiting' : str(r.status), release: part === 'releases' ? r.id : str(r.release) });
    }
  }
  const log = board.log.filter((l) => !l.deleted && JSON.stringify(l).includes(id));
  return { records, log };
}

/**
 * Notification-ready events between two copies of a board (changes.js's shape, category 'boards'):
 * a test failed, a release changed status, a decision or a step waits for the person, a comment.
 * Changes made by `self` (this device) say nothing; `href` opens the board.
 */
export function boardEvents(before, after, { self = '' } = {}) {
  if (!before || !after) return [];
  const href = `#/release-board/${boardSlug(after.project)}`;
  const project = str(after.project);
  const events = [];
  const add = (by, title, body, open) => {
    if (self && by === self) return;
    events.push({ category: 'boards', title, body: body ? `${body} · ${project}` : project, by: by || 'Another device', fromClaude: fromClaude(by), href: open ? `${href}/${open.type}/${encodeURIComponent(open.id)}` : href });
  };
  const was = (part) => new Map(liveRecords(before, part).map((r) => [r.id, r]));
  const tests = was('tests');
  for (const t of liveRecords(after, 'tests')) if (t.status === 'failed' && tests.get(t.id)?.status !== 'failed') add(t.updatedBy, 'A test failed', str(t.title), { type: 'test', id: t.id });
  const releases = was('releases');
  for (const r of liveRecords(after, 'releases')) {
    const old = releases.get(r.id);
    if (old && old.status !== r.status) add(r.updatedBy, `${r.id} is ${str(r.short_status || statusLabel(r.status)).toLowerCase()}`, str(r.title), { type: 'release', id: r.id });
  }
  const decisions = was('decisions');
  for (const d of liveRecords(after, 'decisions')) if (d.status === 'open' && decisions.get(d.id)?.status !== 'open') add(d.updatedBy, 'A decision to make', str(d.title), { type: 'decision', id: d.id });
  const actions = was('actions');
  for (const a of waitingActions(after)) {
    const old = actions.get(a.id);
    if (!old || old.deleted || old.done) add(a.updatedBy, 'Waiting on you', str(a.text));
  }
  for (const part of BOARD_PARTS) {
    if (part === 'log') continue;
    const prev = was(part);
    for (const r of liveRecords(after, part)) {
      const seen = new Set((prev.get(r.id)?.comments ?? []).map((c) => c.id));
      const added = (Array.isArray(r.comments) ? r.comments : []).filter((c) => !c.deleted && !seen.has(c.id));
      const last = added.at(-1);
      const open = { releases: 'release', features: 'feature', tests: 'test', decisions: 'decision', events: 'event' }[part];
      if (last) add(last.by, `${fromClaude(last.by) ? CLAUDE_AUTHOR : last.by || 'Someone'} commented on ${recordTitle(part, r)}`, str(last.text).replace(/\s+/g, ' ').slice(0, 140), open && { type: open, id: r.id });
    }
  }
  return events;
}

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * When an action is due, from its `at` or its `when` as the page writes it ("2026-11-02 16:00",
 * "Mon 11-02 16:00 UTC", "Sun 16:00 UTC": the next Sunday), in UTC; null when it says no time.
 */
export function actionTime(action, now = new Date()) {
  const exact = boardDate(action?.at) ?? boardDate(action?.when);
  if (exact) return exact;
  const when = str(action?.when).trim().toLowerCase();
  const time = /(\d{1,2}):(\d{2})/.exec(when);
  const [h, m] = time ? [Number(time[1]), Number(time[2])] : [12, 0];
  const md = /\b(\d{1,2})-(\d{1,2})\b/.exec(when.replace(/\d{1,2}:\d{2}/, ''));
  if (md) {
    let d = new Date(Date.UTC(now.getUTCFullYear(), Number(md[1]) - 1, Number(md[2]), h, m));
    if (d - now < -183 * DAY_MS) d = new Date(Date.UTC(now.getUTCFullYear() + 1, Number(md[1]) - 1, Number(md[2]), h, m));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const wd = WEEKDAY_NAMES.findIndex((w) => new RegExp(`\\b${w}`).test(when));
  if (wd < 0 || !time) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  let ahead = (wd - d.getUTCDay() + 7) % 7;
  if (ahead === 0 && d < now) ahead = 7;
  return new Date(d.getTime() + ahead * DAY_MS);
}

/**
 * What waits on the person on every board, those with a time first (soonest), then the rest in each
 * board's order: [{ slug, project, action, time }]. `boards`: [{ slug, board }].
 */
export function waitingEverywhere(boards, now = new Date()) {
  const all = boards.flatMap(({ slug, board }) => waitingActions(board).map((action, order) => ({ slug, project: str(board.project), action, time: actionTime(action, now), order })));
  return all.sort((a, b) => (a.time && b.time ? a.time - b.time : a.time ? -1 : b.time ? 1 : 0));
}

/** How long a board has had no word (ms since its newest change), or null for an empty one. */
export function boardQuietFor(board, now = new Date()) {
  const { at } = boardUpdated(board);
  return at ? now - new Date(at) : null;
}

/** Lines about the boards for the day plan and the week review (next milestones, what waits, open decisions). */
export function boardPlanLines(boards, now = new Date()) {
  const lines = [];
  for (const { board } of boards) {
    const next = upcoming(board, now).slice(0, 2).map((n) => `${n.title} (${n.date.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
    const waiting = waitingActions(board).slice(0, 5).map((a) => `${str(a.text)}${a.when ? ` (${a.when})` : ''}`);
    const open = liveRecords(board, 'decisions').filter((d) => d.status === 'open').map((d) => str(d.title));
    if (!next.length && !waiting.length && !open.length) continue;
    lines.push(`Release board "${str(board.project)}":`);
    if (next.length) lines.push(`- Next milestones: ${next.join('; ')}`);
    if (waiting.length) lines.push(`- Waiting on me: ${waiting.join('; ')}`);
    if (open.length) lines.push(`- Decisions still open: ${open.slice(0, 5).join('; ')}`);
  }
  return lines.join('\n');
}

/** The boards' log entries of a local day (YYYY-MM-DD), newest first: [{ slug, project, entry }]. */
export function boardDayLog(boards, day) {
  const out = [];
  for (const { slug, board } of boards) {
    for (const entry of board.log) {
      const d = boardDate(entry.time);
      if (entry.deleted || !d) continue;
      const local = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
      if (local === day) out.push({ slug, project: str(board.project), entry, at: d });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
