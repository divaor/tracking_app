// The assistant's chats kept on this device (pure; as Tracker Editor's chats.js, for one panel):
// each chat is { id, title, named, createdAt, updatedAt, saved, link, turns, preview, state },
// `state` the panel's own ({ explainOnly, turns: the cards as shown, history: the model's
// messages }), `link` what it was about ({ project, item: { id, title } } from the item open, or
// the project the screen shows). The list (`chatRow`s, newest first) is kept apart from the
// chats. Nothing here is synced.
import { foldSearch } from './model.js';

/** The newest this many are kept; saved ones always, whatever their number. */
export const MAX_CHATS = 300;
/** A chat's stored size (its texts, in characters): older messages are shortened past it. */
export const MAX_CHAT_CHARS = 1_000_000;
export const TITLE_CHARS = 80;
const PREVIEW_CHARS = 140;
const CUT_KEEP = 1500;

/** The list's filters: all, the open item's or project's, the saved ones. */
export const CHAT_FILTERS = [
  { id: 'here', label: 'This item' },
  { id: 'project', label: 'This project' },
  { id: 'all', label: 'All' },
  { id: 'saved', label: 'Saved' },
];

export const newChatId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** A chat's title: its first question. */
export const chatTitle = (question) => clip(oneLine(question), TITLE_CHARS) || 'New chat';

/** The last answer's first words, for the list. */
export function chatPreview(text) {
  const plain = oneLine(String(text ?? '').replace(/```[\s\S]*?(```|$)/g, ' [steps] ').replace(/[#*_>`|]/g, ' '));
  return clip(plain, PREVIEW_CHARS);
}

/** What a chat is about, from what the panel saw when it began (the item open, else the screen's project). */
export function chatLink({ open = null, project = '' } = {}) {
  if (open?.id) return { project: open.project || '', item: { id: open.id, title: clip(oneLine(open.title), 120) } };
  return project ? { project, item: null } : null;
}

/** "Item title · Project", "Project", or '' — what a chat is about, in a few words. */
export function linkLabel(link) {
  if (!link) return '';
  const item = link.item?.title ?? '';
  if (item && link.project) return `${item} · ${link.project}`;
  return item || link.project || '';
}

/** A chat's row in the list (no `state`). */
export function chatRow(chat) {
  return {
    id: chat.id,
    title: chat.title || 'New chat',
    named: Boolean(chat.named),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    saved: Boolean(chat.saved),
    link: chat.link ?? null,
    turns: chat.turns ?? 0,
    preview: chat.preview ?? '',
  };
}

const newestFirst = (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));

/** The list with `row` in it (replacing its old one), newest first. */
export const withRow = (index, row) => [row, ...(index ?? []).filter((r) => r.id !== row.id)].sort(newestFirst);

/** The list cut to `max` chats: saved ones always stay, then the newest others; `dropped` went. */
export function pruneIndex(index, max = MAX_CHATS) {
  const sorted = [...(index ?? [])].sort(newestFirst);
  let room = Math.max(0, max - sorted.filter((r) => r.saved).length);
  const keep = [];
  const dropped = [];
  for (const r of sorted) {
    if (r.saved) keep.push(r);
    else if (room > 0) {
      keep.push(r);
      room -= 1;
    } else dropped.push(r.id);
  }
  return { index: keep, dropped };
}

const sameProject = (a, b) => Boolean(a && b) && foldSearch(a) === foldSearch(b);

/**
 * The rows the list shows: `show` 'here' (about the item `itemId`), 'project' (about `project`:
 * the project itself or one of its items), 'all', 'saved'; `query`: words in the title, the
 * last answer, the item and the project.
 */
export function filterChats(index, { show = 'all', itemId = null, project = '', query = '' } = {}) {
  const words = foldSearch(query).split(' ').filter(Boolean);
  return (index ?? []).filter((r) => {
    if (show === 'here' && (!itemId || r.link?.item?.id !== itemId)) return false;
    if (show === 'project' && !sameProject(r.link?.project, project)) return false;
    if (show === 'saved' && !r.saved) return false;
    if (!words.length) return true;
    const hay = foldSearch([r.title, r.preview, r.link?.item?.title, r.link?.project].filter(Boolean).join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/** How many rows each filter has (the chips' numbers). */
export const filterCounts = (index, here = {}) => Object.fromEntries(CHAT_FILTERS.map((f) => [f.id, filterChats(index, { ...here, show: f.id }).length]));

/**
 * The model's messages of a long chat ({ role, content }) within `budget` characters: the
 * oldest are shortened first (their start kept), the newest `keepLast` never.
 */
export function fitMessages(messages, budget, { keepLast = 4 } = {}) {
  const out = (messages ?? []).map((m) => ({ ...m }));
  let total = out.reduce((n, m) => n + String(m.content ?? '').length, 0);
  for (let i = 0; i < out.length - keepLast && total > budget; i++) {
    const text = String(out[i].content ?? '');
    if (text.length <= CUT_KEEP + 200) continue;
    const cut = `${text.slice(0, CUT_KEEP)}\n[… ${text.length - CUT_KEEP} characters of an earlier part of this chat left out]`;
    total -= text.length - cut.length;
    out[i].content = cut;
  }
  return out;
}

/** How much of a chat goes again with a follow-up, by where the model runs (a model on this computer has a small context). */
export const historyBudget = (connection) => (connection === 'local' ? 24_000 : 240_000);

export const chatChars = (chat) => JSON.stringify(chat ?? null).length;

/** A chat small enough to keep: its model messages shortened (oldest first) while it is over `max`. */
export function shrinkChat(chat, max = MAX_CHAT_CHARS) {
  if (chatChars(chat) <= max || !Array.isArray(chat.state?.history)) return chat;
  return { ...chat, state: { ...chat.state, history: fitMessages(chat.state.history, Math.floor(max / 2), { keepLast: 2 }) } };
}

/**
 * The cards of a chat taken up again: what was waiting or running did not happen ('stopped');
 * Undo stays (it puts back field by field what the step wrote, and leaves what changed since).
 */
export function settledTurns(turns) {
  const open = new Set(['waiting', 'pending', 'running']);
  return (turns ?? []).map((t) => ({ ...t, parts: (t.parts ?? []).map((p) => (p?.steps ? { steps: p.steps.map((s) => (open.has(s.status) ? { ...s, status: 'stopped' } : s)) } : p)) }));
}
