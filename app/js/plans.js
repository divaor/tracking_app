// Plans for the day and reviews of the week, kept with the data: one small file a day,
// plans/<yyyy-mm>/<yyyy-mm-dd>.json, so every device (and Claude) sees them and past days stay
// to look back on. A day holds `day` (the plan) and `week` (a review made that day); each is
// the latest version, with the earlier ones of that day under `versions` (newest first).
// Pure, so the Node tests and the connector can import it.
import { liveComments, localDate } from './model.js';

export const PLANS_DIR = 'plans';
export const PLAN_KINDS = ['day', 'week'];
// Earlier versions kept per kind and day.
export const MAX_VERSIONS = 12;
const MAX_TEXT = 20_000;

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const text = (v) => (typeof v === 'string' ? v : '');

/** Where a day's plans are kept: plans/2026-10/2026-10-30.json. */
export const planPath = (date, dir = PLANS_DIR) => `${dir}/${date.slice(0, 7)}/${date}.json`;
/** The day a plans path is for, or null. */
export const dateOfPlanPath = (path) => /(\d{4}-\d{2}-\d{2})\.json$/.exec(path ?? '')?.[1] ?? null;

export const emptyPlans = (date) => ({ date, day: null, week: null });

// One version: { text, at, by, model }.
function cleanVersion(v) {
  if (!v || typeof v !== 'object' || !text(v.text).trim() || !Number.isFinite(Date.parse(v.at))) return null;
  return { text: text(v.text).slice(0, MAX_TEXT), at: new Date(v.at).toISOString(), by: text(v.by), model: text(v.model) };
}

// A plan: its latest version, the earlier ones under `versions` (newest first, at most MAX_VERSIONS).
function cleanEntry(e) {
  const latest = cleanVersion(e);
  if (!latest) return null;
  const versions = (Array.isArray(e.versions) ? e.versions : []).map(cleanVersion).filter(Boolean);
  return withVersions(latest, versions);
}

function withVersions(latest, earlier) {
  const seen = new Set([latest.at]);
  const versions = earlier
    .filter((v) => v.at !== latest.at && !seen.has(v.at) && seen.add(v.at))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_VERSIONS);
  return { ...latest, versions };
}

/** A day's plans from a file's text (anything unreadable is left out, never thrown). */
export function parsePlans(raw, date) {
  let data = null;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    data = null;
  }
  const out = emptyPlans(isDate(data?.date) ? data.date : date);
  for (const kind of PLAN_KINDS) out[kind] = cleanEntry(data?.[kind]);
  return out;
}

export const serializePlans = (plans) => `${JSON.stringify(plans, null, 2)}\n`;

/** The day's plans with a new version of `kind` (the one it replaces goes under versions). */
export function withPlan(plans, kind, version) {
  const next = cleanVersion(version);
  if (!next || !PLAN_KINDS.includes(kind)) return plans;
  const current = plans[kind];
  const earlier = current ? [{ text: current.text, at: current.at, by: current.by, model: current.model }, ...current.versions] : [];
  return { ...plans, [kind]: withVersions(next, earlier) };
}

/** Two copies of a day's plans (two devices saved at once): every version of both, the latest on top. */
export function mergePlans(a, b) {
  const out = emptyPlans(a?.date ?? b?.date);
  for (const kind of PLAN_KINDS) {
    const all = [a?.[kind], b?.[kind]].filter(Boolean).flatMap((e) => [e, ...e.versions]).map(cleanVersion).filter(Boolean);
    if (!all.length) continue;
    all.sort((x, y) => y.at.localeCompare(x.at));
    out[kind] = withVersions(all[0], all.slice(1));
  }
  return out;
}

/** The versions of a plan, newest first (the latest, then the earlier ones). */
export const planVersions = (entry) => (entry ? [{ text: entry.text, at: entry.at, by: entry.by, model: entry.model }, ...entry.versions] : []);

// ---- What happened: since a plan was made, and on a given day ----------------------

const dayOf = (iso) => (iso ? localDate(new Date(iso)) : '');

/** What changed in the items since `at`: { done, started, added, overdue } (items). */
export function changesSince(items, at, today) {
  const live = items.filter((i) => !i.deleted);
  const after = (iso) => Boolean(iso) && iso > at;
  return {
    done: live.filter((i) => i.status === 'done' && after(i.completedAt)),
    started: live.filter((i) => i.status === 'in_progress' && after(i.startedAt)),
    added: live.filter((i) => after(i.createdAt)),
    // Due before today and still open: overdue now (those due today count from tomorrow).
    overdue: live.filter((i) => i.status !== 'done' && i.due && i.due < today && i.due >= dayOf(at)),
  };
}

/** "3 done, 1 started, 2 added" (nothing: ''). */
export function describeChanges(changes) {
  const parts = [];
  if (changes.done.length) parts.push(`${changes.done.length} done`);
  if (changes.started.length) parts.push(`${changes.started.length} started`);
  if (changes.added.length) parts.push(`${changes.added.length} added`);
  if (changes.overdue.length) parts.push(`${changes.overdue.length} now overdue`);
  return parts.join(', ');
}

/** Whether the items changed enough since `at` for a plan to be made again. */
export const changedSince = (items, at, today) => describeChanges(changesSince(items, at, today)) !== '';

/**
 * What happened on `date` (this device's days): items done, started and added that day, and the
 * comments written that day ({ item, comment }), newest first.
 */
export function dayActivity(items, date) {
  const live = items.filter((i) => !i.deleted);
  const newest = (key) => (a, b) => (b[key] ?? '').localeCompare(a[key] ?? '');
  const comments = live
    .flatMap((item) => liveComments(item).filter((c) => dayOf(c.at) === date).map((comment) => ({ item, comment })))
    .sort((a, b) => b.comment.at.localeCompare(a.comment.at));
  return {
    done: live.filter((i) => i.status === 'done' && dayOf(i.completedAt) === date).sort(newest('completedAt')),
    started: live.filter((i) => i.startedAt && dayOf(i.startedAt) === date && !(i.status === 'done' && dayOf(i.completedAt) === date)).sort(newest('startedAt')),
    added: live.filter((i) => dayOf(i.createdAt) === date).sort(newest('createdAt')),
    comments,
  };
}

/** Items done on each of the `days` days up to `today` (oldest first): [{ date, done }]. */
export function doneByDay(items, today, days = 28) {
  const counts = new Map();
  for (const i of items) if (!i.deleted && i.status === 'done' && i.completedAt) counts.set(dayOf(i.completedAt), (counts.get(dayOf(i.completedAt)) ?? 0) + 1);
  const out = [];
  const [y, m, d] = today.split('-').map(Number);
  for (let n = days - 1; n >= 0; n--) {
    const date = localDate(new Date(y, m - 1, d - n));
    out.push({ date, done: counts.get(date) ?? 0 });
  }
  return out;
}
