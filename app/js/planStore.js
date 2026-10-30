// The day's plans kept with the data (plans.js says what they hold): read from the data repo
// (or the data on this device), cached here so they show offline, written with the version
// they were read at (two devices saving at once: both versions are kept, merged).
import { kvGet, kvSet } from './kv.js';
import { localDate } from './model.js';
import { emptyPlans, mergePlans, parsePlans, planPath, PLANS_DIR, serializePlans, withPlan } from './plans.js';
import { getSettings } from './settings.js';
import { dataClient, onSynced } from './syncManager.js';

const cache = new Map(); // date → { sha, plans }
const listeners = new Set();
// Days saved here that could not be written yet (offline, no sync set up): written after the next sync.
let unsaved = null;
const loadUnsaved = async () => (unsaved ??= new Set((await kvGet('plansUnsaved')) ?? []));

const announce = (date) => listeners.forEach((fn) => fn(date, cache.get(date)?.plans ?? emptyPlans(date)));

/** Calls `fn(date, plans)` whenever a day's plans are read or saved here. */
export function onPlans(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The plans of a day already read on this device (null when not read yet). */
export const cachedPlans = (date) => cache.get(date)?.plans ?? null;

async function remember(date, sha, plans) {
  const before = cache.get(date);
  cache.set(date, { sha, plans });
  await kvSet(`plans:${date}`, { sha, plans }).catch(() => {});
  if (JSON.stringify(before?.plans) !== JSON.stringify(plans)) announce(date);
  return plans;
}

/** A day's plans: from this device when read before (unless `fresh`), else from the data. */
export async function loadPlans(date, { fresh = false } = {}) {
  if (!fresh && cache.has(date)) return cache.get(date).plans;
  if (!cache.has(date)) {
    const kept = await kvGet(`plans:${date}`);
    if (kept?.plans) {
      cache.set(date, { sha: kept.sha ?? '', plans: parsePlans(kept.plans, date) });
      announce(date);
      if (!fresh) return cache.get(date).plans;
    }
  }
  try {
    const { client, branch } = await dataClient();
    const file = await client.getFile(planPath(date), branch || undefined);
    const there = file ? parsePlans(file.text, date) : emptyPlans(date);
    // What this device saved and could not write yet stays.
    const mine = (await loadUnsaved()).has(date) ? cache.get(date)?.plans : null;
    return remember(date, file?.sha ?? '', mine ? mergePlans(there, mine) : there);
  } catch {
    return cache.get(date)?.plans ?? emptyPlans(date);
  }
}

// Writes a day's plans: what is there merged with ours, at the version read (retried when it moved).
async function write(date, ours) {
  const { client, branch } = await dataClient();
  for (let attempt = 0; attempt < 4; attempt++) {
    const file = await client.getFile(planPath(date), branch || undefined);
    const merged = file ? mergePlans(parsePlans(file.text, date), ours) : ours;
    try {
      const { sha } = await client.putFile(planPath(date), {
        text: serializePlans(merged),
        sha: file?.sha,
        branch: branch || undefined,
        message: `Tracker: plans for ${date} (from ${getSettings().device || 'unknown device'})`,
      });
      return remember(date, sha ?? '', merged);
    } catch (err) {
      if (err?.status !== 409 && err?.status !== 422) throw err;
    }
  }
  throw new Error('The plans kept changing on another device; try again.');
}

/** Saves a new version of `kind` ('day' or 'week') for `date`: here at once, in the data as soon as it can be. */
export async function savePlan(date, kind, version) {
  const plans = withPlan(cachedPlans(date) ?? (await loadPlans(date)), kind, version);
  await remember(date, cache.get(date)?.sha ?? '', plans);
  await loadUnsaved();
  try {
    await write(date, plans);
    if (unsaved.delete(date)) kvSet('plansUnsaved', [...unsaved]).catch(() => {});
    return { saved: true, plans: cachedPlans(date) };
  } catch {
    unsaved.add(date);
    kvSet('plansUnsaved', [...unsaved]).catch(() => {});
    return { saved: false, plans };
  }
}

/** The days of a month (yyyy-mm) that have plans: a Set of dates (empty when none, or not reachable). */
export async function planDays(month) {
  try {
    const { client, branch } = await dataClient();
    const entries = (await client.listDir(`${PLANS_DIR}/${month}`, branch || undefined)) ?? [];
    return new Set(entries.map((e) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(e.name)?.[1]).filter(Boolean));
  } catch {
    return new Set();
  }
}

// After each sync: what waits is written, and today's plans are read again (another device may have changed them).
onSynced(async () => {
  for (const date of [...(await loadUnsaved())]) {
    const plans = cachedPlans(date);
    if (!plans) continue;
    try {
      await write(date, plans);
      unsaved.delete(date);
      kvSet('plansUnsaved', [...unsaved]).catch(() => {});
    } catch {
      // still waiting
    }
  }
  loadPlans(localDate(), { fresh: true }).catch(() => {});
});
