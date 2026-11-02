// The assistant that does things (2.5): the model changes the tracker when asked (items, projects,
// tags, release boards, plans), or says how to do it yourself from the guide. Pure, so the Node tests
// import it; ui/assistantPanel.js asks the model and runs the steps.
//
// As Tracker Editor's Git with the model: the model proposes steps from a fixed list in a
// ```tracker-steps block; looking steps run at once and what they find goes back to it; steps that
// are easy to undo run by themselves; the others wait for Apply (deleting ones with a warning). Every
// change can be undone, field by field, as new edits (so sync carries the undo to the other devices,
// and what changed since stays as it is). The changes are model.js's and boards.js's, as the
// connector's, so the assistant does what Claude does through the connector.
import { describeItem } from './assist.js';
import { codeFences, parseJsonLoose, withoutBlocks, wordsBefore } from './fences.js';
import {
  addLog,
  applyBoardChanges,
  BOARD_PARTS,
  boardSlug,
  boardSummary,
  boardTick,
  decideBoard,
  emptyBoard,
  liveRecords,
  recordTitle,
  setNow,
  STATUSES as BOARD_STATUSES,
  upcoming,
  waitingActions,
  waitingEverywhere,
} from './boards.js';
import {
  addCommentPatch,
  addDays,
  AREAS,
  applyPatch,
  bumpTime,
  cleanProjectName,
  cleanTags,
  createItem,
  DECISIONS,
  deleteCommentPatch,
  deleteProjectIn,
  deleteProjectRecord,
  foldSearch,
  isOverdue,
  KINDS,
  liveComments,
  matchesQuery,
  normalizeProject,
  pinnedFirst,
  PRIORITIES,
  projectKey,
  projectList,
  renameProjectIn,
  resolveProjectName,
  retagItems,
  reviveItem,
  sortItems,
  STATUSES,
  tagCounts,
  tombstone,
  TYPE_IDS,
  upsertProjectRecord,
} from './model.js';

/** A step that cannot be done, in words the person and the model understand. */
export class StepError extends Error {}

// Changing more items than this at once is asked first.
export const MAX_AUTO_ITEMS = 5;
// At most this many items added by one step.
export const MAX_NEW_ITEMS = 30;
// The model answers, looks and answers again: at most this many times for one question.
export const MAX_ROUNDS = 8;
// What a look gives back at most.
const LOOK_CHARS = 20_000;
const ITEM_CHARS = 8000;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n[… cut: ${s.length - max} more characters]` : s);
const short = (s, max = 60) => (str(s).length > max ? `${str(s).slice(0, max - 1)}…` : str(s));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isId = (v) => typeof v === 'string' && v.trim().length > 0 && v.length < 200;
const isText = (v, max = 20_000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v, max = 20_000) => v == null || (typeof v === 'string' && v.length <= max);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOfWeek = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};
export const realDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(d))) return false;
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(y, m - 1, day);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === day;
};

// ---- Finding items -------------------------------------------------------------------------

export const DUE_FILTERS = ['overdue', 'today', 'tomorrow', 'this-week', 'next-week', 'none', 'any'];

/** Whether an item's due date fits `due` ('overdue', 'this-week', 'none', '2026-11-01..2026-11-30'…). */
export function dueFits(item, due, today) {
  if (!due) return true;
  const end = addDays(today, (7 - dayOfWeek(today)) % 7); // this coming Sunday (today when it is Sunday)
  switch (due) {
    case 'overdue':
      return isOverdue(item, today);
    case 'today':
      return item.due === today;
    case 'tomorrow':
      return item.due === addDays(today, 1);
    case 'this-week':
      return Boolean(item.due) && item.due >= today && item.due <= end;
    case 'next-week':
      return Boolean(item.due) && item.due > end && item.due <= addDays(end, 7);
    case 'none':
      return !item.due;
    case 'any':
      return Boolean(item.due);
    default: {
      const [from, to] = due.split('..');
      return Boolean(item.due) && (!from || item.due >= from) && (!to || item.due <= to);
    }
  }
}

const dueOk = (due) => due == null || DUE_FILTERS.includes(due) || /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/.test(str(due));

/** The live items a `find` step asks for, in the order it asks (most pressing first by default). */
export function findItems(items, f = {}, { today }) {
  const status = f.status ?? 'open';
  const project = f.project == null ? null : str(f.project).trim();
  const tag = str(f.tag).replace(/^#/, '').toLowerCase();
  const list = items.filter(
    (i) =>
      !i.deleted &&
      (!f.type || f.type === 'all' || i.type === f.type) &&
      (status === 'all' || (status === 'open' ? i.status !== 'done' : i.status === status)) &&
      (project == null || (['', 'none'].includes(project.toLowerCase()) ? !i.project : projectKey(i.project) === projectKey(project))) &&
      (!tag || i.tags.some((t) => t.toLowerCase() === tag)) &&
      (!f.priority || i.priority === f.priority) &&
      (typeof f.pinned !== 'boolean' || Boolean(i.pinned) === f.pinned) &&
      dueFits(i, f.due, today) &&
      matchesQuery(i, str(f.query)),
  );
  if (['due', 'updated', 'created', 'title', 'priority'].includes(f.sort)) return sortItems(list, f.sort);
  return pinnedFirst(sortItems(list));
}

/** An item in one line, as the model reads it: its id, title and what matters. */
export function itemLine(i, today) {
  const bits = [i.type === 'claude' ? 'Claude work' : i.type, i.status.replace('_', ' ')];
  if (i.priority !== 'normal') bits.push(i.priority);
  if (i.due) bits.push(`due ${i.due}${isOverdue(i, today) ? ' (overdue)' : ''}`);
  if (i.project) bits.push(i.project);
  if (i.tags.length) bits.push(i.tags.map((t) => `#${t}`).join(' '));
  if (i.pinned) bits.push('pinned');
  if (i.type === 'doc' && i.decision) bits.push(`review: ${i.decision}`);
  const comments = liveComments(i).length;
  if (comments) bits.push(plural(comments, 'comment'));
  return `- ${i.id} “${i.title}” [${bits.join(', ')}]`;
}

const itemLines = (list, today, limit, what) => {
  if (!list.length) return `No ${what}.`;
  const shown = list.slice(0, limit);
  return `${list.length > shown.length ? `${list.length} ${what}, the first ${shown.length}:` : `${plural(list.length, what.replace(/s$/, ''), what)}:`}\n${shown.map((i) => itemLine(i, today)).join('\n')}`;
};

/** An item whole, as the model reads it (`item` step): its fields, notes, review, comments and files. */
export function itemText(item) {
  const head = [`Id: ${item.id}`, `Created ${item.createdAt.slice(0, 10)}, changed ${item.updatedAt.slice(0, 10)}${item.updatedBy ? ` (by ${item.updatedBy})` : ''}`];
  if (item.completedAt) head.push(`Done on ${item.completedAt.slice(0, 10)}`);
  if (item.pinned) head.push('Pinned');
  const files = item.files.length ? `\n\nFiles: ${item.files.map((f) => f.name).join(', ')}` : '';
  return clip(`${head.join('\n')}\n${describeItem(item)}${files}`, ITEM_CHARS);
}

// ---- Release boards as the model reads them ------------------------------------------------

const stepLabel = (s) => (typeof s === 'string' ? s : str(s?.label));

/** A board in a few lines (`board` step): where it stands, its releases with their steps, what waits, open decisions. */
export function boardText(board, now = new Date()) {
  const s = boardSummary(board, now);
  const cards = new Map(s.cards.map((c) => [c.id, c]));
  const lines = [`Release board of ${board.project}${board.now?.headline ? `: ${board.now.headline}` : ''}`];
  if (board.now?.summary) lines.push(board.now.summary);
  lines.push(`Releases ${s.releases.out} of ${s.releases.total} out; features ${s.features.live} of ${s.features.total} live; tests ${s.tests.passed} of ${s.tests.total} passed; ${s.actions} waiting on the person; ${s.openDecisions} decisions open.`);
  const releases = liveRecords(board, 'releases');
  if (releases.length) {
    lines.push('Releases (steps by index):');
    for (const r of releases) {
      const c = cards.get(r.id);
      const steps = Array.isArray(r.steps) ? r.steps : [];
      lines.push(
        `- ${r.id} “${str(r.title)}” [${str(r.status)}]${r.ship_label ? ` ${r.ship_label}` : ''}${c?.features.total ? ` · features ${c.features.live}/${c.features.total} live` : ''}${c?.tests.total ? ` · tests ${c.tests.passed}/${c.tests.total} passed` : ''}${steps.length ? ` · steps: ${steps.map((x, n) => `${n} ${x?.done ? '✓' : '○'} ${stepLabel(x)}`).join('; ')}` : ''}`,
      );
    }
  }
  const waiting = waitingActions(board);
  if (waiting.length) lines.push('Waiting on the person (actions):', ...waiting.map((a) => `- ${a.id}: ${str(a.text)}${a.when ? ` (${a.when})` : ''}${a.release ? ` [${a.release}]` : ''}`));
  const open = liveRecords(board, 'decisions').filter((d) => d.status === 'open');
  if (open.length) lines.push('Open decisions:', ...open.map((d) => `- ${d.id}${d.code ? ` (${d.code})` : ''}: ${str(d.title)}${Array.isArray(d.options) && d.options.length ? ` — options: ${d.options.map(str).join(' | ')}` : ''}`));
  const next = upcoming(board, now).slice(0, 3);
  if (next.length) lines.push(`Next: ${next.map((n) => `${n.title} (${n.date.toISOString().slice(0, 16).replace('T', ' ')} UTC)`).join('; ')}`);
  const log = board.log.filter((l) => !l.deleted).slice(0, 6);
  if (log.length) lines.push('Latest log:', ...log.map((l) => `- ${l.time}: ${short(l.text, 200)}`));
  lines.push(`Records: ${BOARD_PARTS.map((p) => `${p} ${liveRecords(board, p).length}`).join(', ')} (board-records shows them whole).`);
  return clip(lines.join('\n'), LOOK_CHARS);
}

/** Whole records of one part of a board (`board-records` step), as JSON, without their stamps. */
export function boardRecordsText(board, { part, ids, release, query } = {}) {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(str)) : null;
  const words = foldSearch(query);
  const records = liveRecords(board, part).filter(
    (r) =>
      (!wanted || wanted.has(r.id)) &&
      (!release || r.release === release || (part === 'releases' && r.id === release)) &&
      (!words || foldSearch(JSON.stringify(r)).includes(words)),
  );
  if (!records.length) return `No ${part} on ${board.project}'s board${wanted || release || words ? ' match' : ''}.`;
  const plain = records.map(({ updatedAt: _a, updatedBy: _b, ...r }) => r);
  return clip(`${plural(records.length, part === 'log' ? 'log entry' : `${part.replace(/s$/, '')}`, part === 'log' ? 'log entries' : part)} on ${board.project}'s board:\n${JSON.stringify(plain, null, 1)}`, LOOK_CHARS);
}

// ---- The steps -----------------------------------------------------------------------------

const BOARD_VIEWS = ['overview', 'timeline', 'releases', 'features', 'tests', 'decisions', 'commands', 'log'];
const LOOK_PARTS = BOARD_PARTS;
const PRIORITY_IDS = PRIORITIES.map((p) => p.id);
const DECISION_IDS = DECISIONS.map((d) => d.id);
const AREA_IDS = AREAS.map((a) => a.id);

function checkFind(s) {
  if (s.type != null && s.type !== 'all' && !TYPE_IDS.includes(s.type)) return `"type" must be one of ${TYPE_IDS.join(', ')}`;
  if (s.status != null && !['open', 'all', ...STATUSES].includes(s.status)) return '"status" must be open, all, pending, in_progress or done';
  if (!dueOk(s.due)) return `"due" must be one of ${DUE_FILTERS.join(', ')} or a range like 2026-11-01..2026-11-30`;
  if (s.priority != null && !PRIORITY_IDS.includes(s.priority)) return `"priority" must be one of ${PRIORITY_IDS.join(', ')}`;
  if (!optText(s.query, 500) || !optText(s.project, 200) || !optText(s.tag, 100)) return 'query, project and tag must be short text';
  return '';
}

const boardProject = (s) => (isText(s.project, 200) ? '' : 'say which "project" the board belongs to');

function checkBoardChanges(s) {
  if (boardProject(s)) return boardProject(s);
  const changes = s.changes ?? [];
  if (!Array.isArray(changes) || changes.length > 200) return '"changes" must be a list (at most 200)';
  for (const c of changes) {
    if (!isObject(c) || !LOOK_PARTS.includes(c.part)) return `each change needs a "part": ${LOOK_PARTS.join(', ')}`;
    if (!isId(c.id) && !(c.set && (c.part === 'log' || c.part === 'actions'))) return 'each change needs the record\'s "id"';
    if (c.set != null && !isObject(c.set)) return '"set" must be an object of fields';
    if (c.comment != null && !isText(c.comment)) return 'a "comment" needs some text';
    if (!c.set && !c.remove && c.comment == null) return 'each change needs "set", "remove" or "comment"';
  }
  if (!changes.length && !isText(s.log, 2000) && s.headline == null && s.summary == null) return 'nothing to change: give changes, log or headline';
  if (!optText(s.log, 2000) || !optText(s.headline, 500) || !optText(s.summary, 4000)) return 'log, headline and summary must be text';
  return '';
}

function boardRisk(s) {
  const changes = s.changes ?? [];
  if (changes.some((c) => c.remove)) return 'danger';
  const closes = (c) => (c.part === 'releases' && c.set?.status === 'closed') || (c.part === 'decisions' && (c.set?.status === 'decided' || c.set?.decided != null));
  return changes.some(closes) || changes.length > 20 ? 'ask' : 'auto';
}

function checkItemList(s) {
  if (!Array.isArray(s.items) || !s.items.length) return '"items" must list them';
  if (s.items.some((i) => !isObject(i))) return 'each of "items" must be an object';
  return '';
}

const tagList = (v) => v == null || (Array.isArray(v) && v.length <= 30 && v.every((t) => typeof t === 'string' && t.length <= 100));

function checkUpdates(s) {
  const bad = checkItemList(s);
  if (bad) return bad;
  if (s.items.length > 200) return 'at most 200 items at once';
  for (const u of s.items) {
    if (!isId(u.id)) return 'each update needs the item\'s "id"';
    if (!tagList(u.tags) || !tagList(u.add_tags) || !tagList(u.remove_tags)) return 'tags must be lists of names';
  }
  return '';
}

const titles = (list, max = 3) => {
  const names = list.slice(0, max).map((t) => `“${short(t, 50)}”`);
  return list.length > max ? `${names.join(', ')} and ${list.length - max} more` : names.join(', ');
};

/** What an update-items step sets, in a few words ("due 2026-11-09, +#layer-08"), when all its updates set the same. */
function updateWords(items) {
  const key = (u) => JSON.stringify({ ...u, id: undefined, why: undefined });
  if (new Set(items.map(key)).size !== 1) return `(${[...new Set(items.flatMap((u) => Object.keys(u).filter((k) => !['id', 'why'].includes(k))))].join(', ')})`;
  const u = items[0];
  const words = [];
  for (const [k, v] of Object.entries(u)) {
    if (k === 'id' || k === 'why') continue;
    if (k === 'add_tags') words.push(cleanTags(v).map((t) => `+#${t}`).join(' '));
    else if (k === 'remove_tags') words.push(cleanTags(v).map((t) => `−#${t}`).join(' '));
    else if (k === 'tags') words.push(`tags ${cleanTags(v).map((t) => `#${t}`).join(' ') || 'none'}`);
    else if (k === 'append_notes') words.push('notes added to');
    else if (k === 'notes' || k === 'feedback') words.push(`${k} rewritten`);
    else if (k === 'pinned') words.push(v ? 'pinned' : 'unpinned');
    else if (k === 'status') words.push(v === 'in_progress' ? 'in progress' : str(v));
    else words.push(`${k} ${str(v) === '' ? 'cleared' : short(v, 40)}`);
  }
  return words.join(', ');
}

/**
 * The steps the model may propose. `look`: runs at once, what it finds goes back to the model;
 * else `risk(step)`: 'auto' (runs by itself, can be undone), 'ask' (waits for Apply) or 'danger'
 * (deletes: asked with a warning). `page`: done by the page (opening, showing). `board`: changes a
 * release board. `fields` is what the model is told the step takes; `check` says what is wrong
 * ('' when nothing); `text` says what it does, for its card (`c`: names to show, see describeStep).
 */
export const STEPS = {
  // ---- Looking ----
  find: {
    look: true,
    fields: '{ "query"?: "words, \\"a phrase\\", #tag, +project", "type"?: "task" | "idea" | "claude" | "doc", "status"?: "open" (default) | "all" | "pending" | "in_progress" | "done", "project"?: "Name" | "none", "tag"?: "name", "due"?: "overdue" | "today" | "tomorrow" | "this-week" | "next-week" | "none" | "any" | "2026-11-01..2026-11-30", "priority"?: "high", "pinned"?: true, "sort"?: "due" | "updated" | "created", "limit"?: 40 }',
    check: checkFind,
    text: (s) => {
      const bits = [s.query && `“${short(s.query, 50)}”`, s.type && s.type !== 'all' && `${s.type}s`, s.project && `in ${s.project}`, s.tag && `#${str(s.tag).replace(/^#/, '')}`, s.due && `due ${s.due}`, s.status && s.status !== 'open' && s.status].filter(Boolean);
      return `Find items${bits.length ? `: ${bits.join(', ')}` : ''}`;
    },
  },
  item: { look: true, fields: '{ "id": "<item id>" }  (the whole item: notes, comments, review, files)', check: (s) => (isId(s.id) ? '' : 'give the item\'s "id"'), text: (s, c) => `Read “${short(c.titleOf?.(s.id) ?? s.id)}”` },
  shown: { look: true, fields: '{}  (the items on the person\'s screen now)', check: () => '', text: () => 'Look at the items on screen' },
  projects: { look: true, fields: '{}  (every project with its area and description; every tag with how many items have it)', check: () => '', text: () => 'Look at the projects and tags' },
  board: { look: true, fields: '{ "project": "Name" }  (where its release board stands: releases with their steps, what waits, open decisions, the latest log)', check: boardProject, text: (s) => `Look at ${s.project}'s release board` },
  'board-records': {
    look: true,
    fields: `{ "project": "Name", "part": ${LOOK_PARTS.map((p) => `"${p}"`).join(' | ')}, "ids"?: ["v1.1"], "release"?: "v1.1", "query"?: "words" }  (whole records, to see their fields before changing them)`,
    check: (s) => boardProject(s) || (!LOOK_PARTS.includes(s.part) ? `"part" must be one of ${LOOK_PARTS.join(', ')}` : ''),
    text: (s) => `Look at the ${s.part} of ${s.project}'s release board`,
  },
  waiting: { look: true, fields: '{}  (what waits on the person: steps on the release boards, overdue items, items due today and tomorrow, documents to read)', check: () => '', text: () => 'Look at what waits on you' },

  // ---- Changes that are easy to undo: they run by themselves ----
  'add-items': {
    fields: `{ "items": [{ "title": "Fix the leak", "type"?: "task" | "idea" | "claude" | "doc", "status"?, "priority"?: "low" | "normal" | "high" | "urgent", "due"?: "2026-11-03", "project"?: "Kitchen", "tags"?: ["home"], "notes"?: "Markdown", "url"?, "kind"?, "pinned"? }] }  (at most ${MAX_NEW_ITEMS})`,
    risk: () => 'auto',
    check: (s) => checkItemList(s) || (s.items.length > MAX_NEW_ITEMS ? `at most ${MAX_NEW_ITEMS} items at once` : s.items.some((i) => !isText(i.title, 500)) ? 'each item needs a "title"' : s.items.some((i) => !tagList(i.tags)) ? 'tags must be lists of names' : ''),
    text: (s) => `Add ${plural(s.items.length, 'item')}: ${titles(s.items.map((i) => i.title))}${s.items.every((i) => i.project && projectKey(i.project) === projectKey(s.items[0].project)) ? ` to ${s.items[0].project}` : ''}`,
  },
  'update-items': {
    fields: '{ "items": [{ "id": "<item id>", "status"?, "priority"?, "due"?: "2026-11-09" | "", "project"?: "Name" | "", "title"?, "type"?, "kind"?, "url"?, "notes"? (replaces them), "append_notes"?, "tags"? (replaces them), "add_tags"?, "remove_tags"?, "pinned"?, "decision"?: "approved" | "changes" | "rejected" | "", "feedback"? }] }',
    riskText: `auto (more than ${MAX_AUTO_ITEMS} items: ask)`,
    risk: (s) => (s.items.length > MAX_AUTO_ITEMS ? 'ask' : 'auto'),
    check: checkUpdates,
    text: (s, c) => `Change ${s.items.length === 1 ? `“${short(c.titleOf?.(s.items[0].id) ?? s.items[0].id)}”` : plural(s.items.length, 'item')}: ${updateWords(s.items)}`,
  },
  comment: {
    fields: '{ "id": "<item id>", "text": "..." }  (a comment from the person, on their behalf)',
    risk: () => 'auto',
    check: (s) => (!isId(s.id) ? 'give the item\'s "id"' : !isText(s.text) ? 'give the comment\'s "text"' : ''),
    text: (s, c) => `Comment on “${short(c.titleOf?.(s.id) ?? s.id)}”: “${short(s.text, 80)}”`,
  },
  'save-project': {
    fields: '{ "name": "Kitchen", "area"?: "work" | "personal" | "", "color"?: "#2f6fd6", "description"? }  (creates the project, or changes these)',
    risk: () => 'auto',
    check: (s) =>
      !isText(s.name, 200) ? 'give the project\'s "name"' : s.area != null && s.area !== '' && !AREA_IDS.includes(s.area) ? '"area" must be work, personal or ""' : s.color != null && s.color !== '' && !/^#[0-9a-f]{6}$/i.test(s.color) ? '"color" must look like #2f6fd6' : !optText(s.description, 500) ? '"description" must be short text' : '',
    text: (s, c) => `${c.projectOf?.(s.name) ? 'Change' : 'Create'} the project ${cleanProjectName(s.name)}${s.area ? ` (${s.area})` : ''}`,
  },
  'update-board': {
    board: true,
    fields: '{ "project": "Name", "changes"?: [{ "part": "releases", "id": "v1.1", "set": { "title": "…", "status": "planned", "steps.2.done": true } } | { "part", "id", "remove": true } | { "part", "id", "comment": "…" }], "log"?: "what happened", "headline"?: "where it stands", "summary"? }  (a project without a board gets one)',
    riskText: 'auto (closing a release or deciding: ask; removing records: danger)',
    risk: boardRisk,
    check: checkBoardChanges,
    text: (s) => {
      const changes = s.changes ?? [];
      const what = changes.length ? `${plural(changes.length, 'change')} (${[...new Set(changes.map((c) => `${c.part} ${str(c.id)}`.trim()))].slice(0, 3).join(', ')}${changes.length > 3 ? '…' : ''})` : '';
      return `${s.project}'s release board: ${[what, s.log && `log “${short(s.log, 70)}”`, (s.headline || s.summary) && 'where it stands'].filter(Boolean).join(', ')}`;
    },
  },
  tick: {
    board: true,
    fields: '{ "project": "Name", "release": "v1.1", "step": 2 | "Step label", "done"?: true }  or  { "project", "action": "<action id>" }  or  { "project", "release", "command": "<command id>" }  (done: false unticks)',
    risk: () => 'auto',
    check: (s) =>
      boardProject(s) ||
      (isId(s.action) ? '' : isId(s.command) ? (isId(s.release) ? '' : 'a command needs its "release"') : s.step != null ? (isId(s.release) || isId(s.event) ? '' : 'a step needs its "release"') : 'say what to tick: "action", "command" or "step"'),
    text: (s) => `${s.done === false ? 'Untick' : 'Tick done'} on ${s.project}'s board: ${s.action ? `“${s.action}”` : s.command ? `${s.release} command ${s.command}` : `${s.release ?? s.event} step ${typeof s.step === 'number' ? s.step : `“${short(s.step, 50)}”`}`}`,
  },
  'make-plan': {
    fields: '{ "kind": "day" | "week" }  (writes today\'s plan, or the review of the week, with the model; the earlier one stays among its versions)',
    risk: () => 'auto',
    check: (s) => (['day', 'week'].includes(s.kind) ? '' : '"kind" must be day or week'),
    text: (s) => (s.kind === 'week' ? 'Write the review of your week' : 'Write the plan for your day'),
  },
  'open-item': { page: true, fields: '{ "id": "<item id>" }  (opens it for the person)', risk: () => 'auto', check: (s) => (isId(s.id) ? '' : 'give the item\'s "id"'), text: (s, c) => `Open “${short(c.titleOf?.(s.id) ?? s.id)}”` },
  'open-board': {
    page: true,
    fields: `{ "project": "Name", "view"?: ${BOARD_VIEWS.map((v) => `"${v}"`).join(' | ')} }  (shows the release board)`,
    risk: () => 'auto',
    check: (s) => boardProject(s) || (s.view != null && !BOARD_VIEWS.includes(s.view) ? `"view" must be one of ${BOARD_VIEWS.join(', ')}` : ''),
    text: (s) => `Show ${s.project}'s release board${s.view && s.view !== 'overview' ? ` (${s.view})` : ''}`,
  },
  'show-items': {
    page: true,
    fields: '{ "query"?: "words #tag +project", "type"?: "task" | "idea" | "claude" | "doc", "status"?: "pending" | "in_progress" | "done" }  (the list of items with that search)',
    risk: () => 'auto',
    check: (s) => (!optText(s.query, 300) ? '"query" must be short text' : s.type != null && !TYPE_IDS.includes(s.type) ? `"type" must be one of ${TYPE_IDS.join(', ')}` : s.status != null && !STATUSES.includes(s.status) ? '"status" must be pending, in_progress or done' : ''),
    text: (s) => `Show the items${s.query ? ` matching “${short(s.query, 50)}”` : ''}${s.type ? ` (${s.type}s)` : ''}`,
  },

  // ---- Asked first ----
  'rename-project': {
    fields: '{ "name": "Old name", "to": "New name" }  (its items move along; an existing name merges the two)',
    risk: () => 'ask',
    check: (s) => (!isText(s.name, 200) || !isText(s.to, 200) ? 'give "name" and "to"' : ''),
    text: (s, c) => `Rename the project ${s.name} to ${cleanProjectName(s.to)}${c.projectOf?.(s.name) ? ` (its ${plural(c.projectOf(s.name).total, 'item')} move along)` : ''}`,
  },
  'rename-tag': {
    fields: '{ "from": "old", "to": "new" }  (on every item that has it; an existing tag merges)',
    risk: () => 'ask',
    check: (s) => (!isText(s.from, 100) || !isText(s.to, 100) ? 'give "from" and "to"' : ''),
    text: (s, c) => `Rename #${str(s.from).replace(/^#/, '')} to #${cleanTags([s.to])[0] ?? s.to}${c.tagCount ? ` on ${plural(c.tagCount(s.from), 'item')}` : ''}`,
  },
  'delete-tag': {
    fields: '{ "tag": "old" }  (taken off every item that has it; the items stay)',
    risk: () => 'ask',
    check: (s) => (isText(s.tag, 100) ? '' : 'give the "tag"'),
    text: (s, c) => `Take #${str(s.tag).replace(/^#/, '')} off ${c.tagCount ? plural(c.tagCount(s.tag), 'item') : 'its items'}`,
  },
  decide: {
    board: true,
    fields: '{ "project": "Name", "id": "<decision id>", "choice": "one of its options, or the person\'s words" }',
    risk: () => 'ask',
    check: (s) => boardProject(s) || (!isId(s.id) ? 'give the decision\'s "id"' : !isText(s.choice, 2000) ? 'give the "choice"' : ''),
    text: (s) => `Decide ${s.id} on ${s.project}'s board: “${short(s.choice, 80)}”`,
  },

  // ---- Deleting: asked with a warning ----
  'delete-items': {
    fields: '{ "ids": ["<item id>"] }  (only when the person asks to delete)',
    risk: () => 'danger',
    check: (s) => (Array.isArray(s.ids) && s.ids.length > 0 && s.ids.length <= 200 && s.ids.every(isId) ? '' : '"ids" must list the items\' ids'),
    text: (s, c) => `Delete ${plural(s.ids.length, 'item')}: ${titles(s.ids.map((id) => c.titleOf?.(id) ?? id))}`,
  },
  'delete-project': {
    fields: '{ "name": "..." }  (only when the person asks; its items stay, without a project)',
    risk: () => 'danger',
    check: (s) => (isText(s.name, 200) ? '' : 'give the project\'s "name"'),
    text: (s, c) => `Delete the project ${s.name}${c.projectOf?.(s.name) ? ` (its ${plural(c.projectOf(s.name).total, 'item')} stay, without a project)` : ''}`,
  },
};

/** Steps that change items, projects or tags (applyDataStep does them). */
export const DATA_STEPS = new Set(['add-items', 'update-items', 'comment', 'delete-items', 'save-project', 'rename-project', 'delete-project', 'rename-tag', 'delete-tag']);

/**
 * One step from the model → { step, op, look, page, board, risk, text, why } or { step, problem }:
 * its op must be known and its fields right. `names` (optional) makes the text readable:
 * { titleOf(id), projectOf(name) → { name, total } | null, tagCount(tag) }.
 */
export function describeStep(raw, names = {}) {
  const step = isObject(raw) ? raw : {};
  const def = STEPS[step.op];
  if (!def) return { step, problem: `“${str(step.op) || '?'}” is not a step the assistant can do` };
  const bad = def.check(step);
  if (bad) return { step, problem: `${step.op}: ${bad}` };
  return {
    step,
    op: step.op,
    look: Boolean(def.look),
    page: Boolean(def.page),
    board: Boolean(def.board),
    risk: def.look ? 'look' : def.risk(step),
    text: def.text(step, names),
    why: typeof step.why === 'string' ? step.why.slice(0, 300) : '',
  };
}

/**
 * The model's reply → { text (its words, the steps' block taken out), steps (described), problems }.
 * The steps are in ```tracker-steps fences (a JSON list, or one step); a ```json one whose list
 * holds steps counts too.
 */
export function parsePlan(reply, names = {}) {
  const text = str(reply);
  const steps = [];
  const problems = [];
  const used = [];
  // Fences as CommonMark reads them: a ``` inside a step's notes (a code block) never ends the block.
  for (const block of codeFences(text)) {
    const lang = block.lang;
    if (lang && lang !== 'tracker-steps' && lang !== 'json') continue;
    let parsed;
    try {
      parsed = parseJsonLoose(block.body);
    } catch {
      if (lang === 'tracker-steps') problems.push('The steps were not valid JSON.');
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (lang !== 'tracker-steps' && !list.every((x) => isObject(x) && typeof x.op === 'string')) continue;
    used.push(block);
    for (const raw of list.slice(0, 20)) {
      const d = describeStep(raw, names);
      if (d.problem) problems.push(d.problem);
      else steps.push(d);
    }
  }
  return { text: withoutBlocks(text, used), steps, problems };
}

/** While the answer streams: the words before the steps' block. */
export const wordsSoFar = (text) => wordsBefore(str(text), ['tracker-steps', 'json']);

// ---- What the model is told ----------------------------------------------------------------

const stepList = () =>
  Object.entries(STEPS)
    .map(([op, d]) => `- ${op} ${d.fields} — ${d.look ? 'looks' : d.page ? 'auto (opens or shows something)' : (d.riskText ?? d.risk({ items: [], changes: [] }))}`)
    .join('\n');

/** Worked examples: what people ask most, and the steps that do it. */
export const EXAMPLES = `- "Make a project Kitchen with tasks: fix the leak, call the plumber Monday, buy parts" → save-project { "name": "Kitchen", "area": "personal" }, then add-items with the three tasks in Kitchen (the call due next Monday), in the same block.
- "Tag everything about Deep Time's coal forests with #layer-08" → find { "query": "coal forest", "project": "Deep Time", "status": "all" } alone; then update-items with "add_tags": ["layer-08"] for the items that really are about it (more than ${MAX_AUTO_ITEMS}: the person is asked).
- "Move my overdue tasks to next week" → find { "type": "task", "due": "overdue" }; then update-items setting each "due" to next Monday (or each a week later, when asked so).
- "Mark the phone playtest passed" → look at the boards that may have it (board-records with part "tests" and a query); then update-board { "changes": [{ "part": "tests", "id": "…", "set": { "status": "passed" } }], "log": "Phone playtest passed" }.
- "Start a release board for Reel Ledger with v1.1: series and books" → update-board { "project": "Reel Ledger", "changes": [{ "part": "releases", "id": "v1.1", "set": { "title": "Series and books", "status": "planned", "steps": [{ "label": "Built", "done": false }, { "label": "Tested", "done": false }, { "label": "Released", "done": false }] } }], "headline": "Next: v1.1, series and books" }.
- "Tick Built on Deep Time's 2.3" → board { "project": "Deep Time" } to see the steps; then tick { "project": "Deep Time", "release": "2.3", "step": "Built" }.
- "What is due this week?" → find { "due": "this-week" }, then answer with the list (no changes).
- "Pin my in-progress Deep Time tasks" → find { "project": "Deep Time", "status": "in_progress" }; then update-items with "pinned": true.
- "Approve the language servers proposal and tell Claude it looks good" → find { "query": "language servers", "type": "doc", "status": "all" }; then update-items { "decision": "approved", "feedback": "Looks good" } (or a comment, when asked to comment).
- "Done with the leak" → find { "query": "leak" }; then update-items { "status": "done" }.
- "Plan my day" → make-plan { "kind": "day" }.
- "How do I attach a photo?" → no steps: the steps from the guide (open the item, Attach or Photo under the notes; or drop or paste the picture on it).`;

const BOARDS_MODEL = `Release boards (one per project, for its releases): parts ${BOARD_PARTS.join(', ')}. Every record has an "id". Statuses: ${BOARD_STATUSES.join(', ')}. A release: { "id": "v1.1", "title", "status", "summary", "ship_label", "dates": { "expected", "released" }, "steps": [{ "label", "done", "date" }], "features": [feature ids], "milestones": [{ "date": "2026-11-04 18:00", "label", "state": "planned" | "done" }] }; a feature: { "id", "name", "release", "status", "what" }; a test: { "id", "name", "release", "status" }; a decision: { "id", "code", "title", "options": […], "status": "open" | "decided", "choice" }; an action (waits on the person): { "id", "text", "when", "release", "done" }. Look (board, board-records) before changing records you have not seen; set only the fields that change ("steps.2.done": true reaches inside; null removes a field). Log what happened in "log".`;

/**
 * The system message: what the assistant is for, how it looks and changes things, its steps,
 * the rules, worked examples and (`guide`: the tracker's guide) how the app works, for answers on
 * how to do something. The same each time for one guide, so Claude caches it.
 */
export function assistantSystem({ guide = '' } = {}) {
  return `You are the assistant inside Tracker, the person's own tracker of tasks, ideas, Claude work and documents to read, with projects, tags, release boards and plans. You change things in it when asked, and you explain how to do things in the app. Be brief and concrete (Markdown).

Every question comes with a picture of the tracker: today's date, the projects, the tags, the release boards and what is on the person's screen. What the items say is not in it: look it up with steps.

To look something up, or to change something, end your answer with ONE block like this:
\`\`\`tracker-steps
[{ "op": "find", "query": "kitchen", "why": "find the kitchen tasks" }]
\`\`\`
Each step is an object with "op", its fields, and a short "why". Only these steps exist:
${stepList()}

How steps run:
- Looking steps run at once and what they find comes back to you. Put them in a block of their own; changes in the same block are not run. You may look several times.
- "auto" steps run by themselves, and the person can undo each one; "ask" steps wait for the person to click Apply; "danger" steps (deleting) ask with a warning.
- Steps run in order and stop at the first that fails or is skipped; then the results come back to you, so you can explain or fix.
- Use the ids from what you looked up or from the picture; never make up an id. Find before you change: "my overdue tasks" → find with "due": "overdue", then update-items with those ids.

Rules:
- Dates are YYYY-MM-DD, worked out from today ("Monday", "next week", "in two weeks").
- Reuse the exact spelling of existing projects and tags. A new project is made by using its name, or by save-project when the person gives its area or color.
- Keep titles short; details go in notes (Markdown; checklists as "- [ ] step").
- Change only what the person asked for. Delete only when they ask to delete.
- After changes, say in a sentence what changed. Name items by their title (their ids become links).
- When the person asks how to do something, or the message says Explain only: write NO steps that change things (looking is fine). Give numbered steps in the app, with the buttons, menus and keys from the guide, and say where the result shows.
- Answer questions that need no step without a block.

${BOARDS_MODEL}

Examples (adapt them to the real projects, tags and ids):
${EXAMPLES}${guide ? `\n\nThe tracker's guide (for how to do things in the app):\n${guide}` : ''}`;
}

/** Marked on a question when the person turned on Only explain. */
export const EXPLAIN_ONLY = '(Explain only: tell me how to do it myself in the app, step by step; do not change anything.)';

/**
 * The picture of the tracker that goes with each question: today, counts, the projects, the tags,
 * the release boards, what is on screen and the item open, if any.
 * `items`: live items; `projects`: projectList's; `boards`: [{ project }]; `screen`: { label,
 * shown } (what the list shows, and how many); `open`: the item open ({ id, title, type, project }).
 */
export function contextText({ today, time = '', items = [], projects = [], boards = [], screen = null, open = null }) {
  const live = items.filter((i) => !i.deleted);
  const openItems = live.filter((i) => i.status !== 'done');
  const byType = TYPE_IDS.map((t) => [t, openItems.filter((i) => i.type === t).length]).filter(([, n]) => n);
  const typeWords = { task: 'tasks', idea: 'ideas', claude: 'Claude work', doc: 'documents to read' };
  const overdue = openItems.filter((i) => isOverdue(i, today)).length;
  const lines = [`Today: ${WEEKDAYS[dayOfWeek(today)]} ${today}${time ? `, ${time}` : ''} (the person's time).`];
  lines.push(`Items: ${live.length} (${openItems.length} open${byType.length ? `: ${byType.map(([t, n]) => `${n} ${typeWords[t]}`).join(', ')}` : ''}${overdue ? `; ${overdue} overdue` : ''}).`);
  lines.push(
    projects.length
      ? `Projects (name · area · open/total items): ${projects
          .slice(0, 80)
          .map((p) => `${p.name}${p.area ? ` · ${p.area}` : ''} · ${p.open}/${p.total}`)
          .join('; ')}${projects.length > 80 ? `; and ${projects.length - 80} more (projects lists them all)` : ''}.`
      : 'Projects: none yet.',
  );
  const tags = tagCounts(live);
  lines.push(tags.length ? `Tags: ${tags.slice(0, 80).map((t) => `#${t.tag} (${t.count})`).join(', ')}${tags.length > 80 ? `, and ${tags.length - 80} more` : ''}.` : 'Tags: none yet.');
  lines.push(boards.length ? `Release boards: ${boards.map((b) => b.project).join('; ')}.` : 'Release boards: none yet.');
  if (screen?.label) lines.push(`On screen: ${screen.label}${screen.shown != null ? ` (${plural(screen.shown, 'item')} shown; the step "shown" lists them)` : ''}.`);
  if (open) lines.push(`The item open: ${open.id} “${open.title}” (${open.type}${open.project ? `, ${open.project}` : ''}).`);
  return lines.join('\n');
}

/**
 * The messages for one turn: the system, the turns so far, the question with a fresh picture.
 * `explainOnly`: the person does it themselves. `guide`: the whole guide (in the system message);
 * `excerpts`: the guide's parts about this question (a model on this computer: small contexts).
 */
export function assistantMessages(question, context, history = [], { explainOnly = false, guide = '', excerpts = '' } = {}) {
  return [
    { role: 'system', content: assistantSystem({ guide }) },
    ...history,
    { role: 'user', content: `${question}${explainOnly ? `\n\n${EXPLAIN_ONLY}` : ''}${context ? `\n\n<tracker>\n${context}\n</tracker>` : ''}${excerpts ? `\n\n<guide>\n${excerpts}\n</guide>` : ''}` },
  ];
}

/** What came of the steps, for the model's next turn. */
export function resultsMessage(results) {
  const said = { ok: 'done', skipped: 'skipped by the person', stopped: 'not run (stopped before it)', shown: 'shown to the person (Only explain)', failed: 'FAILED' };
  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.op}: ${r.text} — ${said[r.status] ?? r.status}`;
    const body = str(r.output).trim();
    return body ? `${head}\n${clip(body, LOOK_CHARS)}` : head;
  });
  return `Results of the steps:\n${lines.join('\n')}`;
}

// ---- The guide -----------------------------------------------------------------------------

/** The guide's sections (## and ###), each with its heading. */
export function guideSections(guide) {
  const out = [];
  let current = null;
  for (const line of str(guide).split('\n')) {
    const h = /^(#{2,3})\s+(.+)/.exec(line);
    if (h) out.push((current = { title: h[2].trim(), lines: [line] }));
    else current?.lines.push(line);
  }
  return out.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() }));
}

const STOP_WORDS = new Set('the and for how can what where when does with this that from into have want make my your you are its it’s it’s can’t i’m about there them they then than which who will would could should como que del los las una por para con donde cómo dónde'.split(' '));

/** The guide's sections most about the question, within `budget` characters, in the guide's order. */
export function guideFor(guide, question, { budget = 7000 } = {}) {
  const words = [...new Set(foldSearch(question).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP_WORDS.has(w)))];
  if (!words.length) return '';
  const sections = guideSections(guide).map((s, index) => {
    const title = foldSearch(s.title);
    const body = foldSearch(s.text);
    const score = words.reduce((n, w) => n + (title.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0), 0);
    return { ...s, index, score };
  });
  const picked = [];
  let room = budget;
  for (const s of [...sections].filter((x) => x.score > 0).sort((a, b) => b.score - a.score)) {
    if (s.text.length > room) continue;
    picked.push(s);
    room -= s.text.length;
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map((s) => s.text)
    .join('\n\n');
}

/** Whether a question asks how to do something (the guide helps), rather than for something to be done. */
export const asksHow = (question) => /\b(how|where|what does|what is|can i|is there|why)\b|\bc[oó]mo\b|\bd[oó]nde\b|\bqu[eé] es\b|\?$/i.test(str(question).trim());

// ---- Looks ---------------------------------------------------------------------------------

/** The board a step names, from the boards here ([{ slug, project, board }]): by project or slug. */
export function boardFor(boards, project) {
  const key = projectKey(project);
  const slug = boardSlug(project);
  return boards.find((b) => projectKey(b.project) === key) ?? boards.find((b) => b.slug === slug) ?? null;
}

/**
 * What a looking step finds, as text for the model. `env`: { items (live), projects
 * (projectList's), boards ([{ slug, project, board }]), shown (the items on screen), today, now }.
 */
export function lookText(step, env) {
  const { items = [], projects = [], boards = [], shown = null, today } = env;
  switch (step.op) {
    case 'find': {
      const limit = Math.min(Math.max(Number(step.limit) || 40, 1), 100);
      return itemLines(findItems(items, step, { today }), today, limit, 'items found');
    }
    case 'item': {
      const item = findLive(items, step.id);
      return itemText(item);
    }
    case 'shown':
      return shown ? itemLines(shown.filter((i) => !i.deleted), today, 100, 'items on screen') : 'The screen shows no list of items now.';
    case 'projects': {
      const tags = tagCounts(items.filter((i) => !i.deleted));
      const list = projects.map((p) => `- ${p.name}${p.area ? ` · ${p.area}` : ''}${p.description ? ` · “${short(p.description, 120)}”` : ''} · ${p.open} open of ${p.total}${p.pinned ? ` · ${p.pinned} pinned` : ''}${p.registered ? '' : ' (named on items only)'}`);
      return clip(`${projects.length ? `Projects:\n${list.join('\n')}` : 'No projects.'}\n\n${tags.length ? `Tags (items):\n${tags.map((t) => `#${t.tag} (${t.count})`).join(', ')}` : 'No tags.'}`, LOOK_CHARS);
    }
    case 'board': {
      const b = boardFor(boards, step.project);
      if (!b?.board) return `${step.project} has no release board${boards.length ? ` (boards: ${boards.map((x) => x.project).join(', ')})` : ''}.`;
      return boardText(b.board, env.now ?? new Date());
    }
    case 'board-records': {
      const b = boardFor(boards, step.project);
      if (!b?.board) return `${step.project} has no release board.`;
      return boardRecordsText(b.board, step);
    }
    case 'waiting': {
      const now = env.now ?? new Date();
      const lines = [];
      const onBoards = waitingEverywhere(boards.filter((b) => b.board), now);
      if (onBoards.length) lines.push('On the release boards:', ...onBoards.slice(0, 40).map((w) => `- ${w.project}: ${w.action.id}: ${str(w.action.text)}${w.action.when ? ` (${w.action.when})` : ''}`));
      const live = items.filter((i) => !i.deleted && i.status !== 'done');
      const overdue = live.filter((i) => isOverdue(i, today));
      const soon = live.filter((i) => i.due === today || i.due === addDays(today, 1));
      const docs = live.filter((i) => i.type === 'doc');
      if (overdue.length) lines.push(itemLines(sortItems(overdue, 'due'), today, 30, 'overdue items'));
      if (soon.length) lines.push(itemLines(sortItems(soon, 'due'), today, 30, 'items due today or tomorrow'));
      if (docs.length) lines.push(itemLines(sortItems(docs), today, 15, 'documents to read'));
      return lines.length ? clip(lines.join('\n\n'), LOOK_CHARS) : 'Nothing waits: no steps on the boards, nothing overdue or due soon, nothing to read.';
    }
    default:
      throw new StepError(`${step.op} is not a looking step.`);
  }
}

// ---- Items, projects and tags --------------------------------------------------------------

const ITEM_KEYS = ['type', 'title', 'status', 'priority', 'kind', 'project', 'url', 'due', 'notes', 'decision', 'feedback', 'pinned'];
// The fields Undo puts back (comments go back by deleting the ones a step added).
const EDIT_FIELDS = ['type', 'title', 'status', 'priority', 'kind', 'project', 'tags', 'url', 'due', 'notes', 'decision', 'feedback', 'pinned'];
const has = (o, k) => o[k] !== undefined && o[k] !== null;

function pickItemFields(input) {
  const out = {};
  for (const k of ITEM_KEYS) if (has(input, k)) out[k] = typeof input[k] === 'string' ? input[k].trim() : input[k];
  if (has(input, 'tags')) out.tags = cleanTags(input.tags);
  return out;
}

function checkItemFields(fields, type) {
  if (has(fields, 'type') && !TYPE_IDS.includes(fields.type)) throw new StepError(`type must be one of ${TYPE_IDS.join(', ')}.`);
  if (has(fields, 'status') && !STATUSES.includes(fields.status)) throw new StepError(`status must be one of ${STATUSES.join(', ')}.`);
  if (has(fields, 'priority') && !PRIORITY_IDS.includes(fields.priority)) throw new StepError(`priority must be one of ${PRIORITY_IDS.join(', ')}.`);
  if (has(fields, 'decision') && fields.decision !== '' && !DECISION_IDS.includes(fields.decision)) throw new StepError(`decision must be one of ${DECISION_IDS.join(', ')}, or "" to clear it.`);
  if (has(fields, 'due') && fields.due !== '' && !realDate(fields.due)) throw new StepError(`“${fields.due}” is not a date (YYYY-MM-DD, or "" to clear it).`);
  if (has(fields, 'pinned') && typeof fields.pinned !== 'boolean') throw new StepError('pinned must be true or false.');
  if (has(fields, 'title') && !str(fields.title).trim()) throw new StepError('A title cannot be empty.');
  for (const k of ['title', 'url', 'kind', 'project']) if (has(fields, k) && typeof fields[k] !== 'string') throw new StepError(`${k} must be text.`);
  for (const k of ['notes', 'feedback']) if (has(fields, k) && typeof fields[k] !== 'string') throw new StepError(`${k} must be text.`);
  const kinds = KINDS[fields.type ?? type];
  if (has(fields, 'kind') && fields.kind !== '' && !kinds?.some((k) => k.id === fields.kind)) {
    throw new StepError(kinds ? `kind for a ${fields.type ?? type} must be one of ${kinds.map((k) => k.id).join(', ')}.` : `a ${fields.type ?? type} has no kind.`);
  }
}

/** The live item an id names (or its exact title, when only one has it); a StepError when there is none. */
export function findLive(items, key) {
  const wanted = str(key).trim();
  const alive = items.filter((i) => !i.deleted);
  const byId = alive.find((i) => i.id === wanted);
  if (byId) return byId;
  const byTitle = alive.filter((i) => i.title.toLowerCase() === wanted.toLowerCase());
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new StepError(`Several items are titled “${wanted}”: use their ids.`);
  throw new StepError(`There is no item “${short(wanted, 80)}” (it may have been deleted): find it first.`);
}

const projectNames = (data) => projectList(data.items, data.projects).map((p) => p.name);
const knownProject = (data, name) => projectList(data.items, data.projects).find((p) => p.key === projectKey(name)) ?? null;
const tagSpelling = (data) => new Map(tagCounts(data.items).map((t) => [t.tag.toLowerCase(), t.tag]));
const spellTags = (tags, known) => cleanTags(tags.map((t) => known.get(cleanTags([t])[0]?.toLowerCase() ?? '') ?? t));

/** The fields of `patch` that would change `item` (an empty object when none would). */
function effective(item, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) if (k === 'comments' || !same(item[k] ?? (k === 'pinned' ? false : ''), v ?? (k === 'pinned' ? false : ''))) out[k] = v;
  return out;
}

/**
 * Does a step that changes items, projects or tags on `data` ({ items, projects }: every record,
 * tombstones too) and returns the new { items, projects } (records not changed stay the same
 * objects). Throws a StepError when it cannot be done. `by`: who it is written as (the device).
 */
export function applyDataStep(data, step, { now, by = '' }) {
  const { items, projects } = data;
  switch (step.op) {
    case 'add-items': {
      const names = projectNames(data);
      const known = tagSpelling(data);
      const created = step.items.map((input, n) => {
        const fields = pickItemFields(input);
        checkItemFields(fields, fields.type ?? 'task');
        if (!str(fields.title).trim()) throw new StepError(`Item ${n + 1} needs a title.`);
        if (fields.project) fields.project = resolveProjectName(fields.project, names);
        if (fields.tags) fields.tags = spellTags(fields.tags, known);
        return createItem({ type: 'task', ...fields, updatedBy: by }, now);
      });
      return { items: [...items, ...created], projects };
    }
    case 'update-items': {
      const names = projectNames(data);
      const known = tagSpelling(data);
      const patches = new Map();
      for (const u of step.items) {
        const item = findLive(items, u.id);
        const earlier = patches.get(item.id) ?? {};
        const patch = pickItemFields(u);
        checkItemFields(patch, patch.type ?? earlier.type ?? item.type);
        if (has(patch, 'project')) patch.project = patch.project ? resolveProjectName(patch.project, names) : '';
        let tags = patch.tags ? spellTags(patch.tags, known) : (earlier.tags ?? item.tags);
        if (u.add_tags) tags = cleanTags([...tags, ...spellTags(cleanTags(u.add_tags), known)]);
        if (u.remove_tags) {
          const out = new Set(cleanTags(u.remove_tags).map((t) => t.toLowerCase()));
          tags = tags.filter((t) => !out.has(t.toLowerCase()));
        }
        if (patch.tags || u.add_tags || u.remove_tags) patch.tags = tags;
        if (typeof u.append_notes === 'string' && u.append_notes.trim()) patch.notes = [patch.notes ?? earlier.notes ?? item.notes, u.append_notes.trim()].filter((s) => str(s).trim()).join('\n\n');
        if (has(patch, 'type') && patch.type !== item.type && !has(patch, 'kind')) patch.kind = '';
        patches.set(item.id, { ...earlier, ...patch });
      }
      return {
        items: items.map((i) => {
          if (i.deleted || !patches.has(i.id)) return i;
          const change = effective(i, patches.get(i.id));
          return Object.keys(change).length ? applyPatch(i, { ...change, updatedBy: by }, now) : i;
        }),
        projects,
      };
    }
    case 'comment': {
      const item = findLive(items, step.id);
      const patch = addCommentPatch(item, step.text, by, now);
      return { items: items.map((i) => (i === item ? applyPatch(i, { ...patch, updatedBy: by }, now) : i)), projects };
    }
    case 'delete-items': {
      const targets = new Set(step.ids.map((id) => findLive(items, id).id));
      return { items: items.map((i) => (targets.has(i.id) && !i.deleted ? tombstone(i, now, by) : i)), projects };
    }
    case 'save-project': {
      const name = cleanProjectName(step.name);
      const known = knownProject(data, name);
      const record = projects.find((p) => p.key === projectKey(name) && !p.deleted);
      const patch = {};
      if (step.area != null) patch.area = step.area;
      if (step.color != null) patch.color = str(step.color).toLowerCase();
      if (step.description != null) patch.description = str(step.description);
      if (record && Object.entries(patch).every(([k, v]) => same(record[k], v))) return data;
      return { items, projects: upsertProjectRecord(projects, known?.name ?? name, patch, now, by) };
    }
    case 'rename-project': {
      const known = knownProject(data, step.name);
      if (!known) throw new StepError(`There is no project “${step.name}”.`);
      const to = cleanProjectName(step.to);
      if (to === known.name) return data;
      return renameProjectIn(data, known.name, to, now, by);
    }
    case 'delete-project': {
      const known = knownProject(data, step.name);
      if (!known) throw new StepError(`There is no project “${step.name}”.`);
      return deleteProjectIn(data, known.name, now, by);
    }
    case 'rename-tag': {
      const known = tagSpelling(data);
      const from = known.get(cleanTags([step.from])[0]?.toLowerCase() ?? '');
      if (!from) throw new StepError(`No item has the tag #${str(step.from).replace(/^#/, '')}.`);
      const to = spellTags([step.to], known)[0];
      if (!to) throw new StepError('Give the new tag.');
      return { items: retagItems(items, from, to, now, by), projects };
    }
    case 'delete-tag': {
      const from = tagSpelling(data).get(cleanTags([step.tag])[0]?.toLowerCase() ?? '');
      if (!from) throw new StepError(`No item has the tag #${str(step.tag).replace(/^#/, '')}.`);
      return { items: retagItems(items, from, '', now, by), projects };
    }
    default:
      throw new StepError(`${step.op} does not change items.`);
  }
}

/** What a step changed: { items: [{ id, before (null: added), after }], projects: [{ key, before, after }] }. */
export function dataChanges(before, after) {
  const items = [];
  const projects = [];
  const was = new Map(before.items.map((i) => [i.id, i]));
  for (const i of after.items) {
    const b = was.get(i.id) ?? null;
    if (b !== i) items.push({ id: i.id, before: b, after: i });
  }
  const wasP = new Map(before.projects.map((p) => [p.key, p]));
  for (const p of after.projects) {
    const b = wasP.get(p.key) ?? null;
    if (b !== p) projects.push({ key: p.key, before: b, after: p });
  }
  return { items, projects };
}

const commentIds = (item) => new Set((item?.comments ?? []).filter((c) => !c.deleted).map((c) => c.id));

/**
 * Undoes a step's changes (dataChanges) on the data as it is now. Field by field: a field goes back
 * only while it still holds what the step wrote, so changes made since stay. Items the step added
 * are deleted, items it deleted come back, comments it added are deleted. Returns { items,
 * projects, kept } (kept: records left as they are, or partly, because they changed since).
 */
export function undoDataChanges(data, changes, { now, by = '' }) {
  let kept = 0;
  const itemChange = new Map();
  for (const { id, before, after } of changes.items) {
    const current = data.items.find((i) => i.id === id);
    if (!current) continue;
    let next = current;
    if (!before || before.deleted) {
      // Added by the step: deleted again.
      if (!current.deleted) next = tombstone(current, now, by);
    } else if (after.deleted) {
      // Deleted by the step: back, newer than its tombstone (unless it came back already).
      if (current.deleted) next = { ...reviveItem(before, current, now), updatedBy: by };
    } else if (current.deleted) {
      kept++;
    } else {
      const patch = {};
      let changedSince = false;
      for (const f of EDIT_FIELDS) {
        if (same(before[f], after[f])) continue;
        if (same(current[f], after[f])) patch[f] = before[f] ?? (f === 'pinned' ? false : '');
        else changedSince = true;
      }
      let withComments = current;
      for (const cid of commentIds(after)) if (!commentIds(before).has(cid) && commentIds(withComments).has(cid)) withComments = { ...withComments, ...deleteCommentPatch(withComments, cid, now) };
      if (withComments !== current) patch.comments = withComments.comments;
      if (changedSince) kept++;
      if (Object.keys(patch).length) next = applyPatch(current, { ...patch, updatedBy: by }, now);
    }
    if (next !== current) itemChange.set(id, next);
  }
  let projects = data.projects;
  for (const { key, before, after } of changes.projects) {
    const current = projects.find((p) => p.key === key);
    if (!current) continue;
    let next = current;
    if (!before || before.deleted) {
      if (!current.deleted && !after.deleted) next = deleteProjectRecord([current], current.name, now, by)[0];
    } else if (after.deleted) {
      if (current.deleted) next = normalizeProject({ ...before, deleted: false, updatedAt: bumpTime(current.updatedAt, now), updatedBy: by });
    } else if (!current.deleted) {
      const patch = {};
      for (const f of ['name', 'area', 'color', 'description']) {
        if (same(before[f], after[f])) continue;
        if (same(current[f], after[f])) patch[f] = before[f];
        else kept++;
      }
      if (Object.keys(patch).length) next = normalizeProject({ ...current, ...patch, updatedAt: bumpTime(current.updatedAt, now), updatedBy: by });
    }
    if (next !== current) projects = projects.map((p) => (p.key === key ? next : p));
  }
  return { items: data.items.map((i) => itemChange.get(i.id) ?? i), projects, kept };
}

// ---- Release boards ------------------------------------------------------------------------

function tickTarget(step) {
  if (isId(step.action)) return { kind: 'action', id: step.action };
  if (isId(step.command)) return { kind: 'command', release: step.release, command: step.command };
  return { kind: 'step', part: step.event && !step.release ? 'events' : 'releases', id: step.release ?? step.event, index: typeof step.step === 'number' ? step.step : -1, label: typeof step.step === 'string' ? step.step : undefined };
}

/**
 * The board after a board step (update-board, tick, decide), from the board as it is (null: the
 * project has none yet; update-board starts one for `project`). Throws a StepError when it cannot.
 */
export function boardAfter(board, step, { at, by = '', project = step.project } = {}) {
  try {
    switch (step.op) {
      case 'update-board': {
        let next = board ?? emptyBoard(project);
        const changes = (step.changes ?? []).map((c) => ({
          part: c.part,
          ...(c.id != null ? { id: c.id } : {}),
          ...(isObject(c.set) ? { set: c.set } : {}),
          ...(c.remove ? { remove: true } : {}),
          ...(c.comment != null ? { comment: c.comment, ...(c.command ? { command: c.command } : {}) } : {}),
        }));
        if (changes.length) next = applyBoardChanges(next, changes, { at, by }).board;
        if (str(step.log).trim()) next = addLog(next, { text: step.log, release: step.release, item: step.item }, { at, by });
        if (step.headline != null || step.summary != null) next = setNow(next, { headline: step.headline, summary: step.summary }, { at, by });
        return next;
      }
      case 'tick':
        if (!board) throw new StepError(`${project} has no release board.`);
        return boardTick(board, tickTarget(step), step.done !== false, { at, by });
      case 'decide':
        if (!board) throw new StepError(`${project} has no release board.`);
        return decideBoard(board, step.id, step.choice, { at, by });
      default:
        throw new StepError(`${step.op} does not change a board.`);
    }
  } catch (err) {
    throw err instanceof StepError ? err : new StepError(err.message);
  }
}

// Paths where two versions of a record differ: into objects and arrays of the same length, else the field.
function diffPaths(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if (!prefix && ['updatedAt', 'updatedBy', 'comments', 'id'].includes(k)) continue;
    const x = a?.[k];
    const y = b?.[k];
    if (same(x, y)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    const deeper = (isObject(x) && isObject(y)) || (Array.isArray(x) && Array.isArray(y) && x.length === y.length);
    if (deeper && path.split('.').length < 4) diffPaths(x, y, path, out);
    else out.push(path);
  }
  return out;
}
const getPath = (o, path) => path.split('.').reduce((node, k) => (node == null ? undefined : node[k]), o);

/** What a board step changed: { created, records: [{ part, id, before (null: added), after }], now: { before, after } | null }. */
export function boardChanges(before, after) {
  const records = [];
  for (const part of BOARD_PARTS) {
    const was = new Map((before?.[part] ?? []).map((r) => [r.id, r]));
    for (const r of after?.[part] ?? []) {
      const b = was.get(r.id) ?? null;
      if (!same(b, r)) records.push({ part, id: r.id, before: b, after: r });
    }
  }
  const nowChanged = !same(before?.now?.headline, after?.now?.headline) || !same(before?.now?.summary, after?.now?.summary);
  return { created: !before, records, now: nowChanged ? { before: before?.now ?? {}, after: after?.now ?? {} } : null };
}

/**
 * Undoes a board step's changes (boardChanges) on the board as it is now, field by field (what
 * changed since stays): records it added are removed (log lines too), records it removed come
 * back, comments it added are deleted. Returns { board, kept }.
 */
export function undoBoardChanges(board, changes, { at, by = '' }) {
  let kept = 0;
  let next = board;
  const list = [];
  for (const { part, id, before, after } of changes.records) {
    const current = (next[part] ?? []).find((r) => r.id === id);
    if (!current) continue;
    if (!before || before.deleted) {
      if (!current.deleted) list.push({ part, id, remove: true });
      continue;
    }
    if (after.deleted) {
      if (current.deleted) {
        const back = { ...before, updatedAt: bumpTime(current.updatedAt, at), updatedBy: by };
        next = { ...next, [part]: next[part].map((r) => (r.id === id ? back : r)) };
      }
      continue;
    }
    if (current.deleted) {
      kept++;
      continue;
    }
    const set = {};
    let changedSince = false;
    for (const path of diffPaths(before, after)) {
      if (same(getPath(current, path), getPath(after, path))) set[path] = getPath(before, path) ?? null;
      else changedSince = true;
    }
    if (changedSince) kept++;
    if (Object.keys(set).length) list.push({ part, id, set });
    const added = [...commentIds(after)].filter((c) => !commentIds(before).has(c) && commentIds(current).has(c));
    for (const c of added) list.push({ part, id, uncomment: c });
  }
  if (list.length) next = applyBoardChanges(next, list, { at, by }).board;
  if (changes.now && same(next.now?.headline, changes.now.after.headline) && same(next.now?.summary, changes.now.after.summary)) {
    next = setNow(next, { headline: str(changes.now.before.headline), summary: str(changes.now.before.summary) }, { at, by });
  }
  return { board: next, kept };
}

/** Whether a board holds nothing (only tombstones, no headline): Undo of the step that started it removes its file. */
export const boardIsEmpty = (board) => !str(board?.now?.headline).trim() && !str(board?.now?.summary).trim() && BOARD_PARTS.every((part) => !liveRecords(board, part).length);

// ---- What changed, to show and to tell the model -------------------------------------------

const show = (v) => {
  if (Array.isArray(v)) return v.length ? (v.every((x) => typeof x === 'string') ? v.join(', ') : `${v.length} entries`) : '—';
  if (isObject(v)) return '…';
  if (v === true) return 'yes';
  if (v === false || v == null || v === '') return '—';
  return short(String(v).replace(/\s+/g, ' '), 60);
};
const showTags = (v) => (Array.isArray(v) && v.length ? v.map((t) => `#${t}`).join(' ') : '—');

/**
 * Rows for a step's card and the model: [{ kind: 'item' | 'project' | 'record', id, title,
 * what: 'added' | 'deleted' | 'changed' | 'commented', changes: [{ field, from, to }] }].
 */
export function changeRows(changes) {
  const rows = [];
  for (const { id, before, after } of changes.items ?? []) {
    const title = after.deleted ? (before?.title ?? id) : after.title;
    if (!before || before.deleted) rows.push({ kind: 'item', id, title, what: 'added', changes: [] });
    else if (after.deleted) rows.push({ kind: 'item', id, title, what: 'deleted', changes: [] });
    else {
      const fields = EDIT_FIELDS.filter((f) => !same(before[f], after[f])).map((f) => (f === 'tags' ? { field: f, from: showTags(before[f]), to: showTags(after[f]) } : { field: f, from: show(before[f]), to: show(after[f]) }));
      const commented = [...commentIds(after)].some((c) => !commentIds(before).has(c));
      rows.push({ kind: 'item', id, title, what: commented && !fields.length ? 'commented' : 'changed', changes: fields });
    }
  }
  for (const { key, before, after } of changes.projects ?? []) {
    const title = after.name || key;
    if (!before || before.deleted) rows.push({ kind: 'project', id: key, title, what: after.deleted ? 'deleted' : 'added', changes: [] });
    else if (after.deleted) rows.push({ kind: 'project', id: key, title, what: 'deleted', changes: [] });
    else rows.push({ kind: 'project', id: key, title, what: 'changed', changes: ['name', 'area', 'color', 'description'].filter((f) => !same(before[f], after[f])).map((f) => ({ field: f, from: show(before[f]), to: show(after[f]) })) });
  }
  for (const { part, id, before, after } of changes.records ?? []) {
    const title = part === 'log' ? short(after.text ?? before?.text, 80) : recordTitle(part, after.deleted ? before : after) || id;
    if (!before || before.deleted) rows.push({ kind: 'record', part, id, title, what: 'added', changes: [] });
    else if (after.deleted) rows.push({ kind: 'record', part, id, title, what: 'deleted', changes: [] });
    else {
      const fields = diffPaths(before, after).map((p) => ({ field: p, from: show(getPath(before, p)), to: show(getPath(after, p)) }));
      const commented = [...commentIds(after)].some((c) => !commentIds(before).has(c));
      rows.push({ kind: 'record', part, id, title, what: commented && !fields.length ? 'commented' : 'changed', changes: fields });
    }
  }
  if (changes.now) rows.push({ kind: 'record', part: 'now', id: 'now', title: 'Where it stands', what: 'changed', changes: [{ field: 'headline', from: show(changes.now.before.headline), to: show(changes.now.after.headline) }] });
  return rows;
}

/** The rows in a few lines for the model (with the ids, so it can go on with new items). */
export function rowsText(rows, max = 60) {
  if (!rows.length) return 'Nothing changed (it was already so).';
  const line = (r) => `- ${r.what} ${r.kind === 'record' ? `${r.part} ` : r.kind === 'project' ? 'project ' : ''}${r.kind === 'item' ? `${r.id} ` : r.kind === 'record' && r.part !== 'log' && r.part !== 'now' ? `${r.id} ` : ''}“${r.title}”${r.changes.length ? `: ${r.changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join('; ')}` : ''}`;
  return `${rows.slice(0, max).map(line).join('\n')}${rows.length > max ? `\n… and ${rows.length - max} more` : ''}`;
}
