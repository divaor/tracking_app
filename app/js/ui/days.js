// Days: looking back. Bars of what got done each of the last four weeks, and for the day
// picked its plan and review (kept, with their versions), what got done, started and added,
// and the comments written. #/days/<date>.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { addDays, CLAUDE_AUTHOR } from '../model.js';
import { formatDue, parseDay } from '../format.js';
import { dayActivity, doneByDay } from '../plans.js';
import { planDays } from '../planStore.js';
import { renderMarkdown } from '../markdown.js';
import { Icon } from './icons.js';
import { ItemRow } from './components.js';
import { PlanBody, usePlans } from './plans.js';

const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const CHART_DAYS = 28;

const go = (day, today) => (location.hash = day && day !== today ? `#/days/${day}` : '#/days');

/** The days of the last two months that have plans kept (a Set), for the marks under the bars. */
function usePlanDays(today) {
  const [days, setDays] = useState(() => new Set());
  useEffect(() => {
    let alive = true;
    const months = [...new Set([today.slice(0, 7), addDays(today, -CHART_DAYS).slice(0, 7)])];
    Promise.all(months.map(planDays)).then((sets) => alive && setDays(new Set(sets.flatMap((s) => [...s]))));
    return () => {
      alive = false;
    };
  }, [today]);
  return days;
}

function Block({ title, icon, count, children, empty }) {
  return html`<section class="day-block">
    <h3><${Icon} name=${icon} size=${16} />${title}${count != null && html`<span class="count">${count}</span>`}</h3>
    ${count === 0 || (!children && empty) ? html`<p class="muted small">${empty}</p>` : children}
  </section>`;
}

export function DaysView({ items, today, day, actions }) {
  const date = day && day <= today ? day : today;
  const plans = usePlans(date);
  const withPlans = usePlanDays(today);
  const bars = doneByDay(items, today, CHART_DAYS);
  const most = Math.max(1, ...bars.map((b) => b.done));
  const week = bars.slice(-7).reduce((n, b) => n + b.done, 0);
  const activity = dayActivity(items, date);
  const rows = (list) =>
    html`<div class="rows">${list.map((item) => html`<${ItemRow} key=${item.id} item=${item} onOpen=${actions.open} onStatus=${actions.cycleStatus} today=${today} />`)}</div>`;
  const when = date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : formatDue(date, today);

  return html`<div class="days-view">
    <section class="days-chart-card" aria-label="Done each day, the last four weeks">
      <div class="days-chart-head">
        <h2>What got done</h2>
        <span class="muted small">${week} in the last 7 days · ${bars.reduce((n, b) => n + b.done, 0)} in four weeks</span>
      </div>
      <div class="days-chart">
        ${bars.map((b) => {
          const d = parseDay(b.date);
          return html`<button type="button" key=${b.date} class="day-bar ${b.date === date ? 'on' : ''} ${d.getDay() === 1 ? 'monday' : ''}"
            title=${`${shortDay.format(d)}: ${b.done} done${withPlans.has(b.date) ? ', with a plan' : ''}`} aria-label=${`${shortDay.format(d)}: ${b.done} done`}
            aria-pressed=${b.date === date} onClick=${() => go(b.date, today)}>
            <span class="day-bar-fill" style=${{ height: `${Math.round((b.done / most) * 100)}%` }} />
            <span class="day-bar-label">${d.getDate()}</span>
            ${withPlans.has(b.date) && html`<span class="day-bar-plan" aria-hidden="true" />`}
          </button>`;
        })}
      </div>
    </section>

    <div class="days-nav">
      <button type="button" class="icon-btn" aria-label="The day before" title="The day before" onClick=${() => go(addDays(date, -1), today)}><${Icon} name="chevronLeft" /></button>
      <h2 class="days-title">${when === 'Today' || when === 'Yesterday' ? html`${when} <span class="muted">· ${longDay.format(parseDay(date))}</span>` : longDay.format(parseDay(date))}</h2>
      <button type="button" class="icon-btn" aria-label="The day after" title="The day after" disabled=${date >= today} onClick=${() => go(addDays(date, 1), today)}><${Icon} name="chevronRight" /></button>
      <span class="spacer" />
      <input type="date" class="days-pick" value=${date} max=${today} aria-label="Go to a day" onChange=${(e) => e.currentTarget.value && go(e.currentTarget.value, today)} />
      ${date !== today && html`<button type="button" class="btn sm" onClick=${() => go(today, today)}>Today</button>`}
    </div>

    <div class="days-grid">
      <${Block} title="The day's plan" icon="sparkle" empty=${date === today ? 'No plan yet today: the Overview’s Plan my day makes one.' : 'No plan was kept that day.'}>
        ${plans.day && html`<p class="muted small">Made ${timeFormat.format(new Date(plans.day.at))}${plans.day.by ? ` on ${plans.day.by}` : ''}</p><${PlanBody} entry=${plans.day} />`}
      </${Block}>
      ${plans.week &&
      html`<${Block} title="Review of the week" icon="calendar">
        <p class="muted small">Written ${timeFormat.format(new Date(plans.week.at))}${plans.week.by ? ` on ${plans.week.by}` : ''}</p><${PlanBody} entry=${plans.week} />
      </${Block}>`}
      <${Block} title="Done" icon="check" count=${activity.done.length} empty="Nothing was finished that day.">${rows(activity.done)}</${Block}>
      ${activity.started.length > 0 && html`<${Block} title="Started" icon="arrowRight" count=${activity.started.length}>${rows(activity.started)}</${Block}>`}
      <${Block} title="Added" icon="plus" count=${activity.added.length} empty="Nothing was added that day.">${rows(activity.added)}</${Block}>
      ${activity.comments.length > 0 &&
      html`<${Block} title="Comments" icon="comment" count=${activity.comments.length}>
        <ul class="day-comments">
          ${activity.comments.map(
            ({ item, comment }) => html`<li key=${comment.id}>
              <button type="button" class="day-comment-item" onClick=${() => actions.open(item)}>${item.title}</button>
              <span class="muted small"> · ${comment.by === CLAUDE_AUTHOR ? 'Claude' : 'You'} · ${timeFormat.format(new Date(comment.at))}</span>
              <div class="markdown day-comment-text" dangerouslySetInnerHTML=${{ __html: renderMarkdown(comment.text) }} />
            </li>`,
          )}
        </ul>
      </${Block}>`}
    </div>
  </div>`;
}
