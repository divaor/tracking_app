// The day's plan and the week's review, kept (planStore.js): the Overview's card, a strip
// above List and Board, and updates by themselves (setting `planAuto`).
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { modelReady, planWith } from '../assistant.js';
import { boardPlanLines } from '../boards.js';
import { cachedBoard, cachedBoards } from '../boardStore.js';
import { renderMarkdown } from '../markdown.js';
import { nowIso } from '../model.js';
import { changedSince, changesSince, describeChanges, emptyPlans, planVersions } from '../plans.js';
import { cachedPlans, loadPlans, onPlans, savePlan } from '../planStore.js';
import { getSettings, saveSettings } from '../settings.js';
import { Icon } from './icons.js';
import { ListenButton, sourceOf } from './listen.js';
import { isDesktopApp } from '../platform.js';

const LABELS = { day: { title: 'Your day', make: 'Plan my day', update: 'Update', name: 'plan' }, week: { title: 'Your week', make: 'Review my week', update: 'Update', name: 'review' } };
// Updates by themselves: at most this often, and after this hour for the first plan of the day.
export const AUTO_GAP_MS = 2 * 60 * 60 * 1000;
const AUTO_FROM_HOUR = 6;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const clock = (iso) => timeFormat.format(new Date(iso));

/** A day's plans, kept current (read again when another device or this one saves them). */
export function usePlans(date) {
  const [plans, setPlans] = useState(() => cachedPlans(date) ?? emptyPlans(date));
  useEffect(() => {
    let alive = true;
    setPlans(cachedPlans(date) ?? emptyPlans(date));
    loadPlans(date).then((p) => alive && setPlans(p));
    const off = onPlans((d, p) => d === date && setPlans(p));
    return () => {
      alive = false;
      off();
    };
  }, [date]);
  // Right after the day changes, never the day before's.
  return plans.date === date ? plans : (cachedPlans(date) ?? emptyPlans(date));
}

// ---- Writing one (one at a time, whoever asked) -------------------------------------

// The plan being written: { kind, date, update, text, status: 'asking' | 'error', error, auto }, or null.
let running = null;
let controller = null;
const runListeners = new Set();
const setRunning = (next) => {
  running = next;
  runListeners.forEach((fn) => fn(running));
};

/** The plan being written now (or null), kept current. */
export function useRunningPlan() {
  const [state, setState] = useState(running);
  useEffect(() => {
    runListeners.add(setState);
    return () => runListeners.delete(setState);
  }, []);
  return state;
}

/**
 * Asks the model for today's plan ('day') or the week's review ('week') and keeps it. With
 * `update`, the one made earlier today is updated with what changed since. Resolves
 * { saved } (false: kept on this device, written with the next sync), or null when it did not run.
 */
export async function makePlan(kind, { items, today, update = false, auto = false }) {
  if (running?.status === 'asking') return null;
  controller = new AbortController();
  const { signal } = controller;
  setRunning({ kind, date: today, update, text: '', status: 'asking', auto });
  let out = '';
  try {
    const plans = await loadPlans(today, { fresh: true });
    const previous = update ? plans[kind] : null;
    const changes = previous ? changesSince(items, previous.at, today) : null;
    const boards = boardPlanLines(cachedBoards().map(({ slug }) => ({ slug, board: cachedBoard(slug) })).filter((b) => b.board));
    const reply = await planWith(items, { kind, today, previous, changes, boards, signal, onToken: (t) => setRunning({ ...running, text: (out += t) }) });
    const text = (reply || out).trim();
    if (!text) throw new Error('The model gave no answer.');
    const { llm, device } = getSettings();
    const result = await savePlan(today, kind, { text, at: nowIso(), by: device || 'this device', model: llm.chatModel ?? '' });
    setRunning(null);
    return result;
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) setRunning(null);
    else setRunning({ ...running, status: 'error', error: err?.message ?? String(err) });
    return null;
  }
}

/** Stops the plan being written (or clears its error). */
export function stopPlan() {
  controller?.abort();
  setRunning(null);
}

// ---- Shown ----------------------------------------------------------------------------

/** "9:40 on Desktop (Windows)" and, when the items changed since, "· 3 done, 1 added since". */
function PlanMeta({ entry, items, today, extra = null }) {
  const changes = items && entry ? describeChanges(changesSince(items, entry.at, today)) : '';
  return html`<p class="plan-meta muted small">
    ${entry ? `${entry.at.slice(0, 10) === today ? '' : `${entry.at.slice(0, 10)} `}${clock(entry.at)}${entry.by ? ` on ${entry.by}` : ''}` : ''}
    ${changes && html` · <span class="plan-since" title="What changed in your items since it was made">${changes} since</span>`}
    ${extra}
  </p>`;
}

/**
 * A plan's text with its earlier versions: ‹ earlier versions › shows one at a time, "Latest"
 * goes back. `streaming` replaces it while a new one is being written.
 */
export function PlanBody({ entry, streaming = null, clamp = false }) {
  const versions = planVersions(entry);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [entry?.at]);
  if (streaming !== null) {
    return streaming
      ? html`<div class="markdown plan-text" dangerouslySetInnerHTML=${{ __html: renderMarkdown(streaming) }} />`
      : html`<p class="muted small"><${Icon} name="sync" size=${14} /> Thinking…</p>`;
  }
  if (!entry) return null;
  const shown = versions[Math.min(index, versions.length - 1)];
  return html`<div class="plan-body">
    ${versions.length > 1 &&
    !clamp &&
    html`<div class="plan-versions" role="group" aria-label="Versions">
      <button type="button" class="icon-btn sm" aria-label="An earlier version" title="An earlier version" disabled=${index >= versions.length - 1} onClick=${() => setIndex(index + 1)}><${Icon} name="chevronLeft" size=${15} /></button>
      <span class="small">${index === 0 ? `Latest · ${versions.length - 1} earlier today` : `The ${clock(shown.at)} version`}</span>
      <button type="button" class="icon-btn sm" aria-label="A later version" title="A later version" disabled=${index === 0} onClick=${() => setIndex(index - 1)}><${Icon} name="chevronRight" size=${15} /></button>
      ${index > 0 && html`<button type="button" class="btn link sm" onClick=${() => setIndex(0)}>Latest</button>`}
    </div>`}
    <div class="markdown plan-text ${clamp ? 'clamped' : ''}" dangerouslySetInnerHTML=${{ __html: renderMarkdown(shown.text) }} />
  </div>`;
}

/** Overview: today's plan or this week's review, kept; Plan my day / Review my week, Update, earlier versions, past days. */
export function PlanCard({ items, today }) {
  const plans = usePlans(today);
  const run = useRunningPlan();
  const card = useRef(null);
  const [kind, setKind] = useState(() => (plans.week && !plans.day ? 'week' : 'day'));
  const ready = modelReady() && items.length > 0;
  // A plan being written for this day shows here, on its tab.
  const writing = run && run.date === today ? run : null;
  useEffect(() => {
    if (writing) setKind(writing.kind);
  }, [writing?.kind]);
  if (!ready && !plans.day && !plans.week) return null;
  const entry = plans[kind];
  const label = LABELS[kind];
  const ask = (update) => makePlan(kind, { items, today, update });
  const asking = writing?.kind === kind && writing.status === 'asking';
  return html`<section class="plan-card" aria-label="Plan with the model" ref=${card}>
    <div class="plan-head">
      <h2><${Icon} name="sparkle" size=${17} />${label.title}</h2>
      <div class="plan-tabs" role="tablist" aria-label="Plan or review">
        ${['day', 'week'].map(
          (k) => html`<button type="button" role="tab" key=${k} aria-selected=${kind === k} class="plan-tab ${kind === k ? 'on' : ''}" onClick=${() => setKind(k)}>
            ${k === 'day' ? 'Day' : 'Week'}${plans[k] && html`<span class="plan-dot" aria-hidden="true" />`}</button>`,
        )}
      </div>
      <span class="spacer" />
      ${ready &&
      (writing?.status === 'asking'
        ? html`<button type="button" class="btn sm" onClick=${stopPlan}><${Icon} name="stop" size=${14} />Stop</button>`
        : html`<button type="button" class="btn sm ${entry ? '' : 'primary'}" title=${entry ? `Ask again with what changed since ${clock(entry.at)}` : ''} onClick=${() => ask(Boolean(entry))}>
            <${Icon} name=${entry ? 'sync' : 'sparkle'} size=${14} />${entry ? label.update : label.make}</button>`)}
      ${entry && !asking && html`<${ListenButton} readKey=${`plan:${today}:${kind}`} name=${kind === 'day' ? 'Today’s plan' : 'This week’s review'} label=${false} className="icon-btn sm"
        title=${`Listen to ${kind === 'day' ? 'the plan' : 'the review'}`} source=${() => sourceOf(card.current?.querySelector('.plan-text'), { fromStart: true })} />`}
      <a class="icon-btn sm" href="#/days" title="Past days: plans, what got done" aria-label="Past days"><${Icon} name="calendar" size=${16} /></a>
    </div>
    ${writing?.kind === kind && writing.status === 'asking'
      ? html`<${PlanBody} streaming=${writing.text} />`
      : entry
        ? html`<${PlanMeta} entry=${entry} items=${items} today=${today} /><${PlanBody} entry=${entry} />`
        : html`<p class="muted small">${kind === 'day' ? 'The model suggests what to do first today, from your open items. It is kept: every device sees it, and you can update it as the day goes.' : 'The model reviews what got done this week and what is stuck. It is kept with the day, to look back on.'}</p>`}
    ${writing?.kind === kind && writing.status === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${15} /><span>${writing.error}</span></p>`}
    ${!modelReady() && entry && html`<p class="muted small">Connect a model in Settings to update it here, or ask Claude to (with the Tracker connector).</p>`}
  </section>`;
}

/**
 * Above List and Board: today's plan in a few lines (a click shows it all), Update, and × to hide
 * it in that view (setting `planStripHidden`; the toolbar's Today's plan brings it back).
 */
export function PlanStrip({ view, items, today }) {
  const plans = usePlans(today);
  const run = useRunningPlan();
  const [open, setOpen] = useState(false);
  const strip = useRef(null);
  const hidden = Boolean(getSettings().planStripHidden?.[view]);
  const entry = plans.day;
  const writing = run && run.date === today && run.kind === 'day' ? run : null;
  const ready = modelReady() && items.length > 0;
  if (hidden || (!entry && !writing && !ready)) return null;
  const hide = () => saveSettings({ planStripHidden: { ...getSettings().planStripHidden, [view]: true } });
  return html`<section class="plan-strip ${open ? 'open' : ''}" aria-label="Today's plan" ref=${strip}>
    <div class="plan-strip-head">
      <button type="button" class="plan-strip-toggle" aria-expanded=${open} onClick=${() => setOpen(!open)} disabled=${!entry && !writing}>
        <${Icon} name="sparkle" size=${15} /><strong>Today's plan</strong>
        ${entry && html`<span class="muted small">${clock(entry.at)}${describeChanges(changesSince(items, entry.at, today)) ? ` · ${describeChanges(changesSince(items, entry.at, today))} since` : ''}</span>`}
        ${!entry && !writing && html`<span class="muted small">none yet</span>`}
        ${(entry || writing) && html`<${Icon} name=${open ? 'chevronUp' : 'chevronDown'} size=${15} />`}
      </button>
      <span class="spacer" />
      ${ready &&
      (writing?.status === 'asking'
        ? html`<button type="button" class="btn ghost sm" onClick=${stopPlan}><${Icon} name="stop" size=${13} />Stop</button>`
        : html`<button type="button" class="btn ghost sm" onClick=${() => (setOpen(true), makePlan('day', { items, today, update: Boolean(entry) }))}>
            <${Icon} name=${entry ? 'sync' : 'sparkle'} size=${13} />${entry ? 'Update' : 'Plan my day'}</button>`)}
      ${entry && writing?.status !== 'asking' && html`<${ListenButton} readKey=${`plan:${today}:day:${view}`} name="Today’s plan" label=${false} className="icon-btn sm"
        title="Listen to the plan" before=${() => setOpen(true)} source=${() => sourceOf(strip.current?.querySelector('.plan-text'), { fromStart: true })} />`}
      <button type="button" class="icon-btn sm" title="Hide it here (the toolbar's Today's plan shows it again)" aria-label="Hide today's plan" onClick=${hide}><${Icon} name="x" size=${15} /></button>
    </div>
    ${writing?.status === 'asking'
      ? html`<${PlanBody} streaming=${writing.text} />`
      : entry && html`<div class="plan-strip-body" onClick=${() => !open && setOpen(true)}><${PlanBody} entry=${entry} clamp=${!open} /></div>`}
    ${writing?.status === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${15} /><span>${writing.error}</span></p>`}
  </section>`;
}

/** The toolbar's way back to a hidden strip (shown only while it is hidden in this view). */
export function PlanStripToggle({ view }) {
  const hidden = getSettings().planStripHidden ?? {};
  if (!hidden[view]) return null;
  return html`<button type="button" class="btn ghost sm plan-strip-show" title="Show today's plan above the items"
    onClick=${() => saveSettings({ planStripHidden: { ...hidden, [view]: false } })}><${Icon} name="sparkle" size=${14} />Today's plan</button>`;
}

/**
 * Today's plan made and kept up to date by itself (setting `planAuto`): the first time the app
 * is open on a day (from 6:00), then after items are done, started or added, at most every
 * AUTO_GAP_MS. Looks a moment after the items change, and every few minutes while the app is open.
 */
export function usePlanAuto({ items, today, on }) {
  const latest = useRef(items);
  latest.current = items;
  const checkRef = useRef(null);
  // A moment after the items change (several changes in a row: once).
  useEffect(() => {
    if (!on) return undefined;
    const soon = setTimeout(() => checkRef.current?.(), 30_000);
    return () => clearTimeout(soon);
  }, [on, items]);
  useEffect(() => {
    if (!on) return undefined;
    const check = (checkRef.current = async () => {
      if (!modelReady() || running || !latest.current.length) return;
      if (document.hidden && !isDesktopApp()) return;
      const plans = await loadPlans(today, { fresh: true });
      if (!plans.day) {
        if (new Date().getHours() >= AUTO_FROM_HOUR) makePlan('day', { items: latest.current, today, auto: true });
        return;
      }
      if (Date.now() - Date.parse(plans.day.at) < AUTO_GAP_MS) return;
      if (changedSince(latest.current, plans.day.at, today)) makePlan('day', { items: latest.current, today, update: true, auto: true });
    });
    const first = setTimeout(check, 15_000);
    const every = setInterval(check, 5 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [on, today]);
}
