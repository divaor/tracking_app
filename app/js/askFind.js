// Find by asking (Tracker Editor 0.40, Tracker 2.6): a question in the search box ("the file where I
// copied a docker command", "tasks about the kitchen due this week") becomes a search plan by the model
// (planMessages → parseFindPlan), the app searches its own data with it (measure → rankMeasured: rare
// words count more; phrases, patterns and names more than single words; filters must match; recency
// breaks ties or leads), and the model picks the best from snippets (pickMessages → parsePick).
//
// The same file in both apps (keep them in step, and their test/ask-find.test.js). Pure, and without
// Unicode property escapes or Intl: the editor's main process runs it on the phone, whose Node.js has
// no ICU.
// Encrypted sources are matched by name only and never go to the model, not even their names.

// Letters and digits of the main scripts (search.js's WORD_RANGES): word edges for short terms.
const WORD = 'A-Za-z0-9\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02C1\\u0370-\\u03FF\\u0400-\\u0481\\u048A-\\u052F\\u0531-\\u0556\\u05D0-\\u05EA\\u0620-\\u064A\\u0660-\\u0669\\u0904-\\u0939\\u0966-\\u096F\\u0E01-\\u0E30\\u1E00-\\u1FBC\\u3041-\\u3096\\u30A1-\\u30FA\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7A3';
const WORD_CHAR = new RegExp(`[${WORD}_]`);
const WORDS = new RegExp(`[${WORD}]+`, 'g');

export const MAX_TERMS = 12;
export const MAX_PATTERNS = 3;
export const MAX_CANDIDATES = 30;
// A plain listing ("the files of Deep Time") shows up to this many.
export const MAX_LISTED = 200;
export const MAX_PICKS = 15;
// What one source's text may be at most when it is measured (the rest is not read).
export const MAX_TEXT = 1_000_000;
const LINES_PER_SOURCE = 3;
const LINE_CHARS = 160;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Accents dropped where the engine can (a Node.js without ICU leaves them, and still finds plain words).
const DECOMPOSES = (() => {
  try {
    return 'é'.normalize('NFD').length === 2;
  } catch {
    return false;
  }
})();
/** Lower case without accents, for matching. */
export const fold = (s) => {
  const lower = str(s).toLowerCase();
  return DECOMPOSES ? lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : lower;
};

export const realDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(d))) return false;
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, day));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === day;
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (day) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? '';

const STOP = new Set(
  'the a an and or of to in on at for with from by is are was were be been it its this that these those my me i you your our their there here what which who whom where when how why do does did can could would should will shall may might have has had not no all any some show give find get list open files file notes note items item something thing things about please one ones el la los las un una unos unas y o de del en con por para que donde cual cuales como mis mi tus tu me lo le les se es son fue era archivo archivos nota notas'.split(' '),
);

/** The words of a question that say something (no "the", "show me", "files"…), for a plan without the model. */
export function questionWords(question) {
  return [...new Set((fold(question).match(WORDS) ?? []).filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, MAX_TERMS);
}

// ---- Patterns: a regular expression from the model, only when it cannot run away ----

/**
 * Whether a pattern from the model is safe to run over a whole file: short, no back references or
 * look-arounds, no Unicode property classes, and no quantified group that holds a quantifier ("(a+)+", the kind that
 * takes forever), and it compiles. Returns '' when fine, else what is wrong.
 */
export function patternProblem(p) {
  if (typeof p !== 'string' || !p.length) return 'empty';
  if (p.length > 160) return 'too long';
  if (/\\[1-9]|\\k</.test(p)) return 'back references';
  if (/\(\?<?[=!]/.test(p)) return 'look-arounds';
  if (/\\[pP]\{/.test(p)) return 'Unicode classes';
  // Groups: does a quantified group hold a quantifier?
  const stack = [];
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') stack.push(false);
    else if (c === ')') {
      const quantifiedInside = stack.pop();
      if (quantifiedInside === undefined) return 'unbalanced';
      const next = p[i + 1];
      const quantifiedAfter = next === '*' || next === '+' || (next === '{' && /^\{\d*,?\d*\}/.test(p.slice(i + 1)));
      if (quantifiedInside && quantifiedAfter) return 'nested repeats';
      if (stack.length && (quantifiedInside || quantifiedAfter)) stack[stack.length - 1] = true;
    } else if ((c === '*' || c === '+' || c === '{') && stack.length) stack[stack.length - 1] = true;
  }
  if (stack.length) return 'unbalanced';
  try {
    new RegExp(p, 'i');
  } catch {
    return 'not a valid pattern';
  }
  return '';
}

// ---- The plan ----

const PLAN_SYSTEM = `You turn a question about the person's own notes, files and tracker into a search plan for their app, which searches its own data with it. Reply with ONLY a JSON object, no other text:
{"intent": "find" | "list", "terms": [string], "patterns": [string], "names": [string], "projects": [string], "tags": [string], "kinds": [string], "types": [string], "status": "open" | "done" | "all", "since": "YYYY-MM-DD" | "", "until": "YYYY-MM-DD" | "", "sort": "relevance" | "recent" | "oldest", "encrypted": false, "untitled": false, "limit": 20}
- intent: "list" when the question only filters (a project's files, a kind, a time, encrypted files, notes with no name) and nothing has to be read to answer; "find" when it is about what they say.
- terms: 3 to 12 words or short phrases the wanted text would contain: the question's own, synonyms, other forms (singular, plural) and the other languages the person writes in; for a command, the command's words ("docker compose", "docker run"). [] for intent "list".
- patterns: at most 3 simple regular expressions (JavaScript, no look-arounds) for things with a shape: commands, SQL, URLs, keys, error codes, dates. Often [].
- names: words that would be in the file's name or the item's title.
- projects, tags, kinds, types: only values from the lists given, spelled as given; [] when the question does not narrow it.
- status: for items: "open" (not done), "done" or "all".
- since / until: dates when the question gives a time ("last month", "yesterday", "this week"), worked out from today; else "".
- sort: "recent" for the latest or last one, "oldest" for the first; else "relevance".
- encrypted: true only when the question asks for encrypted, password, secret or key files.
- untitled: true only when it asks for notes that have no name.`;

/**
 * The messages asking the model for a plan. `picture`: { today, projects: [names], tags: [names],
 * kinds: [{ id, label }], types: [{ id, label }] (items' types), folders: [names], about: a line on
 * what the app holds }.
 */
export function planMessages(question, picture = {}) {
  const list = (values, max) => (values?.length ? values.slice(0, max).join(', ') + (values.length > max ? `, and ${values.length - max} more` : '') : '(none)');
  const lines = [
    `Question: ${str(question).trim()}`,
    '',
    picture.about ? `The app holds: ${picture.about}` : '',
    picture.today ? `Today: ${weekday(picture.today)} ${picture.today}` : '',
    `Kinds: ${picture.kinds?.length ? picture.kinds.map((k) => `${k.id} (${k.label})`).join('; ') : '(any)'}`,
    picture.types?.length ? `Types: ${picture.types.map((t) => `${t.id} (${t.label})`).join('; ')}` : '',
    `Projects: ${list(picture.projects, 120)}`,
    `Tags: ${list(picture.tags, 150)}`,
    picture.folders?.length ? `Folders: ${list(picture.folders, 40)}` : '',
  ].filter((l, i) => l || i === 1);
  return [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** The first JSON object in a reply (models wrap it in fences or sentences). */
function jsonIn(reply) {
  const s = str(reply);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const data = JSON.parse(s.slice(start, end + 1));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

const textList = (v, { max, len = 60 }) => {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const t = str(raw).trim().replace(/\s+/g, ' ');
    const key = fold(t);
    if (!t || t.length > len || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
};
// A name as the lists spell it: the same letters and digits, case and spaces aside.
const compact = (s) => fold(s).replace(/[^a-z0-9\u00c0-\uffff]+/g, '');
const known = (values, list) => {
  const byKey = new Map((list ?? []).map((x) => [compact(x), x]));
  return [...new Set((Array.isArray(values) ? values : []).map((v) => byKey.get(compact(v))).filter(Boolean))];
};

/** A plan from the question's own words, when there is no model (or its plan was no use). */
export function plainPlan(question) {
  return { intent: 'find', terms: questionWords(question), patterns: [], names: [], projects: [], tags: [], kinds: [], types: [], status: 'all', since: '', until: '', sort: 'relevance', encrypted: false, untitled: false, limit: 20, plain: true };
}

/**
 * The model's plan, checked against what exists (`picture`, as for planMessages): projects, tags,
 * kinds and types only from the lists (their spelling), terms and names short, patterns safe, dates
 * real. Falls back to the question's words when the reply is no use or gives nothing to search by.
 */
export function parseFindPlan(reply, question, picture = {}) {
  const data = jsonIn(reply);
  if (!data) return plainPlan(question);
  const kindIds = (picture.kinds ?? []).map((k) => k.id);
  const typeIds = (picture.types ?? []).map((t) => t.id);
  const plan = {
    intent: data.intent === 'list' ? 'list' : 'find',
    terms: textList(data.terms, { max: MAX_TERMS }),
    patterns: (Array.isArray(data.patterns) ? data.patterns : []).filter((p) => !patternProblem(p)).slice(0, MAX_PATTERNS),
    names: textList(data.names, { max: 6, len: 80 }),
    projects: known(data.projects, picture.projects),
    tags: known(data.tags, picture.tags),
    kinds: (Array.isArray(data.kinds) ? data.kinds : []).filter((k) => kindIds.includes(k)),
    types: (Array.isArray(data.types) ? data.types : []).filter((t) => typeIds.includes(t)),
    status: ['open', 'done', 'all'].includes(data.status) ? data.status : 'all',
    since: realDate(data.since) ? data.since : '',
    until: realDate(data.until) ? data.until : '',
    sort: ['recent', 'oldest'].includes(data.sort) ? data.sort : 'relevance',
    encrypted: data.encrypted === true,
    untitled: data.untitled === true,
    limit: Math.min(Math.max(Number.isInteger(data.limit) ? data.limit : 20, 1), 50),
  };
  if (plan.since && plan.until && plan.since > plan.until) [plan.since, plan.until] = [plan.until, plan.since];
  const filters = plan.projects.length || plan.tags.length || plan.kinds.length || plan.types.length || plan.since || plan.until || plan.encrypted || plan.untitled || plan.status !== 'all';
  if (plan.intent === 'find' && !plan.terms.length && !plan.patterns.length && !plan.names.length) {
    if (filters) plan.intent = 'list';
    else return plainPlan(question);
  }
  return plan;
}

/** The plan in a few words, for the results' heading ("docker, docker compose · in Deep Time · since 2026-10-01"). */
export function planWords(plan) {
  const bits = [];
  if (plan.encrypted) bits.push('encrypted');
  if (plan.untitled) bits.push('no name');
  const words = [...plan.terms, ...plan.names];
  if (words.length) bits.push(words.slice(0, 5).join(', ') + (words.length > 5 ? '…' : ''));
  if (plan.patterns.length) bits.push(`${plan.patterns.length} pattern${plan.patterns.length === 1 ? '' : 's'}`);
  if (plan.projects.length) bits.push(`in ${plan.projects.join(', ')}`);
  if (plan.tags.length) bits.push(plan.tags.map((t) => `#${t}`).join(' '));
  if (plan.kinds.length) bits.push(plan.kinds.join(', '));
  if (plan.types.length) bits.push(plan.types.join(', '));
  if (plan.status !== 'all') bits.push(plan.status);
  if (plan.since) bits.push(`since ${plan.since}`);
  if (plan.until) bits.push(`until ${plan.until}`);
  if (plan.sort !== 'relevance') bits.push(plan.sort === 'recent' ? 'newest first' : 'oldest first');
  return bits.join(' · ');
}

// ---- Searching here ----

/**
 * A source, as both apps give them: { id, kind, name, place, project, tags, type, status, date (ISO),
 * text, encrypted, untitled, from }. Encrypted ones have no text (or it is never read).
 */
function passes(source, plan) {
  if (plan.kinds.length && !plan.kinds.includes(source.kind)) return false;
  if (plan.projects.length && !plan.projects.some((p) => compact(p) === compact(source.project))) return false;
  if (plan.tags.length && !plan.tags.some((t) => (source.tags ?? []).some((x) => fold(x) === fold(t)))) return false;
  if (plan.types.length && source.type && !plan.types.includes(source.type)) return false;
  if (plan.types.length && !source.type) return false;
  if (plan.status === 'open' && source.status === 'done') return false;
  if (plan.status === 'done' && source.status && source.status !== 'done') return false;
  const day = str(source.date).slice(0, 10);
  if (plan.since && (!day || day < plan.since)) return false;
  if (plan.until && (!day || day > plan.until)) return false;
  if (plan.encrypted && !source.encrypted) return false;
  if (plan.untitled && !source.untitled) return false;
  return true;
}

// Every place `needle` is in `hay` (folded), whole words only for short single words.
function positions(hay, needle, cap = 200) {
  const out = [];
  const whole = needle.length <= 4 && !needle.includes(' ');
  for (let i = hay.indexOf(needle); i !== -1 && out.length < cap; i = hay.indexOf(needle, i + needle.length)) {
    if (whole && ((i > 0 && WORD_CHAR.test(hay[i - 1])) || WORD_CHAR.test(hay[i + needle.length] ?? ''))) continue;
    out.push(i);
  }
  return out;
}

const lineAt = (starts, pos) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/**
 * How a source matches the plan, or null when its filters leave it out: { ...the source without
 * its text, counts: [occurrences per term], inName: [whether each term is in its name], names: n (the
 * plan's names in its name), patterns: [matches per pattern], lines: [{ line (1-based), text }] (up to
 * 3, the best first) }. The editor's main process measures the files of the folders shown this way
 * and sends back only these.
 */
export function measure(source, plan) {
  if (!passes(source, plan)) return null;
  const { text: _text, ...meta } = source;
  const name = fold(source.name);
  const words = plan.terms.map(fold);
  const entry = {
    ...meta,
    counts: words.map(() => 0),
    inName: words.map((w) => Boolean(w) && name.includes(w)),
    names: plan.names.map(fold).filter((w) => w && name.includes(w)).length,
    patterns: plan.patterns.map(() => 0),
    lines: [],
  };
  if (source.encrypted || (!words.length && !plan.patterns.length)) return entry;
  const raw = str(source.text).slice(0, MAX_TEXT);
  if (!raw) return entry;
  const hay = fold(raw);
  // Folding can change lengths (rare letters): lines are then counted in the folded text.
  const lineText = hay.length === raw.length ? raw : hay;
  const hits = []; // [{ pos, weight }]
  words.forEach((w, i) => {
    if (!w) return;
    const at = positions(hay, w);
    entry.counts[i] = at.length;
    for (const pos of at.slice(0, 20)) hits.push({ pos, weight: w.includes(' ') ? 3 : 1 });
  });
  plan.patterns.forEach((p, i) => {
    const re = new RegExp(p, 'gi');
    let n = 0;
    for (let m = re.exec(raw); m && n < 200; m = re.exec(raw)) {
      n++;
      if (n <= 20) hits.push({ pos: m.index, weight: 4 });
      if (!m[0].length) re.lastIndex++;
    }
    entry.patterns[i] = n;
  });
  if (hits.length) {
    const starts = [0];
    for (let i = lineText.indexOf('\n'); i !== -1; i = lineText.indexOf('\n', i + 1)) starts.push(i + 1);
    const byLine = new Map();
    for (const h of hits) {
      const line = lineAt(starts, h.pos);
      byLine.set(line, (byLine.get(line) ?? 0) + h.weight);
    }
    entry.lines = [...byLine.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, LINES_PER_SOURCE)
      .map(([line]) => ({ line: line + 1, text: clip(lineText.slice(starts[line], (starts[line + 1] ?? lineText.length + 1) - 1).trim(), LINE_CHARS) }));
  }
  return entry;
}

/**
 * The measured sources ranked for the plan: rare terms count more than common ones (`total`: how
 * many sources passed the filters, for that), phrases, patterns and names more than single words;
 * newer ones lead when the plan sorts by time, else recency only breaks near ties. Sources that
 * match nothing are left out, unless the plan only lists (intent "list"). Returns the best `max`,
 * each with its `score`.
 */
export function rankMeasured(entries, plan, { total = entries.length, now = new Date().toISOString(), max = plan.intent === 'list' ? MAX_LISTED : MAX_CANDIDATES } = {}) {
  const n = Math.max(total, entries.length, 1);
  const df = plan.terms.map((_, i) => entries.filter((e) => e.counts[i] > 0).length);
  const idf = df.map((d) => Math.log(1 + n / (1 + d)));
  const nowMs = Date.parse(now) || Date.now();
  const scored = [];
  for (const e of entries) {
    let score = 0;
    plan.terms.forEach((t, i) => {
      if (e.counts[i]) score += idf[i] * (1 + Math.log(1 + e.counts[i])) * (t.includes(' ') ? 2 : 1);
      // A term in the name counts as much as found twice, by its rarity too.
      if (e.inName?.[i]) score += idf[i] * 2;
    });
    score += e.patterns.reduce((s, c) => s + (c ? 4 + Math.log(1 + c) : 0), 0);
    score += e.names * 2.5;
    const listing = plan.intent === 'list' || (!plan.terms.length && !plan.patterns.length && !plan.names.length);
    if (!score && !listing) continue;
    const ageDays = Math.max(0, (nowMs - (Date.parse(e.date) || 0)) / 86_400_000);
    const fresh = Math.exp(-ageDays / 90);
    scored.push({ ...e, score: Math.round((score + (listing ? 1 : 0) + 0.5 * fresh) * 1000) / 1000 });
  }
  const byDate = (a, b) => str(b.date).localeCompare(str(a.date));
  scored.sort(plan.sort === 'recent' ? (a, b) => byDate(a, b) || b.score - a.score : plan.sort === 'oldest' ? (a, b) => byDate(b, a) || b.score - a.score : (a, b) => b.score - a.score || byDate(a, b));
  return scored.slice(0, max);
}

/** Sources measured and ranked in one go (the pages' own sources). */
export function rankSources(sources, plan, opts = {}) {
  const entries = [];
  let total = 0;
  for (const s of sources) {
    const e = measure(s, plan);
    if (!e) continue;
    total++;
    entries.push(e);
  }
  return rankMeasured(entries, plan, { total, ...opts });
}

// ---- The pick ----

/** Whether the model should pick from the candidates (not for plain listings, encrypted files or one candidate). */
export const wantsPick = (plan, candidates) => plan.intent === 'find' && !plan.encrypted && candidates.filter((c) => !c.encrypted).length > 1;

const PICK_SYSTEM = `The person asked their app a question to find something in their own notes, files or tracker. The app searched and found the candidates below (each with its name, where it is, and the lines that matched). Pick those that answer the question, best first, and say in one short line why each fits (quote what matches, with its line number when there is one). Leave out the ones that do not fit. Reply with ONLY a JSON object: {"results": [{"id": "c1", "why": "…"}]} with at most ${MAX_PICKS} results, using only the ids given; {"results": []} when none fits.`;

/**
 * The messages asking the model to pick. Candidates go as c1, c2… with their name, place, project,
 * date and matching lines (`namesOnly`: no lines). Encrypted candidates never go.
 */
export function pickMessages(question, candidates, { namesOnly = false } = {}) {
  const lines = [];
  candidates
    .filter((c) => !c.encrypted)
    .forEach((c, i) => {
      const where = [c.place, c.project && !str(c.place).includes(c.project) ? c.project : '', c.type, c.status, str(c.date).slice(0, 10)].filter(Boolean).join(' · ');
      lines.push(`[c${i + 1}] ${c.name || '(no name)'}${where ? ` — ${where}` : ''}`);
      if (!namesOnly) for (const l of c.lines ?? []) lines.push(`  ${l.line}: ${l.text}`);
    });
  return [
    { role: 'system', content: PICK_SYSTEM },
    { role: 'user', content: `Question: ${str(question).trim()}\n\nCandidates:\n${lines.join('\n') || '(none)'}` },
  ];
}

/**
 * The model's pick → [{ ...candidate, why }] in its order (only candidates given, once each), or null
 * when the reply is no use (the app then shows its own ranking).
 */
export function parsePick(reply, candidates) {
  const data = jsonIn(reply);
  if (!data || !Array.isArray(data.results)) return null;
  const sent = candidates.filter((c) => !c.encrypted);
  const out = [];
  const seen = new Set();
  for (const r of data.results) {
    const m = /^c(\d{1,3})$/.exec(str(r?.id).trim());
    const c = m && sent[Number(m[1]) - 1];
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ ...c, why: clip(str(r.why).trim().replace(/\s+/g, ' '), 200) });
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

/**
 * The results to show: the model's pick (or the ranking when there was none), then encrypted sources
 * that match by name (apart: the model never saw them). { results, encrypted, more } (`more`: the
 * ranked candidates not picked, for "show all").
 */
export function findResults(candidates, picked, plan) {
  const encrypted = candidates.filter((c) => c.encrypted);
  const open = candidates.filter((c) => !c.encrypted);
  if (plan.encrypted) return { results: [], encrypted, more: [] };
  const results = (picked ?? (plan.intent === 'list' ? open : open.slice(0, plan.limit))).map((c) => ({ ...c, why: c.why ?? '' }));
  const shown = new Set(results.map((c) => c.id));
  return { results, encrypted, more: open.filter((c) => !shown.has(c.id)) };
}

/** Whether what was typed in a search box is a question to ask (rather than words to match): `?…`, or a question or request in words. */
export function looksLikeQuestion(text) {
  const t = str(text).trim();
  if (t.startsWith('?')) return t.length > 1;
  if (t.length < 12 || t.split(/\s+/).length < 3) return false;
  return (
    /\?$/.test(t) ||
    /^(show|find|give|get|list|where|which|what|when|who|how|open|search|look|bring|muestra|busca|dame|encuentra|donde|dónde|cual|cuál|qué|que)\b/i.test(t) ||
    /\b(the (file|note|item|task|doc|one)s? (where|with|that|about|i)|files? (of|about|for|from|with|where)|notes? (about|on|from|with|where)|items? (about|for|from)|tasks? (about|for|from|due))\b/i.test(t) ||
    /\b(i|we) (wrote|copied|pasted|saved|made|put|left|kept|sent|added|noted)\b/i.test(t)
  );
}

/** The question without its leading "?". */
export const questionOf = (text) => str(text).trim().replace(/^\?\s*/, '');
