// Find by asking in the tracker (2.6): what it searches, as askFind.js's sources, and the run itself.
// Items (their title, notes, feedback, comments, file names and link), the text files attached to them,
// the records of the release boards, and Tracker Editor's files when they are in the same data (D14:
// marked as the editor's, opened there; encrypted ones by name only, never read or sent). Pure, so
// the Node tests can import it; findAsk.js loads the sources and talks to the model.
import { findResults, parseFindPlan, parsePick, pickMessages, plainPlan, planMessages, rankSources, wantsPick } from './askFind.js';
import { liveRecords, recordTitle } from './boards.js';
import { CLAUDE_AUTHOR, isTextAttachment, liveComments, tagCounts, TYPES } from './model.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** What the tracker can search, for the plan (only those that have something are told). */
export const FIND_KINDS = [
  { id: 'item', label: 'items: tasks, ideas, Claude work and documents to read' },
  { id: 'file', label: 'text files attached to items' },
  { id: 'board', label: 'release board records: releases, features, tests, decisions, steps waiting on the person' },
  { id: 'editor', label: 'Tracker Editor files: notes, snippets and drafts' },
];
export const FIND_TYPES = TYPES.map((t) => ({ id: t.id, label: t.plural.toLowerCase() }));

// ---- Items and their files ----

/** An item as a source: everything a person would remember it by. */
export function itemSource(item) {
  const comments = liveComments(item).map((c) => `${c.by === CLAUDE_AUTHOR ? 'Claude' : 'Me'}: ${c.text}`);
  const text = [item.title, item.notes, item.feedback && `Feedback: ${item.feedback}`, ...comments, item.files.length ? `Files: ${item.files.map((f) => f.name).join(', ')}` : '', item.url]
    .filter((s) => str(s).trim())
    .join('\n');
  return {
    id: `i:${item.id}`,
    kind: 'item',
    name: item.title || 'Untitled',
    place: item.project ? `Tracker · ${item.project}` : 'Tracker',
    project: item.project,
    tags: item.tags,
    type: item.type,
    status: item.status,
    date: item.updatedAt,
    text,
    itemId: item.id,
  };
}

/** The text files on items (pictures, PDFs and other documents are never read as text). */
export const textFilesOf = (items) => items.filter((i) => !i.deleted).flatMap((item) => item.files.filter(isTextAttachment).map((file) => ({ item, file })));

/** A text file on an item as a source (`text`: its text, '' when not here). */
export function fileSource(item, file, text = '') {
  return {
    id: `a:${item.id}:${file.path}`,
    kind: 'file',
    name: file.name,
    place: `On “${item.title || 'Untitled'}”`,
    project: item.project,
    tags: item.tags,
    date: file.addedAt || item.updatedAt,
    text,
    itemId: item.id,
    path: file.path,
  };
}

// ---- Release boards ----

const BOARD_KINDS = { releases: 'release', features: 'feature', tests: 'test', decisions: 'decision', events: 'event', actions: 'step waiting' };
// Records that open in the board's drawer (DRAWER_TYPES in ui/releaseBoard.js); the others open the board.
const DRAWER = { releases: 'release', features: 'feature', tests: 'test', decisions: 'decision', events: 'event' };
const SKIP_FIELDS = new Set(['id', 'updatedAt', 'updatedBy', 'deleted', 'by']);

/** A record's words: every text in it (labels, summaries, steps, comments), its stamps aside. */
function recordText(value, out = [], depth = 0) {
  if (depth > 5 || out.length > 400) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => recordText(v, out, depth + 1));
  else if (value && typeof value === 'object') {
    if (value.deleted) return out;
    for (const [k, v] of Object.entries(value)) if (!SKIP_FIELDS.has(k)) recordText(v, out, depth + 1);
  }
  return out;
}

/** The records of a board as sources (`slug`: its file's name). */
export function boardSources(slug, board) {
  const out = [];
  for (const part of Object.keys(BOARD_KINDS)) {
    for (const r of liveRecords(board, part)) {
      out.push({
        id: `b:${slug}:${part}:${r.id}`,
        kind: 'board',
        name: recordTitle(part, r) || r.id,
        place: `${board.project} · release board · ${BOARD_KINDS[part]}`,
        project: board.project,
        tags: [],
        ...(part === 'actions' ? { status: r.done ? 'done' : 'pending' } : {}),
        date: r.updatedAt,
        text: recordText(r).join('\n'),
        slug,
        part,
        recordId: r.id,
        href: DRAWER[part] ? `#/release-board/${slug}/${DRAWER[part]}/${encodeURIComponent(r.id)}` : `#/release-board/${slug}`,
      });
    }
  }
  return out;
}

// ---- Tracker Editor's files (in the same data repo) ----

export const EDITOR_INDEX = 'editor/index.json';
// Files the editor encrypts end to end start with this line: never read here.
export const ENCRYPTED_MARK = 'TRACKER-EDITOR-ENCRYPTED v1';

/** The editor's safeName (the connector's mcp/editor.js has the same): the last part of a file's path. */
export function safeName(name, fallback = 'untitled.txt') {
  const clean = str(name)
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

/** Where the text of an editor file is in the data: editor/files/<id>/<safeName(name)>. */
export const editorTextPath = (record) => `editor/files/${record.id}/${safeName(record.name)}`;

/** The live records of editor/index.json's text, or null when it cannot be read. */
export function parseEditorIndex(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.files)) return null;
  return data.files.filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && f.id && !f.deleted && typeof f.name === 'string');
}

/** Whether an editor file is end-to-end encrypted (by its record, or its text's first line). */
export const editorEncrypted = (record, text = '') => Boolean(record.encrypted) || str(text).startsWith(ENCRYPTED_MARK);

/** An editor file as a source (`text`: its text when read; never for an encrypted one). */
export function editorSource(record, text = '') {
  const encrypted = editorEncrypted(record, text);
  return {
    id: `e:${record.id}`,
    kind: 'editor',
    from: 'editor',
    name: record.name,
    place: record.project ? `Tracker Editor · ${record.project}` : 'Tracker Editor',
    project: str(record.project),
    tags: Array.isArray(record.tags) ? record.tags : [],
    date: record.modifiedAt || record.updatedAt || '',
    text: encrypted ? '' : str(text),
    encrypted,
    // The editor names a tab it has no name for "new 1", "new 2"…
    untitled: /^new \d+$/i.test(str(record.name).trim()),
    editorId: record.id,
  };
}

// ---- What the model is told ----

/**
 * The picture for the plan: today, the projects and tags (items' and the editor's), the kinds there
 * are and the items' types. `editor`: the editor's records (their tags count, never their names).
 */
export function findPicture({ today, items, projects, boards = [], files = 0, editor = [] }) {
  const tags = new Map(tagCounts(items).map((t) => [t.tag.toLowerCase(), t.tag]));
  for (const r of editor) for (const t of Array.isArray(r.tags) ? r.tags : []) if (!tags.has(String(t).toLowerCase())) tags.set(String(t).toLowerCase(), String(t));
  const have = { item: items.length > 0, file: files > 0, board: boards.length > 0, editor: editor.length > 0 };
  return {
    today,
    projects,
    tags: [...tags.values()],
    kinds: FIND_KINDS.filter((k) => have[k.id]),
    types: FIND_TYPES,
    about: `a personal tracker of tasks, ideas, Claude work and documents to read${have.board ? ', with release boards' : ''}${have.editor ? ', and the files of Tracker Editor, the person’s text editor' : ''}`,
  };
}

// ---- The run ----

/**
 * One question, from the plan to the results. `chat(messages, purpose)` asks the model (null: no
 * model, the question's own words are searched); `loadSources(plan)` gives the sources the plan
 * needs. Returns { question, plan, results, encrypted, more, picked } (`picked`: the model chose).
 * `onPhase('planning' | 'searching' | 'picking')` says where it is. A model that fails or answers
 * nonsense never stops the search: its words, then its ranking, stand in.
 */
export async function runFind(question, { picture, loadSources, chat = null, namesOnly = false, now = new Date().toISOString(), onPhase = () => {}, signal } = {}) {
  onPhase('planning');
  let plan = plainPlan(question);
  if (chat) {
    try {
      plan = parseFindPlan(await chat(planMessages(question, picture), 'find-plan'), question, picture);
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
    }
  }
  onPhase('searching');
  const sources = await loadSources(plan);
  const candidates = rankSources(sources, plan, { now });
  let picked = null;
  if (chat && wantsPick(plan, candidates)) {
    onPhase('picking');
    try {
      picked = parsePick(await chat(pickMessages(question, candidates, { namesOnly }), 'find-pick'), candidates);
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
    }
  }
  return { question, plan, ...findResults(candidates, picked, plan), picked: picked !== null };
}
