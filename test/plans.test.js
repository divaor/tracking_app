import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMessages } from '../app/js/assist.js';
import { addCommentPatch, createItem } from '../app/js/model.js';
import {
  changedSince,
  changesSince,
  dateOfPlanPath,
  dayActivity,
  describeChanges,
  doneByDay,
  emptyPlans,
  MAX_VERSIONS,
  mergePlans,
  parsePlans,
  planPath,
  planVersions,
  serializePlans,
  withPlan,
} from '../app/js/plans.js';

// Local times, so the days are the same in any time zone.
const at = (day, hour, minute = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute).toISOString();
};
const today = '2026-10-30';
const version = (text, hour, by = 'Test PC') => ({ text, at: at(today, hour), by, model: 'some-model' });

test('a day\'s plans are kept in plans/<month>/<day>.json', () => {
  assert.equal(planPath('2026-10-30'), 'plans/2026-10/2026-10-30.json');
  assert.equal(dateOfPlanPath('plans/2026-10/2026-10-30.json'), '2026-10-30');
  assert.equal(dateOfPlanPath('files/x.md'), null);
  assert.deepEqual(emptyPlans(today), { date: today, day: null, week: null });
});

test('a new version keeps the one it replaces, newest first, a limited number', () => {
  let plans = withPlan(emptyPlans(today), 'day', version('First', 8));
  assert.equal(plans.day.text, 'First');
  assert.deepEqual(plans.day.versions, []);
  plans = withPlan(plans, 'day', version('Second', 11));
  plans = withPlan(plans, 'day', version('Third', 14));
  assert.equal(plans.day.text, 'Third');
  assert.deepEqual(plans.day.versions.map((v) => v.text), ['Second', 'First']);
  assert.deepEqual(planVersions(plans.day).map((v) => v.text), ['Third', 'Second', 'First']);
  assert.equal(plans.week, null, 'the week review is apart');
  plans = withPlan(plans, 'week', version('A good week', 15));
  assert.equal(plans.week.text, 'A good week');
  assert.equal(plans.day.text, 'Third');

  let many = emptyPlans(today);
  for (let n = 0; n < MAX_VERSIONS + 5; n++) many = withPlan(many, 'day', { text: `v${n}`, at: at(today, 6, n), by: 'x' });
  assert.equal(many.day.versions.length, MAX_VERSIONS);
  assert.equal(many.day.versions[0].text, `v${MAX_VERSIONS + 3}`);

  assert.equal(withPlan(plans, 'month', version('x', 9)), plans, 'only day and week');
  assert.equal(withPlan(plans, 'day', { text: '  ', at: at(today, 9) }), plans, 'nothing to keep');
  assert.equal(withPlan(plans, 'day', { text: 'x', at: 'later' }), plans, 'no time');
});

test('two devices saving at once: every version of both, the latest on top', () => {
  const base = withPlan(emptyPlans(today), 'day', version('Morning', 8));
  const laptop = withPlan(base, 'day', version('From the laptop', 11, 'Laptop'));
  const phone = withPlan(withPlan(base, 'day', version('From the phone', 12, 'Phone')), 'week', version('Week', 12, 'Phone'));
  const merged = mergePlans(laptop, phone);
  assert.equal(merged.day.text, 'From the phone');
  assert.deepEqual(merged.day.versions.map((v) => v.text), ['From the laptop', 'Morning'], 'the morning plan once');
  assert.equal(merged.week.text, 'Week');
  assert.deepEqual(mergePlans(phone, laptop), merged, 'either way round');
  assert.deepEqual(mergePlans(emptyPlans(today), emptyPlans(today)), emptyPlans(today));
});

test('a plans file is read tolerantly and written back the same', () => {
  const plans = withPlan(withPlan(emptyPlans(today), 'day', version('One', 8)), 'day', version('Two', 9));
  assert.deepEqual(parsePlans(serializePlans(plans), today), plans);
  assert.deepEqual(parsePlans('{ not json', today), emptyPlans(today));
  assert.deepEqual(parsePlans(null, today), emptyPlans(today));
  const odd = parsePlans(JSON.stringify({ day: { text: 'Kept', at: at(today, 9), versions: [{ text: '' }, 'x', { text: 'Old', at: at(today, 7) }] }, week: { text: 'No time' } }), today);
  assert.equal(odd.day.text, 'Kept');
  assert.deepEqual(odd.day.versions.map((v) => v.text), ['Old']);
  assert.equal(odd.week, null);
  assert.equal(odd.date, today);
});

test('what changed since a plan was made', () => {
  const made = at(today, 9);
  const items = [
    { ...createItem({ title: 'Finished after' }, at(today, 7)), status: 'done', completedAt: at(today, 10) },
    { ...createItem({ title: 'Finished before' }, at(today, 7)), status: 'done', completedAt: at(today, 8) },
    { ...createItem({ title: 'Started after' }, at(today, 7)), status: 'in_progress', startedAt: at(today, 11) },
    createItem({ title: 'Added after' }, at(today, 12)),
    createItem({ title: 'Was due yesterday', due: '2026-10-29' }, at('2026-10-20', 9)),
    createItem({ title: 'Long overdue', due: '2026-10-01' }, at('2026-09-20', 9)),
    { ...createItem({ title: 'Gone' }, at(today, 12)), deleted: true },
  ];
  const changes = changesSince(items, made, today);
  assert.deepEqual(changes.done.map((i) => i.title), ['Finished after']);
  assert.deepEqual(changes.started.map((i) => i.title), ['Started after']);
  assert.deepEqual(changes.added.map((i) => i.title), ['Added after']);
  assert.deepEqual(changesSince(items, at('2026-10-29', 9), today).overdue.map((i) => i.title), ['Was due yesterday'], 'became overdue since the plan');
  assert.deepEqual(changes.overdue, [], 'already overdue when the plan was made');
  assert.equal(describeChanges(changes), '1 done, 1 started, 1 added');
  assert.equal(changedSince(items, made, today), true);
  assert.equal(changedSince(items, at(today, 13), today), false);
});

test('updating a plan asks with the earlier one and what changed', () => {
  const items = [{ ...createItem({ title: 'Ship the parser' }), status: 'done', completedAt: at(today, 10) }, createItem({ title: 'Write the docs' })];
  const previous = { text: '- First the parser\n', at: at(today, 9) };
  const [, user] = planMessages(items, { kind: 'day', today, previous, changes: { done: [items[0]], started: [], added: [], overdue: [] } });
  assert.match(user.content, /^Update my plan for the rest of today/);
  assert.match(user.content, /The plan from .+:\n- First the parser\n\nDone since then:\n- Ship the parser/);
  assert.doesNotMatch(user.content, /Started since then/);
  assert.match(user.content, /Open items:\n- Write the docs/);
  const quiet = planMessages(items, { kind: 'day', today, previous, changes: { done: [], started: [], added: [], overdue: [] } })[1].content;
  assert.match(quiet, /Nothing changed in the items since then\./);
  const week = planMessages(items, { kind: 'week', today, previous: { text: 'Good week', at: at(today, 9) }, changes: null })[1].content;
  assert.match(week, /^Update my weekly review/);
  assert.match(week, /The review from .+:\nGood week/);
  assert.doesNotMatch(planMessages(items, { kind: 'day', today })[1].content, /Update|since then/, 'a new plan is asked as before');
});

test('what happened on a day, and done per day', () => {
  const yesterday = '2026-10-29';
  let commented = createItem({ title: 'Has comments' }, at('2026-10-01', 9));
  commented = { ...commented, ...addCommentPatch(commented, 'Said today', 'Test PC', at(today, 10)) };
  commented = { ...commented, ...addCommentPatch(commented, 'Answered today', 'Claude', at(today, 11)) };
  commented = { ...commented, ...addCommentPatch(commented, 'Said later', 'Test PC', at('2026-10-31', 9)) };
  const items = [
    { ...createItem({ title: 'Done today' }, at(yesterday, 9)), status: 'done', startedAt: at(today, 9), completedAt: at(today, 15) },
    { ...createItem({ title: 'Done yesterday' }, at('2026-10-20', 9)), status: 'done', completedAt: at(yesterday, 18) },
    { ...createItem({ title: 'Started today' }, at('2026-10-20', 9)), status: 'in_progress', startedAt: at(today, 11) },
    createItem({ title: 'Added today' }, at(today, 8)),
    { ...createItem({ title: 'Deleted' }, at(today, 8)), deleted: true },
    commented,
  ];
  const day = dayActivity(items, today);
  assert.deepEqual(day.done.map((i) => i.title), ['Done today']);
  assert.deepEqual(day.started.map((i) => i.title), ['Started today'], 'started and finished the same day counts as done');
  assert.deepEqual(day.added.map((i) => i.title), ['Added today']);
  assert.deepEqual(day.comments.map((c) => c.comment.text), ['Answered today', 'Said today'], 'newest first, that day only');
  assert.equal(day.comments[0].item.title, 'Has comments');
  assert.deepEqual(dayActivity(items, yesterday).done.map((i) => i.title), ['Done yesterday']);
  assert.deepEqual(dayActivity(items, yesterday).added.map((i) => i.title), ['Done today']);

  const bars = doneByDay(items, today, 7);
  assert.equal(bars.length, 7);
  assert.deepEqual(bars.at(-1), { date: today, done: 1 });
  assert.deepEqual(bars.at(-2), { date: yesterday, done: 1 });
  assert.equal(bars[0].date, '2026-10-24');
  assert.equal(doneByDay(items, today).length, 28);
  assert.equal(doneByDay([], '2026-03-02', 3)[0].date, '2026-02-28', 'across a month');
});
