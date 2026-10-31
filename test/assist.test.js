import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsFor, appendToNotes, describeItem, itemMessages, ITEM_ACTIONS, parseQuickAddReply, planItems, planMessages, quickAddMessages, refinement } from '../app/js/assist.js';
import { createItem } from '../app/js/model.js';

const today = '2026-10-22'; // a Thursday
const ctx = { today, projects: ['Platform', 'Home'], tags: ['GlobalAPI', 'billing'] };

test('quick add in plain language: what the model is told', () => {
  const [system, user] = quickAddMessages('llamar a Ana mañana por la factura, urgente', ctx);
  assert.match(system.content, /Today is Thursday 2026-10-22/);
  assert.match(system.content, /ONLY a JSON object/);
  assert.match(user.content, /Projects: Platform, Home/);
  assert.match(user.content, /Existing tags: GlobalAPI, billing/);
  assert.match(user.content, /llamar a Ana mañana/);
});

test('quick add replies are checked and fitted to what exists', () => {
  const reply = 'Sure!\n```json\n{"type": "task", "title": "Llamar a Ana por la factura", "priority": "urgent", "due": "2026-10-23", "project": "platform", "tags": ["Billing", "calls", "x", "y"], "notes": ""}\n```';
  assert.deepEqual(parseQuickAddReply(reply, ctx), { title: 'Llamar a Ana por la factura', type: 'task', priority: 'urgent', due: '2026-10-23', project: 'Platform', tags: ['billing', 'calls', 'x'] });
  const odd = parseQuickAddReply('{"type": "chore", "title": "Pay rent", "priority": "now", "due": "2026-02-30", "project": "Work stuff", "tags": "rent", "notes": "Pay rent"}', { ...ctx, type: 'idea' });
  assert.deepEqual(odd, { title: 'Pay rent', type: 'idea' }, 'unknown type, priority, project and an impossible date are dropped');
  assert.equal(parseQuickAddReply('{"title": "Old", "due": "2025-01-01"}', ctx).due, undefined, 'long past dates are dropped');
  assert.equal(parseQuickAddReply('no json here', ctx), null);
  assert.equal(parseQuickAddReply('{"title": "  "}', ctx), null);
});

test('what was typed explicitly wins over the model', () => {
  const explicit = { title: 'call Ana tomorrow urgent', type: 'task', project: 'Home', tags: ['calls'] };
  const smart = { title: 'Call Ana', type: 'task', priority: 'urgent', due: '2026-10-23', project: 'Platform', tags: ['billing'], notes: 'About the invoice' };
  assert.deepEqual(refinement(explicit, smart), { title: 'Call Ana', priority: 'urgent', due: '2026-10-23', notes: 'About the invoice' });
  assert.deepEqual(refinement({ ...explicit, priority: 'low', due: '2026-11-01' }, smart).priority, undefined);
  assert.deepEqual(refinement(explicit, null), {});
  assert.deepEqual(refinement({ title: 'x', type: 'task' }, { title: 'x', type: 'task', priority: 'normal' }), {});
  assert.deepEqual(refinement({ title: 'Write report', type: 'task' }, { title: 'Write the report', type: 'task' }), {}, 'a plain title stays as typed');
  assert.equal(refinement({ title: 'x', type: 'idea' }, { title: 'X', type: 'task', priority: 'high' }).type, undefined, 'the type picked stays');
});

test('item actions depend on the kind of item, and see its documents', () => {
  const doc = createItem({ title: 'Caching proposal', type: 'doc', project: 'Platform', notes: 'Please review' });
  const ids = actionsFor(doc).map((a) => a.id);
  assert.ok(ids.includes('feedback') && ids.includes('summarize') && !ids.includes('steps'));
  assert.ok(actionsFor(createItem({ title: 'x', type: 'task' })).some((a) => a.id === 'steps'));
  assert.ok(actionsFor(createItem({ title: 'x', type: 'idea' })).some((a) => a.id === 'plan'));
  const described = describeItem(doc, [{ name: 'proposal.md', text: '# Cache\n\nUse Redis.' }]);
  assert.match(described, /Title: Caching proposal/);
  assert.match(described, /Project: Platform/);
  assert.match(described, /Document proposal\.md:\n<<<\n# Cache/);
  const big = describeItem(doc, [{ name: 'a.md', text: 'a'.repeat(50000) }]);
  assert.ok(big.length < 25000 && big.includes('more characters]'));
  const feedback = ITEM_ACTIONS.find((a) => a.id === 'feedback');
  const history = [{ role: 'assistant', content: 'Looks good.' }, { role: 'user', content: 'Shorter?' }];
  const messages = itemMessages(feedback, doc, [], history);
  assert.equal(messages.length, 4);
  assert.match(messages[1].content, /^Draft my review feedback/);
  assert.equal(appendToNotes('Notes\n\n', '- [ ] one'), 'Notes\n\n- [ ] one');
  assert.equal(appendToNotes('', '  - [ ] one '), '- [ ] one');
});

test('the plan of the day and the weekly review see the right items', () => {
  const items = [
    createItem({ title: 'Overdue report', due: '2026-10-20' }),
    createItem({ title: 'Due Saturday', due: '2026-10-24' }),
    createItem({ title: 'Someday', due: '2026-12-01' }),
    { ...createItem({ title: 'Doing it' }), status: 'in_progress' },
    createItem({ title: 'Urgent thing', priority: 'urgent' }),
    { ...createItem({ title: 'Finished Tuesday' }), status: 'done', completedAt: '2026-10-20T10:00:00.000Z' },
    { ...createItem({ title: 'Finished long ago' }), status: 'done', completedAt: '2026-09-01T10:00:00.000Z' },
  ];
  const day = planItems(items, { kind: 'day', today }).open.map((i) => i.title);
  assert.deepEqual(day.slice(0, 4).sort(), ['Doing it', 'Due Saturday', 'Overdue report', 'Urgent thing'], 'what is pressing comes first');
  assert.equal(day.at(-1), 'Someday', 'then the rest');
  assert.equal(planItems(items, { kind: 'day', today, max: 2 }).open.length, 2);
  const week = planItems(items, { kind: 'week', today });
  assert.deepEqual(week.done.map((i) => i.title), ['Finished Tuesday']);
  const [, user] = planMessages(items, { kind: 'day', today });
  assert.match(user.content, /Today is Thursday 2026-10-22/);
  assert.match(user.content, /Overdue report \[task, pending, due 2026-10-20 \(overdue\)\]/);
  assert.match(planMessages(items, { kind: 'week', today })[1].content, /Done in the last 7 days:\n- Finished Tuesday/);
  // The release boards' lines go in when there are some, and nothing about them when not.
  const boards = 'Release board "Demo":\n- Waiting on me: Run the migration (Mon 11-02)';
  assert.match(planMessages(items, { kind: 'day', today, boards })[1].content, /From my release boards \(take their milestones and what waits on me into account\):\nRelease board "Demo":\n- Waiting on me: Run the migration/);
  assert.doesNotMatch(planMessages(items, { kind: 'day', today })[1].content, /release boards/);
});
