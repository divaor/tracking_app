// The assistant that does things (2.5): its steps, what the model is told, what the looks find, the
// changes to items, projects, tags and release boards, and Undo (field by field: what changed since stays).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDataStep,
  assistantMessages,
  asksHow,
  boardAfter,
  boardChanges,
  changeRows,
  contextText,
  dataChanges,
  describeStep,
  dueFits,
  EXPLAIN_ONLY,
  findItems,
  guideFor,
  lookText,
  MAX_AUTO_ITEMS,
  parsePlan,
  resultsMessage,
  rowsText,
  StepError,
  undoBoardChanges,
  undoDataChanges,
  wordsSoFar,
} from '../app/js/assistantSteps.js';
import { applyBoardChanges, emptyBoard, liveRecords } from '../app/js/boards.js';
import { createItem, liveComments, projectList, upsertProjectRecord } from '../app/js/model.js';

const today = '2026-11-01'; // a Sunday
const now = '2026-11-01T10:00:00.000Z';
const later = '2026-11-01T10:05:00.000Z';
const by = 'Laptop';

function sample() {
  const at = '2026-10-20T09:00:00.000Z';
  const items = [
    createItem({ title: 'Fix the leak', project: 'Kitchen', tags: ['home'], due: '2026-10-30', priority: 'high' }, at),
    createItem({ title: 'Buy parts', project: 'Kitchen', tags: ['home', 'shopping'], due: '2026-11-03' }, at),
    createItem({ title: 'Coal forest layer', project: 'Deep Time', tags: ['layers'], notes: 'The coal forest map' }, at),
    createItem({ title: 'Read the caching proposal', type: 'doc', kind: 'proposal', project: 'Deep Time' }, at),
    createItem({ title: 'Old idea', type: 'idea', status: 'done' }, at),
    createItem({ title: 'Call the plumber', project: 'Kitchen', due: '2026-11-05', status: 'in_progress' }, at),
  ];
  const projects = upsertProjectRecord([], 'Kitchen', { area: 'personal' }, at);
  return { items, projects };
}
const byTitle = (data, title) => data.items.find((i) => i.title === title && !i.deleted);

test('steps from the model are checked, described and given a risk', () => {
  const titles = { titleOf: (id) => ({ a1: 'Fix the leak' })[id], projectOf: (name) => (name === 'Kitchen' ? { name: 'Kitchen', total: 3 } : null), tagCount: () => 4 };
  const find = describeStep({ op: 'find', query: 'leak', due: 'overdue', why: 'see them' }, titles);
  assert.equal(find.look, true);
  assert.equal(find.risk, 'look');
  assert.equal(find.text, 'Find items: “leak”, due overdue');
  assert.equal(find.why, 'see them');
  assert.equal(describeStep({ op: 'update-items', items: [{ id: 'a1', due: '2026-11-09' }] }, titles).text, 'Change “Fix the leak”: due 2026-11-09');
  const few = describeStep({ op: 'update-items', items: Array.from({ length: MAX_AUTO_ITEMS }, (_, n) => ({ id: `i${n}`, add_tags: ['x'] })) });
  assert.equal(few.risk, 'auto');
  assert.equal(few.text, `Change ${MAX_AUTO_ITEMS} items: +#x`);
  assert.equal(describeStep({ op: 'update-items', items: Array.from({ length: MAX_AUTO_ITEMS + 1 }, (_, n) => ({ id: `i${n}`, status: 'done' })) }).risk, 'ask', 'many items: asked first');
  assert.equal(describeStep({ op: 'delete-items', ids: ['a1'] }, titles).risk, 'danger');
  assert.equal(describeStep({ op: 'save-project', name: 'Kitchen', area: 'personal' }, titles).text, 'Change the project Kitchen (personal)');
  assert.equal(describeStep({ op: 'save-project', name: 'Garden' }, titles).text, 'Create the project Garden');
  assert.equal(describeStep({ op: 'rename-project', name: 'Kitchen', to: 'House' }, titles).text, 'Rename the project Kitchen to House (its 3 items move along)');
  assert.equal(describeStep({ op: 'rename-project', name: 'Kitchen', to: 'House' }).risk, 'ask');
  assert.equal(describeStep({ op: 'delete-tag', tag: '#home' }, titles).text, 'Take #home off 4 items');
  // Release boards: removing records is deleting, closing a release or deciding is asked.
  assert.equal(describeStep({ op: 'update-board', project: 'Deep Time', changes: [{ part: 'tests', id: 't1', set: { status: 'passed' } }], log: 'Passed' }).risk, 'auto');
  assert.equal(describeStep({ op: 'update-board', project: 'Deep Time', changes: [{ part: 'releases', id: 'v1', set: { status: 'closed' } }] }).risk, 'ask');
  assert.equal(describeStep({ op: 'update-board', project: 'Deep Time', changes: [{ part: 'features', id: 'f1', remove: true }] }).risk, 'danger');
  assert.equal(describeStep({ op: 'tick', project: 'Deep Time', release: '2.3', step: 'Built' }).text, 'Tick done on Deep Time\'s board: 2.3 step “Built”');
  assert.equal(describeStep({ op: 'decide', project: 'Deep Time', id: 'd1', choice: 'Yes' }).risk, 'ask');
  // What is wrong is said, not run.
  assert.match(describeStep({ op: 'drop-table' }).problem, /not a step the assistant can do/);
  assert.match(describeStep({ op: 'find', due: 'someday' }).problem, /"due" must be/);
  assert.match(describeStep({ op: 'add-items', items: [{ notes: 'no title' }] }).problem, /needs a "title"/);
  assert.match(describeStep({ op: 'update-items', items: [{ status: 'done' }] }).problem, /needs the item's "id"/);
  assert.match(describeStep({ op: 'tick', project: 'Deep Time', step: 2 }).problem, /needs its "release"/);
  assert.match(describeStep({ op: 'update-board', project: 'Deep Time', changes: [{ part: 'bugs', id: 'x', set: {} }] }).problem, /needs a "part"/);
  assert.match(describeStep({ op: 'add-items', items: Array.from({ length: 31 }, () => ({ title: 'x' })) }).problem, /at most 30/);
});

test('the reply: words and steps apart; problems listed, json fences with steps count too', () => {
  const reply = 'Let me look first.\n\n```tracker-steps\n[{ "op": "find", "query": "kitchen" }, { "op": "nope" }]\n```\n';
  const plan = parsePlan(reply);
  assert.equal(plan.text, 'Let me look first.');
  assert.deepEqual(plan.steps.map((s) => s.op), ['find']);
  assert.deepEqual(plan.problems, ['“nope” is not a step the assistant can do']);
  assert.deepEqual(parsePlan('```json\n{ "op": "make-plan", "kind": "day" }\n```').steps.map((s) => s.op), ['make-plan']);
  assert.deepEqual(parsePlan('Here is JSON:\n```json\n{ "a": 1 }\n```').steps, [], 'other JSON stays in the answer');
  assert.match(parsePlan('Here is JSON:\n```json\n{ "a": 1 }\n```').text, /"a": 1/);
  assert.deepEqual(parsePlan('```tracker-steps\n[{ "op": \n```').problems, ['The steps were not valid JSON.']);
  assert.equal(wordsSoFar('Sure.\n```tracker-steps\n[{ "op": "fi'), 'Sure.');
});

test('finding items: words, type, status, project, tag and due dates', () => {
  const { items } = sample();
  const titles = (f) => findItems(items, f, { today }).map((i) => i.title);
  assert.deepEqual(titles({ due: 'overdue' }), ['Fix the leak']);
  assert.deepEqual(titles({ due: 'next-week', sort: 'due' }), ['Buy parts', 'Call the plumber'], 'Monday to Sunday after this Sunday');
  assert.deepEqual(titles({ due: 'this-week' }), [], 'today is Sunday: the week ends today');
  assert.deepEqual(titles({ due: '2026-11-01..2026-11-04' }), ['Buy parts']);
  assert.deepEqual(titles({ project: 'kitchen', status: 'in_progress' }), ['Call the plumber']);
  assert.deepEqual(titles({ project: 'none', status: 'all' }), ['Old idea']);
  assert.deepEqual(titles({ tag: '#shopping' }), ['Buy parts']);
  assert.deepEqual(titles({ query: 'coal forest' }), ['Coal forest layer']);
  assert.deepEqual(titles({ type: 'doc' }), ['Read the caching proposal']);
  assert.deepEqual(titles({ query: 'idea' }), [], 'open by default');
  assert.equal(dueFits({ due: '' }, 'none', today), true);
});

test('looks: what the model reads back', () => {
  const data = sample();
  const live = data.items;
  const projects = projectList(live, data.projects);
  const board = applyBoardChanges(emptyBoard('Deep Time'), [
    { part: 'releases', id: '2.3', set: { title: 'Layers', status: 'planned', steps: [{ label: 'Built', done: true }, { label: 'Tested', done: false }] } },
    { part: 'tests', id: 't-phone', set: { name: 'Phone playtest', release: '2.3', status: 'pending' } },
    { part: 'actions', id: 'a-try', set: { text: 'Try the layers on the phone', when: 'this week' } },
    { part: 'decisions', id: 'd-map', set: { code: 'D1', title: 'Which map?', status: 'open', options: ['Old', 'New'] } },
  ]).board;
  const env = { items: live, projects, boards: [{ slug: 'deep-time', project: 'Deep Time', board }], shown: live.slice(0, 2), today, now: new Date(now) };
  const found = lookText({ op: 'find', query: 'kitchen' }, env);
  assert.match(found, /^3 items found:/);
  assert.match(found, /“Fix the leak” \[task, pending, high, due 2026-10-30 \(overdue\), Kitchen, #home\]/);
  const item = lookText({ op: 'item', id: byTitle(data, 'Coal forest layer').id }, env);
  assert.match(item, /Title: Coal forest layer/);
  assert.match(item, /The coal forest map/);
  assert.throws(() => lookText({ op: 'item', id: 'nope' }, env), StepError);
  assert.match(lookText({ op: 'shown' }, env), /^2 items on screen:/);
  assert.match(lookText({ op: 'shown' }, { ...env, shown: null }), /no list/);
  const projectsText = lookText({ op: 'projects' }, env);
  assert.match(projectsText, /- Kitchen · personal · 3 open of 3/);
  assert.match(projectsText, /#home \(2\)/);
  const boardText = lookText({ op: 'board', project: 'deep time' }, env);
  assert.match(boardText, /^Release board of Deep Time\nReleases 0 of 1 out; features 0 of 0 live; tests 0 of 1 passed; 1 waiting on the person; 1 decisions open\./);
  assert.match(boardText, /- 2\.3 “Layers” \[planned\] · steps:/);
  assert.match(boardText, /steps: 0 ✓ Built; 1 ○ Tested/);
  assert.match(boardText, /a-try: Try the layers on the phone \(this week\)/);
  assert.match(boardText, /d-map \(D1\): Which map\? — options: Old \| New/);
  assert.match(lookText({ op: 'board', project: 'Kitchen' }, env), /Kitchen has no release board/);
  const records = lookText({ op: 'board-records', project: 'Deep Time', part: 'tests', query: 'phone' }, env);
  assert.match(records, /"id": "t-phone"/);
  assert.doesNotMatch(records, /updatedAt/);
  const waiting = lookText({ op: 'waiting' }, env);
  assert.match(waiting, /Deep Time: a-try: Try the layers on the phone/);
  assert.match(waiting, /1 overdue item:/);
  assert.match(waiting, /documents to read/);
});

test('adding items: project and tag spellings kept, fields checked', () => {
  const data = sample();
  const next = applyDataStep(data, { op: 'add-items', items: [{ title: 'Seal the window', project: 'kitchen', tags: ['HOME', 'diy'], due: '2026-11-02' }, { title: 'Paint idea', type: 'idea' }] }, { now, by });
  assert.equal(next.items.length, data.items.length + 2);
  const added = next.items.at(-2);
  assert.equal(added.project, 'Kitchen');
  assert.deepEqual(added.tags, ['home', 'diy']);
  assert.equal(added.updatedBy, by);
  assert.equal(next.items.at(-1).type, 'idea');
  assert.equal(next.projects, data.projects);
  assert.throws(() => applyDataStep(data, { op: 'add-items', items: [{ title: 'x', due: '2026-02-30' }] }, { now, by }), /not a date/);
  assert.throws(() => applyDataStep(data, { op: 'add-items', items: [{ title: 'x', kind: 'pr' }] }, { now, by }), /a task has no kind/);
  assert.throws(() => applyDataStep(data, { op: 'add-items', items: [{ title: 'x', status: 'later' }] }, { now, by }), /status must be/);
});

test('changing items: several fields, tags added and removed, notes added, nothing written when nothing changes', () => {
  const data = sample();
  const leak = byTitle(data, 'Fix the leak');
  const parts = byTitle(data, 'Buy parts');
  const next = applyDataStep(
    data,
    {
      op: 'update-items',
      items: [
        { id: leak.id, due: '2026-11-09', add_tags: ['Plumbing'], append_notes: 'Ask about the pipe.' },
        { id: leak.id, priority: 'normal' },
        { id: parts.id, remove_tags: ['shopping'], status: 'done' },
        { id: byTitle(data, 'Coal forest layer').id, add_tags: ['layers'] },
      ],
    },
    { now, by },
  );
  const leak2 = next.items.find((i) => i.id === leak.id);
  assert.equal(leak2.due, '2026-11-09');
  assert.deepEqual(leak2.tags, ['home', 'Plumbing']);
  assert.equal(leak2.notes, 'Ask about the pipe.');
  assert.equal(leak2.priority, 'normal', 'two updates of one item add up');
  const parts2 = next.items.find((i) => i.id === parts.id);
  assert.deepEqual(parts2.tags, ['home']);
  assert.equal(parts2.status, 'done');
  assert.ok(parts2.completedAt);
  assert.equal(next.items.find((i) => i.title === 'Coal forest layer'), byTitle(data, 'Coal forest layer'), 'a tag it already has: left as it is');
  assert.throws(() => applyDataStep(data, { op: 'update-items', items: [{ id: 'gone', status: 'done' }] }, { now, by }), /There is no item “gone”/);
  const doc = byTitle(data, 'Read the caching proposal');
  const asTask = applyDataStep(data, { op: 'update-items', items: [{ id: doc.id, type: 'task' }] }, { now, by }).items.find((i) => i.id === doc.id);
  assert.equal(asTask.kind, '', 'another type drops the kind');
  const reviewed = applyDataStep(data, { op: 'update-items', items: [{ id: doc.id, decision: 'approved', feedback: 'Looks good' }] }, { now, by }).items.find((i) => i.id === doc.id);
  assert.equal(reviewed.decision, 'approved');
  assert.equal(reviewed.feedback, 'Looks good');
});

test('Undo puts back what a step changed, field by field, and leaves what changed since', () => {
  const data = sample();
  const leak = byTitle(data, 'Fix the leak');
  const parts = byTitle(data, 'Buy parts');
  const step = { op: 'update-items', items: [{ id: leak.id, due: '2026-11-09', add_tags: ['plumbing'] }, { id: parts.id, due: '2026-11-09' }] };
  const after = applyDataStep(data, step, { now, by });
  const changes = dataChanges(data, after);
  assert.equal(changes.items.length, 2);
  assert.deepEqual(
    changeRows(changes).map((r) => [r.title, r.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`)]),
    [
      ['Fix the leak', ['tags: #home → #home #plumbing', 'due: 2026-10-30 → 2026-11-09']],
      ['Buy parts', ['due: 2026-11-03 → 2026-11-09']],
    ],
  );
  // Meanwhile the person moves Buy parts again and renames the leak.
  const edited = {
    ...after,
    items: after.items.map((i) => (i.id === parts.id ? { ...i, due: '2026-11-20' } : i.id === leak.id ? { ...i, title: 'Fix the big leak' } : i)),
  };
  const undone = undoDataChanges(edited, changes, { now: later, by });
  const leak3 = undone.items.find((i) => i.id === leak.id);
  assert.equal(leak3.due, '2026-10-30');
  assert.deepEqual(leak3.tags, ['home']);
  assert.equal(leak3.title, 'Fix the big leak', 'a field the step did not change stays');
  assert.ok(leak3.updatedAt > after.items.find((i) => i.id === leak.id).updatedAt, 'a new edit, so sync carries it');
  assert.equal(undone.items.find((i) => i.id === parts.id).due, '2026-11-20', 'changed since: left as it is');
  assert.equal(undone.kept, 1);
});

test('Undo of adding, deleting and commenting', () => {
  const data = sample();
  const added = applyDataStep(data, { op: 'add-items', items: [{ title: 'New one' }] }, { now, by });
  const undoAdd = undoDataChanges(added, dataChanges(data, added), { now: later, by });
  assert.equal(undoAdd.items.find((i) => i.id === added.items.at(-1).id).deleted, true);

  const leak = byTitle(data, 'Fix the leak');
  const deleted = applyDataStep(data, { op: 'delete-items', ids: [leak.id] }, { now, by });
  assert.equal(deleted.items.find((i) => i.id === leak.id).deleted, true);
  const back = undoDataChanges(deleted, dataChanges(data, deleted), { now: later, by }).items.find((i) => i.id === leak.id);
  assert.equal(back.deleted, undefined);
  assert.equal(back.title, 'Fix the leak');

  const commented = applyDataStep(data, { op: 'comment', id: leak.id, text: 'Called them, waiting' }, { now, by });
  const withComment = commented.items.find((i) => i.id === leak.id);
  assert.deepEqual(liveComments(withComment).map((c) => [c.by, c.text]), [[by, 'Called them, waiting']]);
  assert.equal(changeRows(dataChanges(data, commented))[0].what, 'commented');
  const uncommented = undoDataChanges(commented, dataChanges(data, commented), { now: later, by }).items.find((i) => i.id === leak.id);
  assert.equal(liveComments(uncommented).length, 0);
  assert.equal(uncommented.comments.length, 1, 'kept as a tombstone, so a merge does not bring it back');
});

test('projects and tags: create, rename (items move along), delete, and back', () => {
  const data = sample();
  const garden = applyDataStep(data, { op: 'save-project', name: 'Garden', area: 'personal', color: '#23845F' }, { now, by });
  const record = garden.projects.find((p) => p.key === 'garden');
  assert.equal(record.area, 'personal');
  assert.equal(record.color, '#23845f');
  assert.equal(applyDataStep(data, { op: 'save-project', name: 'kitchen', area: 'personal' }, { now, by }), data, 'nothing to change');
  const unGarden = undoDataChanges(garden, dataChanges(data, garden), { now: later, by });
  assert.equal(unGarden.projects.find((p) => p.key === 'garden').deleted, true);

  const renamed = applyDataStep(data, { op: 'rename-project', name: 'kitchen', to: 'House' }, { now, by });
  assert.deepEqual(renamed.items.filter((i) => i.project === 'House').map((i) => i.title), ['Fix the leak', 'Buy parts', 'Call the plumber']);
  assert.equal(renamed.projects.find((p) => p.key === 'house').area, 'personal', 'the area moves along');
  const unrenamed = undoDataChanges(renamed, dataChanges(data, renamed), { now: later, by });
  assert.deepEqual(unrenamed.items.filter((i) => i.project === 'Kitchen').map((i) => i.title), ['Fix the leak', 'Buy parts', 'Call the plumber']);
  assert.equal(unrenamed.projects.find((p) => p.key === 'kitchen').deleted, undefined);
  assert.equal(unrenamed.projects.find((p) => p.key === 'house').deleted, true);
  assert.throws(() => applyDataStep(data, { op: 'rename-project', name: 'Nope', to: 'X' }, { now, by }), /There is no project “Nope”/);

  const noProject = applyDataStep(data, { op: 'delete-project', name: 'Deep Time' }, { now, by });
  assert.equal(noProject.items.filter((i) => i.project === 'Deep Time').length, 0);
  assert.equal(byTitle(noProject, 'Coal forest layer').project, '');

  const retagged = applyDataStep(data, { op: 'rename-tag', from: '#HOME', to: 'house' }, { now, by });
  assert.deepEqual(byTitle(retagged, 'Buy parts').tags, ['house', 'shopping']);
  const untagged = applyDataStep(data, { op: 'delete-tag', tag: 'home' }, { now, by });
  assert.deepEqual(byTitle(untagged, 'Buy parts').tags, ['shopping']);
  const backTags = undoDataChanges(untagged, dataChanges(data, untagged), { now: later, by });
  assert.deepEqual(byTitle(backTags, 'Buy parts').tags, ['home', 'shopping']);
  assert.throws(() => applyDataStep(data, { op: 'delete-tag', tag: 'nope' }, { now, by }), /No item has the tag #nope/);
});

test('release boards: started, changed, ticked, decided, and undone field by field', () => {
  const stamp = { at: now, by };
  const started = boardAfter(null, { op: 'update-board', project: 'Reel Ledger', changes: [{ part: 'releases', id: 'v1.1', set: { title: 'Series and books', status: 'planned', steps: [{ label: 'Built', done: false }, { label: 'Released', done: false }] } }], headline: 'Next: v1.1', log: 'Board started' }, stamp);
  assert.equal(started.project, 'Reel Ledger');
  assert.equal(liveRecords(started, 'releases')[0].title, 'Series and books');
  assert.equal(started.now.headline, 'Next: v1.1');
  assert.equal(started.log[0].text, 'Board started');
  assert.equal(boardChanges(null, started).created, true);

  const ticked = boardAfter(started, { op: 'tick', project: 'Reel Ledger', release: 'v1.1', step: 'Built' }, { at: later, by });
  assert.equal(liveRecords(ticked, 'releases')[0].steps[0].done, true);
  const tickChanges = boardChanges(started, ticked);
  assert.deepEqual(
    changeRows(tickChanges).map((r) => [r.part, r.what]),
    [
      ['releases', 'changed'],
      ['log', 'added'],
    ],
  );
  const untick = undoBoardChanges(ticked, tickChanges, { at: '2026-11-01T10:10:00.000Z', by }).board;
  assert.equal(liveRecords(untick, 'releases')[0].steps[0].done, false);
  assert.equal(liveRecords(untick, 'log').length, 1, 'its log line goes too');

  // A record removed comes back; one changed since keeps what changed.
  const withFeature = applyBoardChanges(started, [{ part: 'features', id: 'f-series', set: { name: 'Series', status: 'planned', comments: [] } }], stamp).board;
  const removed = boardAfter(withFeature, { op: 'update-board', project: 'Reel Ledger', changes: [{ part: 'features', id: 'f-series', remove: true }] }, { at: later, by });
  assert.equal(liveRecords(removed, 'features').length, 0);
  const restored = undoBoardChanges(removed, boardChanges(withFeature, removed), { at: '2026-11-01T10:10:00.000Z', by }).board;
  assert.equal(liveRecords(restored, 'features')[0].name, 'Series');

  const passed = boardAfter(withFeature, { op: 'update-board', project: 'Reel Ledger', changes: [{ part: 'features', id: 'f-series', set: { status: 'live', what: 'Series of books' } }, { part: 'features', id: 'f-series', comment: 'Done on the phone too' }] }, { at: later, by });
  const passedChanges = boardChanges(withFeature, passed);
  const meanwhile = applyBoardChanges(passed, [{ part: 'features', id: 'f-series', set: { what: 'Series, as a shelf' } }], { at: '2026-11-01T10:07:00.000Z', by: 'Claude' }).board;
  const { board: back, kept } = undoBoardChanges(meanwhile, passedChanges, { at: '2026-11-01T10:10:00.000Z', by });
  const feature = liveRecords(back, 'features')[0];
  assert.equal(feature.status, 'planned');
  assert.equal(feature.what, 'Series, as a shelf', 'changed since by a Claude session: stays');
  assert.equal(kept, 1);
  assert.equal(feature.comments.filter((c) => !c.deleted).length, 0, 'the comment it added is deleted');

  const decided = boardAfter(applyBoardChanges(started, [{ part: 'decisions', id: 'd1', set: { title: 'Covers?', status: 'open', choice: 'Covers or not', options: ['Yes', 'No'] } }], stamp).board, { op: 'decide', project: 'Reel Ledger', id: 'd1', choice: 'Yes' }, { at: later, by });
  assert.equal(liveRecords(decided, 'decisions')[0].status, 'decided');
  assert.throws(() => boardAfter(started, { op: 'decide', project: 'Reel Ledger', id: 'nope', choice: 'Yes' }, stamp), StepError);
  assert.throws(() => boardAfter(null, { op: 'tick', project: 'X', action: 'a' }, stamp), /X has no release board/);
});

test('what the model is told: the picture, the steps, Only explain, the guide', () => {
  const data = sample();
  const context = contextText({ today, time: '11:00', items: data.items, projects: projectList(data.items, data.projects), boards: [{ project: 'Deep Time' }], screen: { label: 'All items · Tasks', shown: 4 }, open: { id: 'x1', title: 'Fix the leak', type: 'task', project: 'Kitchen' } });
  assert.match(context, /^Today: Sunday 2026-11-01, 11:00/);
  assert.match(context, /\nItems: 6 \(5 open: 4 tasks, 1 documents to read; 1 overdue\)\.\n/);
  assert.match(context, /Projects \(name · area · open\/total items\): Kitchen · personal · 3\/3; Deep Time · 2\/2\./);
  assert.match(context, /Kitchen · personal · 3\/3/);
  assert.match(context, /#home \(2\)/);
  assert.match(context, /Release boards: Deep Time\./);
  assert.match(context, /On screen: All items · Tasks \(4 items shown; the step "shown" lists them\)/);
  assert.match(context, /The item open: x1 “Fix the leak” \(task, Kitchen\)/);
  const guide = '# Guide\n\n## 7. Opening and editing an item\n\n### Files and pictures\n\nAttach under the notes, or Photo on a phone.\n\n## 14. Sync\n\nSync now.';
  const [system, user] = assistantMessages('How do I attach a photo?', context, [], { explainOnly: true, guide });
  assert.match(system.content, /```tracker-steps/);
  assert.match(system.content, /- update-items .* — auto \(more than 5 items: ask\)/);
  assert.match(system.content, /- delete-items .* — danger/);
  assert.match(system.content, /The tracker's guide/);
  assert.ok(user.content.includes(EXPLAIN_ONLY));
  assert.match(user.content, /<tracker>\nToday: Sunday/);
  const local = assistantMessages('How do I attach a photo?', context, [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }], { excerpts: guideFor(guide, 'How do I attach a photo?') });
  assert.equal(local.length, 4);
  assert.doesNotMatch(local[0].content, /The tracker's guide/);
  assert.match(local[3].content, /<guide>\n### Files and pictures/);
  assert.equal(guideFor(guide, 'the weather'), '');
  assert.equal(asksHow('How do I attach a photo?'), true);
  assert.equal(asksHow('Move my overdue tasks to next week'), false);
  assert.equal(asksHow('¿Cómo adjunto una foto'), true);
});

test('results go back to the model with the ids of what changed', () => {
  const data = sample();
  const added = applyDataStep(data, { op: 'add-items', items: [{ title: 'Seal the window', project: 'Kitchen' }] }, { now, by });
  const rows = changeRows(dataChanges(data, added));
  const text = rowsText(rows);
  assert.match(text, new RegExp(`^- added ${added.items.at(-1).id} “Seal the window”$`));
  assert.equal(rowsText([]), 'Nothing changed (it was already so).');
  const message = resultsMessage([
    { op: 'find', text: 'Find items', status: 'ok', output: '1 item found' },
    { op: 'add-items', text: 'Add 1 item', status: 'ok', output: text },
    { op: 'delete-items', text: 'Delete 1 item', status: 'skipped' },
    { op: 'update-items', text: 'Change 2 items', status: 'failed', output: 'There is no item “x”' },
  ]);
  assert.match(message, /^Results of the steps:\n1\. find: Find items — done\n1 item found/);
  assert.match(message, /3\. delete-items: Delete 1 item — skipped by the person/);
  assert.match(message, /4\. update-items: Change 2 items — FAILED\nThere is no item “x”/);
});
