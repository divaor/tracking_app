// What the tracker asks the model (as in Tracker Editor: a local server or a
// service that answers later): quick add in plain language, help with an item
// or a document, and a plan for the day or a review of the week. Pure, so the
// Node tests can import it; assistant.js talks to the model.
import { addDays, cleanTags, CLAUDE_AUTHOR, compactName, isOverdue, liveComments, PRIORITIES, sortItems, TYPE_IDS } from './model.js';

const PRIORITY_IDS = PRIORITIES.map((p) => p.id);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
};

// ---- Quick add in plain language -----------------------------------------------

/**
 * Messages asking the model to read one quick-add line ("call Ana tomorrow
 * about the invoice, urgent") into an item, as JSON. `projects` and `tags`
 * are the existing ones, so it reuses them instead of inventing new ones.
 */
export function quickAddMessages(input, { today, type = 'task', projects = [], tags = [] }) {
  const system = [
    'You turn a short note into one item for a personal tracker. Reply with ONLY a JSON object, no other text:',
    '{"type": "task" | "idea" | "claude" | "doc", "title": string, "notes": string, "priority": "low" | "normal" | "high" | "urgent", "due": "YYYY-MM-DD" or "", "project": string, "tags": [string]}',
    '- title: short, in the language of the note, without the date, priority or project words.',
    `- type: "${type}" unless the note clearly is something else (an idea, a document to read, work Claude is doing).`,
    `- due: only when the note names a day or date. Today is ${weekday(today)} ${today}; "tomorrow", "Friday", "next week", "mañana", "el viernes" are relative to it.`,
    '- priority: "urgent" or "high" only when the note says so (urgent, ASAP, important, urgente); otherwise "normal".',
    '- project: exactly one of the projects listed, when the note is clearly about it; otherwise "".',
    '- tags: at most 3, reusing the existing tags when they fit; [] when none fit.',
    '- notes: details from the note that are not in the title; otherwise "".',
  ].join('\n');
  const user = `Projects: ${projects.length ? projects.join(', ') : '(none)'}\nExisting tags: ${tags.length ? tags.slice(0, 60).join(', ') : '(none)'}\n\nNote:\n${input}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** The first JSON object in a reply (models sometimes wrap it in a code fence or a sentence). */
function jsonIn(reply) {
  const s = String(reply ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

const validDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(y, m - 1, day);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === day;
};

/**
 * The item fields from the model's reply, checked: a known type and priority,
 * a real date (not long past), one of the existing projects, at most 3 tags
 * (existing spellings kept). Null when the reply has no usable title.
 */
export function parseQuickAddReply(reply, { today, type = 'task', projects = [], tags = [] }) {
  const data = jsonIn(reply);
  const title = String(data?.title ?? '').trim();
  if (!data || !title) return null;
  const fields = { title: title.slice(0, 200), type: TYPE_IDS.includes(data.type) ? data.type : type };
  if (PRIORITY_IDS.includes(data.priority)) fields.priority = data.priority;
  const due = String(data.due ?? '').trim();
  if (validDate(due) && due >= addDays(today, -1)) fields.due = due;
  const project = projects.find((p) => compactName(p) === compactName(data.project ?? ''));
  if (project) fields.project = project;
  const known = new Map(tags.map((t) => [t.toLowerCase(), t]));
  const picked = cleanTags(Array.isArray(data.tags) ? data.tags : []).map((t) => known.get(t.toLowerCase()) ?? t.toLowerCase());
  if (picked.length) fields.tags = picked.slice(0, 3);
  const notes = String(data.notes ?? '').trim();
  if (notes && notes.toLowerCase() !== title.toLowerCase()) fields.notes = notes.slice(0, 2000);
  return fields;
}

/**
 * What to change on an item made by quick add, from the model's reading: the
 * type picked and what was typed with +project #tag !priority @date stay as
 * they are, and the title is only rewritten when the model found something
 * else in it (a date, a priority, a project…), so a plain title stays as typed.
 */
export function refinement(explicit, smart) {
  if (!smart) return {};
  const patch = {};
  if (!explicit.priority && smart.priority && smart.priority !== 'normal') patch.priority = smart.priority;
  if (!explicit.due && smart.due) patch.due = smart.due;
  if (!explicit.project && smart.project) patch.project = smart.project;
  if (!explicit.tags?.length && smart.tags?.length) patch.tags = smart.tags;
  if (smart.notes) patch.notes = smart.notes;
  if (Object.keys(patch).length && smart.title && smart.title !== explicit.title) patch.title = smart.title;
  return patch;
}

// ---- Help with an item or a document ----------------------------------------------

/**
 * What the model can do with an item. `types` says where it shows; `use`
 * says what to do with the answer: 'answer' (read it), 'notes' (add it to the
 * item's notes) or 'feedback' (the review feedback of a document).
 */
export const ITEM_ACTIONS = [
  { id: 'summarize', label: 'Summarize', icon: 'list', types: ['doc', 'claude', 'idea', 'task'], use: 'answer', prompt: 'Summarize it in a few bullet points: what it is, what matters, decisions, numbers and dates.' },
  { id: 'steps', label: 'Break into steps', icon: 'check', types: ['task', 'claude'], use: 'notes', prompt: 'Break it into 3 to 8 concrete next steps, as a Markdown checklist ("- [ ] …"). Reply with only the list, in the language of the item.' },
  { id: 'plan', label: 'Turn into a plan', icon: 'task', types: ['idea'], use: 'notes', prompt: 'Turn this idea into a short plan, in Markdown: the goal in one line, first steps as a checklist ("- [ ] …"), and open questions. In the language of the idea.' },
  { id: 'feedback', label: 'Draft my feedback', icon: 'edit', types: ['doc'], use: 'feedback', prompt: 'Draft my review feedback on this document for its author: what works, what to change, and open questions, as short bullets. Be specific and constructive. Reply with only the feedback.' },
  { id: 'questions', label: 'Questions to ask', icon: 'idea', types: ['doc', 'idea'], use: 'answer', prompt: 'List the questions I should ask (or answer) before deciding on this, most important first.' },
  { id: 'risks', label: 'Risks and gaps', icon: 'alert', types: ['doc', 'idea', 'task', 'claude'], use: 'answer', prompt: 'What could go wrong, and what is missing or unclear? Short bullets, most important first.' },
  { id: 'english', label: 'In English', icon: 'doc', types: ['doc', 'idea', 'task', 'claude'], use: 'answer', prompt: 'Translate it into English. Keep the formatting.' },
  { id: 'spanish', label: 'In Spanish', icon: 'doc', types: ['doc', 'idea', 'task', 'claude'], use: 'answer', prompt: 'Translate it into Spanish. Keep the formatting.' },
];

export const actionsFor = (item) => ITEM_ACTIONS.filter((a) => a.types.includes(item.type));

const MAX_CHARS = 24000;
const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}\n[… cut: ${s.length - max} more characters]` : s);

const COMMENTS_CHARS = 6000;

/** The item's comments (mine and Claude's), the latest ones when they are long. */
function commentsText(item) {
  const lines = [];
  let room = COMMENTS_CHARS;
  for (const c of liveComments(item).reverse()) {
    const line = `- ${c.by === CLAUDE_AUTHOR ? 'Claude' : 'Me'} (${c.at.slice(0, 10)}): ${c.text.trim().replace(/\n+/g, ' / ')}`;
    if (line.length > room) break;
    lines.unshift(line);
    room -= line.length;
  }
  return lines.length ? `\n\nComments, oldest first:\n${lines.join('\n')}` : '';
}

/** The item as the model reads it: its fields, notes, review, comments and its documents' text. */
export function describeItem(item, documents = []) {
  const lines = [`Title: ${item.title}`, `Type: ${item.type}${item.kind ? ` (${item.kind})` : ''}`, `Status: ${item.status}`];
  if (item.priority && item.priority !== 'normal') lines.push(`Priority: ${item.priority}`);
  if (item.due) lines.push(`Due: ${item.due}`);
  if (item.project) lines.push(`Project: ${item.project}`);
  if (item.tags?.length) lines.push(`Tags: ${item.tags.join(', ')}`);
  if (item.url) lines.push(`Link: ${item.url}`);
  let out = lines.join('\n');
  if (item.notes?.trim()) out += `\n\nNotes:\n${item.notes.trim()}`;
  if (item.decision || item.feedback?.trim()) out += `\n\nMy review: ${item.decision || 'no decision yet'}${item.feedback?.trim() ? `\n${item.feedback.trim()}` : ''}`;
  out += commentsText(item);
  let room = MAX_CHARS - out.length;
  for (const d of documents) {
    if (room <= 200) break;
    const body = cut(d.text, room);
    out += `\n\nDocument ${d.name}:\n<<<\n${body}\n>>>`;
    room -= body.length;
  }
  return out;
}

/** The chat messages for an action ({ prompt }) or a question on an item; `history` holds the follow-ups. */
export function itemMessages({ prompt }, item, documents = [], history = []) {
  return [
    { role: 'system', content: 'You help the user with an item from their personal tracker (a task, an idea, work Claude is doing, or a document to review). Be concise and concrete; use Markdown.' },
    { role: 'user', content: `${prompt}\n\n${describeItem(item, documents)}` },
    ...history,
  ];
}

/** Notes with an answer added at the end (a blank line between). */
export const appendToNotes = (notes, answer) => (notes?.trim() ? `${notes.replace(/\s+$/, '')}\n\n${answer.trim()}` : answer.trim());

// ---- A plan for the day, a review of the week ---------------------------------------

const line = (i, today) =>
  `- ${i.title} [${i.type}, ${i.status.replace('_', ' ')}${i.priority !== 'normal' ? `, ${i.priority}` : ''}${i.due ? `, due ${i.due}${isOverdue(i, today) ? ' (overdue)' : ''}` : ''}${i.project ? `, ${i.project}` : ''}]`;

/** The items a plan or review is about, at most `max`, most pressing first. */
export function planItems(items, { kind = 'day', today, max = 40 }) {
  const live = items.filter((i) => !i.deleted);
  if (kind === 'week') {
    const since = addDays(today, -7);
    const done = live.filter((i) => i.status === 'done' && (i.completedAt ?? '').slice(0, 10) >= since);
    const open = sortItems(live.filter((i) => i.status !== 'done'));
    return { done: done.slice(0, max), open: open.slice(0, max) };
  }
  // What is pressing first (in progress, due within two days, high priority, to read), then the rest of the open items.
  const soon = addDays(today, 2);
  const open = live.filter((i) => i.status !== 'done');
  const pressing = (i) => i.status === 'in_progress' || (i.due && i.due <= soon) || ['high', 'urgent'].includes(i.priority) || i.type === 'doc';
  return { done: [], open: [...sortItems(open.filter(pressing)), ...sortItems(open.filter((i) => !pressing(i)))].slice(0, max) };
}

const clock = (iso) => new Date(iso).toTimeString().slice(0, 5);

/**
 * Messages for a plan of the day ('day') or a review of the week ('week'). With `previous` (the
 * plan made earlier today, { text, at }) and `changes` (changesSince it), it asks for that plan updated.
 */
export function planMessages(items, { kind = 'day', today, previous = null, changes = null, boards = '' }) {
  const { done, open } = planItems(items, { kind, today });
  let ask =
    kind === 'week'
      ? 'Write my weekly review: what got done, what is stuck or overdue, and what to focus on next week (at most 5 points). Refer to items by their title.'
      : 'Suggest a realistic plan for today: what to do first and why, in at most 6 bullets. Put overdue and due-today items first, keep in-progress work moving, and say what can wait. Refer to items by their title.';
  if (previous) {
    ask =
      kind === 'week'
        ? 'Update my weekly review below with what changed since it was written: keep what still holds, add what got done or stuck since. At most 5 points. Refer to items by their title.'
        : 'Update my plan for the rest of today with what changed since it was made: mark what got done, keep what still holds, fit in what is new, and say what can wait. At most 6 bullets. Refer to items by their title.';
  }
  const parts = [`Today is ${weekday(today)} ${today}${previous ? `, now ${clock(new Date().toISOString())}` : ''}.`];
  if (previous) {
    parts.push(`The ${kind === 'week' ? 'review' : 'plan'} from ${clock(previous.at)}:\n${previous.text.trim()}`);
    const since = [
      ['Done since then', changes?.done],
      ['Started since then', changes?.started],
      ['Added since then', changes?.added],
      ['Overdue now', changes?.overdue],
    ].filter(([, list]) => list?.length);
    parts.push(since.length ? since.map(([title, list]) => `${title}:\n${list.map((i) => line(i, today)).join('\n')}`).join('\n\n') : 'Nothing changed in the items since then.');
  }
  if (kind === 'week') parts.push(`Done in the last 7 days:\n${done.length ? done.map((i) => line(i, today)).join('\n') : '(nothing)'}`);
  parts.push(`Open items:\n${open.length ? open.map((i) => line(i, today)).join('\n') : '(none)'}`);
  // The release boards' next milestones, what waits on the user there and open decisions (boards.js boardPlanLines).
  if (boards) parts.push(`From my release boards (take their milestones and what waits on me into account):\n${boards}`);
  return [
    { role: 'system', content: 'You help the user plan their work from their personal tracker. Be brief, concrete and kind; use Markdown.' },
    { role: 'user', content: `${ask}\n\n${parts.join('\n\n')}` },
  ];
}
