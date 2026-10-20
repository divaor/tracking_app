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
  'files', 'decision', 'feedback', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'deleted',
];

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
    });
  }
  return out;
}

export function normalizeItem(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = typeof r.id === 'string' && r.id ? r.id : newId();
  const type = TYPE_IDS.includes(r.type) ? r.type : 'task';
  const createdAt = isoOr(r.createdAt, EPOCH);
  const updatedAt = isoOr(r.updatedAt, createdAt);
  if (r.deleted) return { id, type, deleted: true, createdAt, updatedAt };

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
    createdAt,
    updatedAt,
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

export function tombstone(item, now = nowIso()) {
  return { id: item.id, type: item.type, deleted: true, createdAt: item.createdAt, updatedAt: bumpTime(item.updatedAt, now) };
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

export function mergeItems(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const item of list) {
      const current = byId.get(item.id);
      if (!current || wins(item, current)) byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

const TOMBSTONE_DAYS = 180;

export function pruneTombstones(items, now = nowIso(), days = TOMBSTONE_DAYS) {
  const cutoff = new Date(Date.parse(now) - days * 86400000).toISOString();
  return items.filter((i) => !i.deleted || i.updatedAt >= cutoff);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function serializeDocument(items) {
  const sorted = items.map(normalizeItem).sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const updatedAt = sorted.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), EPOCH);
  return `${JSON.stringify({ app: 'tracker', schema: SCHEMA_VERSION, updatedAt, items: sorted }, null, 2)}\n`;
}

export function parseDocument(source) {
  let data;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new Error(`Data file is not valid JSON (${err.message})`);
  }
  const list = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(list)) throw new Error('Data file has no "items" list');
  return list.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id).map(normalizeItem);
}

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

export function matchesQuery(item, query) {
  const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const tags = item.tags.map((t) => t.toLowerCase());
  const haystack = [item.title, item.notes, item.feedback, item.project, item.url, kindLabel(item.type, item.kind), ...item.files.map((f) => f.name)]
    .join('\n')
    .toLowerCase();
  return terms.every((term) => {
    if (term.startsWith('#') && term.length > 1) return tags.some((t) => t.startsWith(term.slice(1)));
    return haystack.includes(term) || tags.some((t) => t.includes(term));
  });
}

export function filterItems(items, { type = 'all', status = 'all', query = '' } = {}) {
  return items.filter(
    (i) =>
      !i.deleted &&
      (type === 'all' || i.type === type) &&
      (status === 'all' || i.status === status) &&
      matchesQuery(i, query),
  );
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

// Parses "Write report #work !high @tomorrow https://…" into item fields.
export function parseQuickAdd(input, today = localDate()) {
  let rest = ` ${text(input)} `;
  const fields = {};
  rest = rest.replace(/\s(https?:\/\/\S+)/i, (_, url) => {
    fields.url = url;
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

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
