// Data model: item shape, labels, merging and (de)serialization.
// Pure functions only (no DOM) so they run in Node tests as well as the app.

export const SCHEMA_VERSION = 1;

export const TYPES = [
  { id: 'task', label: 'Task', plural: 'Tasks' },
  { id: 'idea', label: 'Idea', plural: 'Ideas' },
  { id: 'claude', label: 'Claude work', plural: 'Claude work' },
  { id: 'doc', label: 'Document', plural: 'Docs' },
];
export const TYPE_IDS = TYPES.map((t) => t.id);
export const typeInfo = (id) => TYPES.find((t) => t.id === id) ?? TYPES[0];

export const STATUSES = ['pending', 'in_progress', 'done'];
const STATUS_LABELS = { pending: 'Pending', in_progress: 'In progress', done: 'Done' };
const DOC_STATUS_LABELS = { pending: 'To read', in_progress: 'Reading', done: 'Read' };

export function statusLabel(status, type) {
  return (type === 'doc' ? DOC_STATUS_LABELS : STATUS_LABELS)[status] ?? status;
}

export function nextStatus(status) {
  return STATUSES[(STATUSES.indexOf(status) + 1) % STATUSES.length];
}

export const PRIORITIES = [
  { id: 'low', label: 'Low' },
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High' },
  { id: 'urgent', label: 'Urgent' },
];
const PRIORITY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };

export const KINDS = {
  claude: [
    { id: 'code', label: 'Claude Code session' },
    { id: 'chat', label: 'Chat / project' },
    { id: 'pr', label: 'Pull request' },
    { id: 'artifact', label: 'Artifact' },
    { id: 'other', label: 'Other' },
  ],
  doc: [
    { id: 'proposal', label: 'Proposal' },
    { id: 'artifact', label: 'Artifact' },
    { id: 'claude', label: 'Claude doc' },
    { id: 'readme', label: 'README' },
    { id: 'spec', label: 'Spec / plan' },
    { id: 'report', label: 'Report' },
    { id: 'article', label: 'Article / link' },
    { id: 'other', label: 'Other' },
  ],
};

// The user's verdict on something sent for review (proposals, artifacts).
export const DECISIONS = [
  { id: 'approved', label: 'Approved' },
  { id: 'changes', label: 'Changes requested' },
  { id: 'rejected', label: 'Rejected' },
];
const DECISION_IDS = DECISIONS.map((d) => d.id);
export const decisionLabel = (id) => DECISIONS.find((d) => d.id === id)?.label ?? '';

export function kindLabel(type, kind) {
  return KINDS[type]?.find((k) => k.id === kind)?.label ?? '';
}

const EPOCH = '1970-01-01T00:00:00.000Z';
const KNOWN_KEYS = [
  'id', 'type', 'title', 'status', 'priority', 'kind', 'project', 'tags', 'url', 'due', 'notes',
  'files', 'decision', 'feedback', 'comments', 'pinned', 'createdAt', 'updatedAt', 'updatedBy', 'startedAt', 'completedAt', 'deleted',
];

// `updatedBy` value the Claude connector writes; the app writes its device name.
export const CLAUDE_AUTHOR = 'Claude';

export const nowIso = () => new Date().toISOString();

export function newId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}-${rand}`;
}

function isoOr(value, fallback) {
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return fallback;
}

// Returns a timestamp that is never earlier than `now` and always later than
// `previous`, so an edit always wins over the version it was based on even if
// another device's clock ran ahead.
export function bumpTime(previous, now = nowIso()) {
  const prev = Date.parse(previous) || 0;
  return new Date(Math.max(Date.parse(now), prev + 1)).toISOString();
}

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\n]/) : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = text(raw).trim().replace(/^#+/, '').replace(/\s+/g, '-');
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

const cleanDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

// Attached files live in the data repo; items only keep a reference to them.
export function cleanFiles(files) {
  if (!Array.isArray(files)) return [];
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !f.path || seen.has(f.path)) continue;
    seen.add(f.path);
    out.push({
      path: f.path,
      name: text(f.name) || f.path.split('/').pop(),
      size: Number.isFinite(f.size) ? f.size : 0,
      sha: text(f.sha),
      addedAt: isoOr(f.addedAt, ''),
      // Only written when known: the MIME type of a file added in the app, and that it is not text.
      ...(typeof f.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? { type: f.type } : {}),
      ...(f.binary === true ? { binary: true } : {}),
    });
  }
  return out;
}

const commentTime = (c) => c.editedAt || c.at;
function commentWins(a, b) {
  if (commentTime(a) !== commentTime(b)) return commentTime(a) > commentTime(b);
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return Boolean(a.deleted);
  return JSON.stringify(a) > JSON.stringify(b);
}

/**
 * Comments on an item, the person's (`by`: the device) and Claude's, oldest first. One per id,
 * its latest version (`editedAt`, also set when a deleted one comes back; `edited` when its
 * text changed); a deleted one stays as `{ id, by, at, editedAt, deleted }` so a merge with an
 * older copy does not bring it back.
 */
export function cleanComments(comments) {
  if (!Array.isArray(comments)) return [];
  const byId = new Map();
  for (const c of comments) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) continue;
    const at = isoOr(c.at, '');
    if (!at) continue;
    const editedAt = isoOr(c.editedAt, '');
    const comment = c.deleted
      ? { id: c.id, by: text(c.by).trim(), at, editedAt: editedAt || at, deleted: true }
      : { id: c.id, by: text(c.by).trim(), at, text: text(c.text), ...(editedAt ? { editedAt } : {}), ...(c.edited === true ? { edited: true } : {}) };
    const prev = byId.get(c.id);
    if (!prev || commentWins(comment, prev)) byId.set(c.id, comment);
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

export function normalizeItem(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = typeof r.id === 'string' && r.id ? r.id : newId();
  const type = TYPE_IDS.includes(r.type) ? r.type : 'task';
  const createdAt = isoOr(r.createdAt, EPOCH);
  const updatedAt = isoOr(r.updatedAt, createdAt);
  const updatedBy = text(r.updatedBy).trim();
  if (r.deleted) return { id, type, deleted: true, createdAt, updatedAt, updatedBy };

  const item = {
    id,
    type,
    title: text(r.title).trim(),
    status: STATUSES.includes(r.status) ? r.status : 'pending',
    priority: Object.hasOwn(PRIORITY_RANK, r.priority ?? '') ? r.priority : 'normal',
    kind: KINDS[type]?.some((k) => k.id === r.kind) ? r.kind : '',
    project: text(r.project).trim(),
    tags: cleanTags(r.tags),
    url: text(r.url).trim(),
    due: cleanDate(r.due),
    notes: text(r.notes),
    files: cleanFiles(r.files),
    decision: DECISION_IDS.includes(r.decision) ? r.decision : '',
    feedback: text(r.feedback),
    // Only written when there are some, so older data files do not change.
    ...(Array.isArray(r.comments) && r.comments.length ? { comments: cleanComments(r.comments) } : {}),
    // Pinned items come first wherever they show (the filters apply to them as to the rest).
    // Only written when set, so older data files do not change.
    ...(r.pinned === true ? { pinned: true } : {}),
    createdAt,
    updatedAt,
    updatedBy,
    startedAt: isoOr(r.startedAt, ''),
    completedAt: isoOr(r.completedAt, ''),
  };
  // Keep fields written by newer versions of the app so they survive a sync
  // through an older install.
  for (const [key, value] of Object.entries(r)) {
    if (!KNOWN_KEYS.includes(key)) item[key] = value;
  }
  return item;
}

export function createItem(fields = {}, now = nowIso()) {
  const item = normalizeItem({ ...fields, id: newId(), createdAt: now, updatedAt: now, deleted: false });
  if (item.status === 'in_progress') item.startedAt = now;
  if (item.status === 'done') item.completedAt = now;
  return item;
}

export function applyPatch(item, patch, now = nowIso()) {
  const updatedAt = bumpTime(item.updatedAt, now);
  const next = normalizeItem({ ...item, ...patch, id: item.id, createdAt: item.createdAt, updatedAt });
  if ('status' in patch && patch.status !== item.status) {
    if (next.status === 'in_progress' && !next.startedAt) next.startedAt = updatedAt;
    next.completedAt = next.status === 'done' ? updatedAt : '';
  }
  return next;
}

export function tombstone(item, now = nowIso(), updatedBy = '') {
  return { id: item.id, type: item.type, deleted: true, createdAt: item.createdAt, updatedAt: bumpTime(item.updatedAt, now), updatedBy };
}

// Brings back a deleted item (undo) with a timestamp newer than its tombstone.
export function reviveItem(previous, current, now = nowIso()) {
  return normalizeItem({ ...previous, deleted: false, updatedAt: bumpTime(current?.updatedAt ?? previous.updatedAt, now) });
}

// True when `a` should replace `b` (same id). Last write wins; ties are broken
// deterministically so every device converges on the same result.
function wins(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return Boolean(a.deleted);
  return JSON.stringify(a) > JSON.stringify(b);
}

function mergeBy(key, lists, combine = (winner) => winner) {
  const byKey = new Map();
  for (const list of lists) {
    for (const record of list) {
      const current = byKey.get(record[key]);
      if (!current) byKey.set(record[key], record);
      else byKey.set(record[key], combine(wins(record, current) ? record : current, record, current));
    }
  }
  return [...byKey.values()];
}

// The comments of both versions of an item are kept (each at its latest), so a comment written
// on one device is not lost to an edit made meanwhile on another; the rest is last write wins.
function withBothComments(winner, a, b) {
  if (winner.deleted || (!a.comments?.length && !b.comments?.length)) return winner;
  const comments = cleanComments([...(a.comments ?? []), ...(b.comments ?? [])]);
  return JSON.stringify(comments) === JSON.stringify(winner.comments ?? []) ? winner : { ...winner, comments };
}

export const mergeItems = (...lists) => mergeBy('id', lists, withBothComments);

// ---- Comments ------------------------------------------------------------

/** The comments that show (not deleted), oldest first. */
export const liveComments = (item) => (item?.comments ?? []).filter((c) => !c.deleted);

/** Whether the latest comment is the person's: Claude has not answered it yet. */
export function awaitsClaude(item) {
  const last = liveComments(item).at(-1);
  return Boolean(last) && last.by !== CLAUDE_AUTHOR;
}

/** A patch that adds a comment by `by` (a device name, or CLAUDE_AUTHOR), always after the latest one. */
export function addCommentPatch(item, body, by, now = nowIso()) {
  const comments = item.comments ?? [];
  const at = comments.length ? bumpTime(comments.reduce((latest, c) => (c.at > latest ? c.at : latest), ''), now) : now;
  return { comments: [...comments, { id: newId(), by, at, text: text(body).trim() }] };
}

/** A patch that changes a comment's text. */
export function editCommentPatch(item, id, body, now = nowIso()) {
  return { comments: (item.comments ?? []).map((c) => (c.id === id && !c.deleted ? { ...c, text: text(body).trim(), editedAt: bumpTime(commentTime(c), now), edited: true } : c)) };
}

/** A patch that deletes a comment (it stays as a tombstone). */
export function deleteCommentPatch(item, id, now = nowIso()) {
  return {
    comments: (item.comments ?? []).map((c) => (c.id === id && !c.deleted ? { id: c.id, by: c.by, at: c.at, editedAt: bumpTime(commentTime(c), now), deleted: true } : c)),
  };
}

/** A patch that brings back a deleted comment (undo), newer than its tombstone. */
export function restoreCommentPatch(item, comment, now = nowIso()) {
  const current = (item.comments ?? []).find((c) => c.id === comment.id);
  const restored = { ...comment, editedAt: bumpTime(current ? commentTime(current) : commentTime(comment), now) };
  delete restored.deleted;
  return { comments: current ? item.comments.map((c) => (c.id === comment.id ? restored : c)) : [...(item.comments ?? []), restored] };
}

const TOMBSTONE_DAYS = 180;

export function pruneTombstones(items, now = nowIso(), days = TOMBSTONE_DAYS) {
  const cutoff = new Date(Date.parse(now) - days * 86400000).toISOString();
  return items.filter((i) => !i.deleted || i.updatedAt >= cutoff);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const DOCUMENT_KEYS = ['app', 'schema', 'updatedAt', 'projects', 'items'];

/**
 * The data file: items, the project list and any top-level fields written
 * by newer versions (`extra`, kept as-is). Output is stable for clean diffs.
 */
export function serializeDocument(items, projects = [], extra = {}) {
  const sorted = items.map(normalizeItem).sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const sortedProjects = projects.map(normalizeProject).sort((a, b) => cmp(a.key, b.key));
  const updatedAt = [...sorted, ...sortedProjects].reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), EPOCH);
  const rest = Object.fromEntries(Object.entries(extra ?? {}).filter(([k]) => !DOCUMENT_KEYS.includes(k)));
  return `${JSON.stringify({ app: 'tracker', schema: SCHEMA_VERSION, updatedAt, ...rest, projects: sortedProjects, items: sorted }, null, 2)}\n`;
}

export function parseData(source) {
  let data;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new Error(`Data file is not valid JSON (${err.message})`);
  }
  const list = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(list)) throw new Error('Data file has no "items" list');
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  return {
    items: list.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id).map(normalizeItem),
    projects: projects.filter((p) => p && typeof p === 'object' && (p.key || p.name)).map(normalizeProject),
    extra: Array.isArray(data) ? {} : Object.fromEntries(Object.entries(data).filter(([k]) => !DOCUMENT_KEYS.includes(k))),
  };
}

export const parseDocument = (source) => parseData(source).items;

export function diffCounts(before, after) {
  const prev = new Map(before.map((i) => [i.id, i]));
  const counts = { added: 0, updated: 0, deleted: 0 };
  for (const item of after) {
    const old = prev.get(item.id);
    if (!old) {
      if (!item.deleted) counts.added++;
    } else if (old.updatedAt !== item.updatedAt) {
      if (item.deleted && !old.deleted) counts.deleted++;
      else if (!item.deleted) counts.updated++;
    }
  }
  return counts;
}

// ---- Queries -------------------------------------------------------------

// Search ignores case and accents ("cancion" finds "canción"); words are found anywhere,
// "a phrase" in quotes as written, #tag and +project as filters.
const FIELD_GAP = '\u0001'; // between fields, so a phrase never runs from one into the next

/** Text as search compares it: lower case, accents dropped, any space a plain space. */
export const foldSearch = (value) =>
  text(value)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s/g, ' ');

/**
 * `foldSearch` with where each character came from: `start[i]` and `end[i]` are the place
 * in `value` of the character folded text's i-th code unit came from.
 */
export function foldText(value) {
  const source = text(value);
  let folded = '';
  const start = [];
  const end = [];
  for (let i = 0; i < source.length; ) {
    const char = String.fromCodePoint(source.codePointAt(i));
    const piece = foldSearch(char);
    for (let k = 0; k < piece.length; k++) {
      start.push(i);
      end.push(i + char.length);
    }
    folded += piece;
    i += char.length;
  }
  return { text: folded, start, end };
}

/** A search's parts: `words` (folded; a quoted phrase is one), `tags` (#…) and `projects` (+…). */
export function queryTerms(query) {
  const terms = { words: [], tags: [], projects: [] };
  for (const [, phrase, word] of text(query).matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (phrase !== undefined) {
      const folded = foldSearch(phrase).replace(/ +/g, ' ').trim();
      if (folded) terms.words.push(folded);
    } else if (word.length > 1 && word[0] === '#') terms.tags.push(word.slice(1).toLowerCase());
    else if (word.length > 1 && word[0] === '+') terms.projects.push(compactName(word.slice(1)));
    else terms.words.push(foldSearch(word));
  }
  return terms;
}

/** The words to find in an open item: every term as written (#tag too), quoted phrases as one, folded. */
export const findWords = (query) =>
  [...text(query).matchAll(/"([^"]*)"?|(\S+)/g)].map(([, phrase, word]) => foldSearch(phrase ?? word).replace(/ +/g, ' ').trim()).filter(Boolean);

/** What a search looks for in an item's text, without its #tag and +project filters (to find in the open item). */
export const searchWordsOf = (query) =>
  [...text(query).matchAll(/"[^"]*"?|\S+/g)]
    .map(([term]) => term)
    .filter((term) => !(term.length > 1 && (term[0] === '#' || term[0] === '+')))
    .join(' ');

// Each item's text, folded once (items are replaced, never changed, when edited).
const folded = new WeakMap();
function searchTextOf(item) {
  let value = folded.get(item);
  if (value === undefined) {
    // The id too, so an item can be found by the id Claude gives.
    value = foldSearch(
      [item.title, item.notes, item.feedback, item.project, item.url, kindLabel(item.type, item.kind), item.id, ...item.tags, ...item.files.map((f) => f.name), ...liveComments(item).map((c) => c.text)].join(FIELD_GAP),
    );
    folded.set(item, value);
  }
  return value;
}

/** `tags: false` leaves out the query's #tag terms (with `keepPinned`, pinned items show past them). */
export function matchesQuery(item, query, { tags: byTags = true } = {}) {
  const { words, tags, projects } = queryTerms(query);
  if (byTags && tags.length) {
    const own = item.tags.map((t) => t.toLowerCase());
    if (!tags.every((tag) => own.some((t) => t.startsWith(tag)))) return false;
  }
  if (projects.length && !projects.every((p) => compactName(item.project).startsWith(p))) return false;
  return !words.length || words.every((word) => searchTextOf(item).includes(word));
}

/** Where `words` (folded, as `queryTerms` gives them) are in `value`: [start, end] pairs in order, overlaps joined. */
export function matchRanges(value, words) {
  if (!words?.length || !value) return [];
  const { text: haystack, start, end } = foldText(value);
  const found = [];
  for (const word of words) {
    if (!word) continue;
    for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + word.length)) found.push([start[at], end[at + word.length - 1]]);
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const ranges = [];
  for (const range of found) {
    const last = ranges.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([...range]);
  }
  return ranges;
}

// Markdown read as text in a passage: no heading marks, emphasis or code marks, links as their text.
const plainMarkdown = (md) =>
  text(md)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '');

/**
 * For a search result: the passage of the item that matches, when its title alone does not
 * hold every word. `{ where, text, ranges }` (`ranges` in `text`, which may start or end
 * with "…"), or null. The field with the most words wins, the first of equals.
 */
export function matchSnippet(item, query, { size = 120 } = {}) {
  const { words } = queryTerms(query);
  if (!words.length) return null;
  const title = foldSearch(item.title);
  if (words.every((word) => title.includes(word))) return null;
  const fields = [
    ['Notes', plainMarkdown(item.notes)],
    ...liveComments(item).map((c) => [c.by === CLAUDE_AUTHOR ? 'Claude' : 'Comment', plainMarkdown(c.text)]),
    ['Feedback', plainMarkdown(item.feedback)],
    ...item.files.map((f) => ['File', f.name]),
    ['Link', item.url],
  ];
  let best = null;
  for (const [where, value] of fields) {
    if (!value) continue;
    const flat = text(value).replace(/\s+/g, ' ').trim();
    const haystack = foldSearch(flat);
    const hits = words.filter((word) => !title.includes(word) && haystack.includes(word)).length;
    if (hits && (!best || hits > best.hits)) best = { where, flat, hits };
  }
  if (!best) return null;
  const { where, flat } = best;
  const ranges = matchRanges(flat, words);
  // A little before the first match, the rest after it, cut at spaces.
  let from = Math.max(0, ranges[0][0] - Math.round(size * 0.3));
  if (from > 0) from = flat.indexOf(' ', from) + 1 || from;
  if (from > ranges[0][0]) from = ranges[0][0];
  let to = Math.min(flat.length, from + size);
  if (to < flat.length) to = Math.max(flat.lastIndexOf(' ', to), ranges[0][1]);
  // `flat` has single spaces, so the slice starts after one and ends before one.
  const lead = from > 0 ? '…' : '';
  const shift = lead.length - from;
  return {
    where,
    text: `${lead}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`,
    ranges: ranges.filter(([a, b]) => a >= from && b <= to).map(([a, b]) => [a + shift, b + shift]),
  };
}

/**
 * `keepPinned` (the setting `pinnedPastFilters`, off by default): pinned items pass the type,
 * status and #tag filters; a +project term and the words searched for still apply.
 */
export function filterItems(items, { type = 'all', status = 'all', query = '', keepPinned = false } = {}) {
  return items.filter(
    (i) =>
      !i.deleted &&
      ((keepPinned && i.pinned && matchesQuery(i, query, { tags: false })) ||
        ((type === 'all' || i.type === type) && (status === 'all' || i.status === status) && matchesQuery(i, query))),
  );
}

/**
 * Pinned items first, grouped by project (by name; those without one last), each in the
 * order given; then the rest as given.
 */
export function pinnedFirst(items) {
  const pinned = items.filter((i) => i.pinned);
  if (!pinned.length) return items;
  const name = (i) => cleanProjectName(i.project);
  pinned.sort((a, b) => Number(!a.project) - Number(!b.project) || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }));
  return [...pinned, ...items.filter((i) => !i.pinned)];
}

export const SORTS = [
  { id: 'smart', label: 'Smart' },
  { id: 'priority', label: 'Priority' },
  { id: 'due', label: 'Due date' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'created', label: 'Newest first' },
  { id: 'title', label: 'Title' },
];

const STATUS_ORDER = { in_progress: 0, pending: 1, done: 2 };
const byPriority = (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
const byDue = (a, b) => cmp(a.due || '9999-99-99', b.due || '9999-99-99');
const byUpdated = (a, b) => cmp(b.updatedAt, a.updatedAt);
const byCompleted = (a, b) => cmp(b.completedAt || b.updatedAt, a.completedAt || a.updatedAt);

export function compareSmart(a, b) {
  const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (s) return s;
  if (a.status === 'done') return byCompleted(a, b);
  return byPriority(a, b) || byDue(a, b) || byUpdated(a, b);
}

const COMPARATORS = {
  smart: compareSmart,
  priority: (a, b) => byPriority(a, b) || compareSmart(a, b),
  due: (a, b) => byDue(a, b) || compareSmart(a, b),
  updated: byUpdated,
  created: (a, b) => cmp(b.createdAt, a.createdAt),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
};

export function sortItems(items, mode = 'smart') {
  return [...items].sort(COMPARATORS[mode] ?? compareSmart);
}

export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

export const isOverdue = (item, today = localDate()) => item.status !== 'done' && Boolean(item.due) && item.due < today;

export function tagCounts(items) {
  const counts = new Map();
  for (const item of items) {
    if (item.deleted) continue;
    for (const tag of item.tags) {
      const key = tag.toLowerCase();
      const entry = counts.get(key) ?? { tag, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---- Quick add -----------------------------------------------------------

export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last ? `${u.hostname} – ${last}` : u.hostname;
  } catch {
    return url;
  }
}

// Parses "Write report +api #work !high @tomorrow https://…" into item
// fields. `+name` picks the project, matching existing project names loosely.
export function parseQuickAdd(input, today = localDate(), projectNames = []) {
  let rest = ` ${text(input)} `;
  const fields = {};
  rest = rest.replace(/\s(https?:\/\/\S+)/i, (_, url) => {
    fields.url = url;
    return ' ';
  });
  rest = rest.replace(/\s\+([\p{L}\p{N}_\-./]+)/u, (_, name) => {
    fields.project = projectNames.find((p) => compactName(p) === compactName(name)) ?? name;
    return ' ';
  });
  const tags = [];
  rest = rest.replace(/\s#([\p{L}\p{N}_\-/.]+)/gu, (_, tag) => {
    tags.push(tag);
    return ' ';
  });
  if (tags.length) fields.tags = tags;
  rest = rest.replace(/\s!(low|normal|high|urgent)(?=\s)/i, (_, p) => {
    fields.priority = p.toLowerCase();
    return ' ';
  });
  rest = rest.replace(/\s(!{1,2})(?=\s)/, (_, bangs) => {
    fields.priority = bangs.length === 2 ? 'urgent' : 'high';
    return ' ';
  });
  rest = rest.replace(/\s@(today|tomorrow|\d{4}-\d{2}-\d{2})(?=\s)/i, (_, when) => {
    const w = when.toLowerCase();
    fields.due = w === 'today' ? today : w === 'tomorrow' ? addDays(today, 1) : w;
    return ' ';
  });
  fields.title = rest.replace(/\s+/g, ' ').trim();
  if (!fields.title && fields.url) fields.title = titleFromUrl(fields.url);
  return fields;
}

// ---- Markdown checklists -------------------------------------------------

const TASK_LINE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;
const FENCE = /^\s*(```|~~~)/;

function eachTaskLine(markdown, fn) {
  const lines = text(markdown).split('\n');
  let fence = null;
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = TASK_LINE.exec(lines[i]);
    if (m && fn(m, i, lines, index++) === false) break;
  }
  return lines;
}

export function checklistProgress(markdown) {
  let done = 0;
  let total = 0;
  eachTaskLine(markdown, (m) => {
    total++;
    if (m[2] !== ' ') done++;
  });
  return { done, total };
}

export function toggleChecklistItem(markdown, target) {
  let changed = false;
  const lines = eachTaskLine(markdown, (m, i, all, index) => {
    if (index !== target) return true;
    all[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${all[i].slice(m[0].length)}`;
    changed = true;
    return false;
  });
  return changed ? lines.join('\n') : markdown;
}

export function titleFromMarkdown(markdown, fallback = '') {
  const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text(markdown));
  return m ? m[1].trim() : fallback;
}

// ---- Projects --------------------------------------------------------------

// Projects group items (one project per item); each can belong to an area so
// work and personal things can be filtered apart. Items reference a project
// by name, matched case-insensitively.
export const AREAS = [
  { id: 'work', label: 'Work' },
  { id: 'personal', label: 'Personal' },
];
const AREA_IDS = AREAS.map((a) => a.id);
export const areaLabel = (id) => AREAS.find((a) => a.id === id)?.label ?? '';

export const PROJECT_COLORS = ['#4f46e5', '#2f6fd6', '#0e8a8a', '#23845f', '#7a8a1f', '#b7791f', '#c2603c', '#c23b6b', '#8b4fd6', '#5f6b7a'];

export const cleanProjectName = (name) => text(name).trim().replace(/\s+/g, ' ');
export const projectKey = (name) => cleanProjectName(name).toLowerCase();
// Loose form used to match "+api-platform" with "API Platform".
export const compactName = (name) => text(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function defaultProjectColor(key) {
  let hash = 0;
  for (const ch of text(key)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

const PROJECT_KEYS = ['key', 'name', 'area', 'color', 'description', 'createdAt', 'updatedAt', 'updatedBy', 'deleted'];

export function normalizeProject(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const name = cleanProjectName(r.name) || cleanProjectName(r.key);
  const key = projectKey(r.key || name);
  const createdAt = isoOr(r.createdAt, EPOCH);
  const updatedAt = isoOr(r.updatedAt, createdAt);
  const updatedBy = text(r.updatedBy).trim();
  if (r.deleted) return { key, name, deleted: true, createdAt, updatedAt, updatedBy };
  const project = {
    key,
    name,
    area: AREA_IDS.includes(r.area) ? r.area : '',
    color: /^#[0-9a-f]{6}$/i.test(text(r.color)) ? r.color.toLowerCase() : '',
    description: text(r.description),
    createdAt,
    updatedAt,
    updatedBy,
  };
  for (const [k, v] of Object.entries(r)) if (!PROJECT_KEYS.includes(k)) project[k] = v;
  return project;
}

export const mergeProjects = (...lists) => mergeBy('key', lists);

/** Creates or updates the project record for `name`. */
export function upsertProjectRecord(projects, name, patch = {}, now = nowIso(), updatedBy = '') {
  const key = projectKey(name);
  const current = projects.find((p) => p.key === key);
  const base = current && !current.deleted ? current : { createdAt: now, area: '', color: '', description: '' };
  const next = normalizeProject({
    ...base,
    ...patch,
    key,
    // Keep the existing spelling unless a new one is given explicitly.
    name: cleanProjectName(patch.name ?? (current && !current.deleted ? current.name : name)),
    deleted: false,
    updatedAt: bumpTime(current?.updatedAt ?? '', now),
    updatedBy,
  });
  return current ? projects.map((p) => (p.key === key ? next : p)) : [...projects, next];
}

export function deleteProjectRecord(projects, name, now = nowIso(), updatedBy = '') {
  const key = projectKey(name);
  const current = projects.find((p) => p.key === key);
  const dead = { key, name: current?.name ?? cleanProjectName(name), deleted: true, createdAt: current?.createdAt ?? now, updatedAt: bumpTime(current?.updatedAt ?? '', now), updatedBy };
  return current ? projects.map((p) => (p.key === key ? dead : p)) : [...projects, dead];
}

/**
 * Every project in use or registered, with counts (open, total, pinned): registry entries plus
 * project names found on items. Sorted by area (work, personal, none), then name.
 */
export function projectList(items, projects = []) {
  const byKey = new Map();
  for (const p of projects) if (!p.deleted) byKey.set(p.key, { ...p, open: 0, total: 0, pinned: 0, registered: true });
  for (const item of items) {
    if (item.deleted || !item.project) continue;
    const key = projectKey(item.project);
    if (!byKey.has(key)) byKey.set(key, { key, name: cleanProjectName(item.project), area: '', color: '', description: '', open: 0, total: 0, pinned: 0, registered: false });
    const entry = byKey.get(key);
    entry.total++;
    if (item.status !== 'done') entry.open++;
    if (item.pinned) entry.pinned++;
  }
  const areaRank = (a) => (a === 'work' ? 0 : a === 'personal' ? 1 : 2);
  return [...byKey.values()]
    .map((p) => ({ ...p, color: p.color || defaultProjectColor(p.key) }))
    .sort((a, b) => areaRank(a.area) - areaRank(b.area) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Renames a project (merging into another when the new name exists) and moves
 * its items along. Returns the new { items, projects }.
 */
export function renameProjectIn({ items, projects }, from, to, now = nowIso(), updatedBy = '') {
  const fromKey = projectKey(from);
  const toKey = projectKey(to);
  if (!toKey) return { items, projects };
  if (fromKey === toKey) return { items, projects: upsertProjectRecord(projects, from, { name: to }, now, updatedBy) };
  const old = projects.find((p) => p.key === fromKey && !p.deleted);
  const target = projects.find((p) => p.key === toKey && !p.deleted);
  const carried = target ? {} : { area: old?.area ?? '', color: old?.color ?? '', description: old?.description ?? '' };
  const nextProjects = deleteProjectRecord(upsertProjectRecord(projects, to, carried, now, updatedBy), from, now, updatedBy);
  const name = nextProjects.find((p) => p.key === toKey).name;
  return {
    items: items.map((i) => (!i.deleted && projectKey(i.project) === fromKey ? applyPatch(i, { project: name, updatedBy }, now) : i)),
    projects: nextProjects,
  };
}

/** Deletes a project; its items stay, without a project. */
export function deleteProjectIn({ items, projects }, name, now = nowIso(), updatedBy = '') {
  const key = projectKey(name);
  return {
    items: items.map((i) => (!i.deleted && projectKey(i.project) === key ? applyPatch(i, { project: '', updatedBy }, now) : i)),
    projects: deleteProjectRecord(projects, name, now, updatedBy),
  };
}

/** Canonical spelling for a project name: an existing project's, else as typed. */
export function resolveProjectName(name, known) {
  const key = projectKey(name);
  if (!key) return '';
  for (const p of known) {
    const candidate = typeof p === 'string' ? p : p.name;
    if (projectKey(candidate) === key) return cleanProjectName(candidate);
  }
  return cleanProjectName(name);
}

/**
 * Project scope: a list of selections, any of which may match.
 * 'area:work' | 'area:personal' | 'project:<key>' | 'none' (no project).
 * An empty scope matches everything.
 */
export function matchesScope(item, scope, projectsByKey = new Map()) {
  if (!scope?.length) return true;
  const key = projectKey(item.project);
  return scope.some((s) => {
    if (s === 'none') return !key;
    if (s.startsWith('area:')) return Boolean(key) && projectsByKey.get(key)?.area === s.slice(5);
    if (s.startsWith('project:')) return s.slice(8) === key;
    return false;
  });
}

// ---- Tags ----------------------------------------------------------------

/** Items with `from` renamed to `to` (merging into an existing tag), or removed when `to` is empty. */
export function retagItems(items, from, to, now = nowIso(), updatedBy = '') {
  const fromKey = text(from).toLowerCase();
  return items.map((item) => {
    if (item.deleted || !item.tags.some((t) => t.toLowerCase() === fromKey)) return item;
    const tags = cleanTags(item.tags.map((t) => (t.toLowerCase() === fromKey ? to : t)).filter(Boolean));
    return applyPatch(item, { tags, updatedBy }, now);
  });
}

// ---- Files ---------------------------------------------------------------

export function slugify(value, max = 48) {
  const slug = text(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'item';
}

// A file name that is safe as a single path segment in the repo.
export function safeFileName(name, fallback = 'document.md') {
  const base = text(name).split(/[\\/]/).pop().trim();
  const cleaned = base.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').replace(/^\.+/, '').slice(0, 96);
  return cleaned && /[^.]/.test(cleaned) ? cleaned : fallback;
}

const EXTENSIONS = {
  markdown: ['md', 'markdown', 'mdx'],
  html: ['html', 'htm'],
  svg: ['svg'],
};

export function fileKind(name) {
  const ext = text(name).split('.').pop().toLowerCase();
  for (const [kind, list] of Object.entries(EXTENSIONS)) if (list.includes(ext)) return kind;
  return 'text';
}

// What an attachment is, by its name's extension (pictures, PDFs, documents… are not text);
// `binary` on the record marks a file whose name says text but whose bytes are not.
const ATTACHMENT_KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif', 'tif', 'tiff'],
  pdf: ['pdf'],
  document: ['docx', 'doc', 'docm', 'dotx', 'xlsx', 'xls', 'xlsm', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'epub', 'fb2', 'pages', 'numbers', 'key'],
  media: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp'],
  archive: ['zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'zst'],
  binary: ['exe', 'dll', 'msi', 'apk', 'aab', 'dmg', 'iso', 'bin', 'so', 'jar', 'class', 'psd', 'ai', 'sketch', 'fig', 'ttf', 'otf', 'woff', 'woff2', 'db', 'sqlite', 'pyc', 'o'],
};
const extensionOf = (name) => (/\.([^./\\]+)$/.exec(text(name))?.[1] ?? '').toLowerCase();

/** 'image', 'pdf', 'document', 'media', 'archive', 'binary' or 'text'. */
export function attachmentKind(file) {
  const ext = extensionOf(file?.name || file?.path);
  for (const [kind, list] of Object.entries(ATTACHMENT_KINDS)) if (list.includes(ext)) return kind;
  return file?.binary ? 'binary' : 'text';
}

/** Whether an attachment is text: read in the item, edited in the editor (an SVG picture is text too). */
export const isTextAttachment = (file) => attachmentKind(file) === 'text' || extensionOf(file?.name || file?.path) === 'svg';

const MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf', epub: 'application/epub+zip', zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'application/xml',
};

/** The MIME type of an attachment: the one recorded, else by its extension (text/plain for other text). */
export const mimeOf = (file) => file?.type || MIME_TYPES[extensionOf(file?.name || file?.path)] || (attachmentKind(file) === 'text' ? 'text/plain' : 'application/octet-stream');

/** The folder of an item's files in the data repo: where it has some, else files/<day>-<title>-<end of id> (as the connector makes it). */
export function filesFolder(item, dir = 'files', today = new Date().toISOString().slice(0, 10)) {
  const own = item.files?.find((f) => f.path.startsWith(`${dir}/`) && f.path.split('/').length === 3);
  return own ? own.path.split('/').slice(0, -1).join('/') : `${dir}/${today}-${slugify(item.title)}-${item.id.slice(-6)}`;
}

/** A path in `folder` for a file named `name` that none of `taken` has ("photo.jpg", then "photo-2.jpg"). */
export function freeFilePath(folder, name, taken) {
  const safe = safeFileName(name, 'file');
  const dot = safe.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
  for (let n = 1; ; n++) {
    const p = `${folder}/${n === 1 ? safe : `${stem}-${n}${ext}`}`;
    if (!taken.has(p)) return p;
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
