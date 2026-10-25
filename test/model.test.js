import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatch,
  bumpTime,
  checklistProgress,
  cleanTags,
  createItem,
  diffCounts,
  fileKind,
  filterItems,
  formatBytes,
  mergeItems,
  normalizeItem,
  parseDocument,
  parseQuickAdd,
  pruneTombstones,
  reviveItem,
  safeFileName,
  serializeDocument,
  slugify,
  sortItems,
  titleFromMarkdown,
  toggleChecklistItem,
  tombstone,
} from '../app/js/model.js';

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-01T11:00:00.000Z';
const T2 = '2026-10-01T12:00:00.000Z';

test('createItem fills defaults and timestamps', () => {
  const item = createItem({ title: '  Write spec  ', tags: '#work, Work, home' }, T0);
  assert.equal(item.title, 'Write spec');
  assert.equal(item.type, 'task');
  assert.equal(item.status, 'pending');
  assert.equal(item.priority, 'normal');
  assert.deepEqual(item.tags, ['work', 'home']);
  assert.equal(item.createdAt, T0);
  assert.equal(item.updatedAt, T0);
  assert.match(item.id, /^[a-z0-9]+-[0-9a-f]{16}$/);
});

test('normalizeItem rejects invalid values and keeps unknown fields', () => {
  const item = normalizeItem({ id: 'a', type: 'nope', status: 'weird', priority: 'toString', kind: 'pr', due: '2026/10/01', futureField: 42 });
  assert.equal(item.type, 'task');
  assert.equal(item.status, 'pending');
  assert.equal(item.priority, 'normal');
  assert.equal(item.kind, '', 'kind "pr" is only valid for Claude work');
  assert.equal(item.due, '');
  assert.equal(item.futureField, 42);
  assert.equal(normalizeItem({ id: 'b', type: 'claude', kind: 'pr' }).kind, 'pr');
});

test('applyPatch tracks started/completed and always moves updatedAt forward', () => {
  const item = createItem({ title: 'x' }, T0);
  const started = applyPatch(item, { status: 'in_progress' }, T1);
  assert.equal(started.startedAt, T1);
  assert.equal(started.completedAt, '');
  const done = applyPatch(started, { status: 'done' }, T2);
  assert.equal(done.completedAt, T2);
  const reopened = applyPatch(done, { status: 'pending' }, T2);
  assert.equal(reopened.completedAt, '');
  assert.ok(reopened.updatedAt > done.updatedAt, 'same-millisecond edit still wins');

  const fromFuture = { ...item, updatedAt: '2030-01-01T00:00:00.000Z' };
  assert.ok(applyPatch(fromFuture, { title: 'y' }, T1).updatedAt > fromFuture.updatedAt);
  assert.equal(bumpTime(T0, T1), T1);
});

test('mergeItems: last write wins per item, deletions win ties, order independent', () => {
  const a = createItem({ title: 'A' }, T0);
  const aEdited = applyPatch(a, { title: 'A2' }, T1);
  const b = createItem({ title: 'B' }, T0);
  const bDeleted = tombstone(b, T1);
  const left = mergeItems([a, b], [aEdited, bDeleted]);
  const right = mergeItems([aEdited, bDeleted], [a, b]);
  assert.deepEqual(serializeDocument(left), serializeDocument(right));
  assert.equal(left.find((i) => i.id === a.id).title, 'A2');
  assert.equal(left.find((i) => i.id === b.id).deleted, true);

  const tieDeleted = { id: b.id, type: 'task', deleted: true, createdAt: T0, updatedAt: T0 };
  assert.equal(mergeItems([b], [tieDeleted])[0].deleted, true);
  assert.equal(mergeItems([tieDeleted], [b])[0].deleted, true);
});

test('reviveItem restores a deleted item with a newer timestamp than its tombstone', () => {
  const item = createItem({ title: 'Keep me' }, T0);
  const dead = tombstone(item, T1);
  const alive = reviveItem(item, dead, T1);
  assert.ok(alive.updatedAt > dead.updatedAt);
  assert.equal(mergeItems([dead], [alive])[0].title, 'Keep me');
});

test('pruneTombstones drops only old deletions', () => {
  const now = '2026-10-20T00:00:00.000Z';
  const old = { id: 'old', type: 'task', deleted: true, createdAt: T0, updatedAt: '2026-01-01T00:00:00.000Z' };
  const recent = { id: 'new', type: 'task', deleted: true, createdAt: T0, updatedAt: '2026-10-10T00:00:00.000Z' };
  const live = createItem({ title: 'live' }, '2025-01-01T00:00:00.000Z');
  assert.deepEqual(pruneTombstones([old, recent, live], now).map((i) => i.id), ['new', live.id]);
});

test('serializeDocument is stable and parseDocument round-trips', () => {
  const items = [createItem({ title: 'b' }, T1), createItem({ title: 'a', notes: 'ünïcødé ✓ 🚀' }, T0)];
  const text = serializeDocument(items);
  assert.equal(text, serializeDocument([...items].reverse()));
  const parsed = parseDocument(text);
  assert.deepEqual(parsed.map((i) => i.title), ['a', 'b']);
  assert.equal(parsed[0].notes, 'ünïcødé ✓ 🚀');
  assert.equal(JSON.parse(text).updatedAt, T1);
  assert.throws(() => parseDocument('{nope'), /not valid JSON/);
  assert.throws(() => parseDocument('{"foo": 1}'), /no "items"/);
  assert.equal(parseDocument('[{"id":"x","title":"from array"}]')[0].title, 'from array');
});

test('diffCounts reports added, updated and deleted items', () => {
  const a = createItem({ title: 'a' }, T0);
  const b = createItem({ title: 'b' }, T0);
  const c = createItem({ title: 'c' }, T0);
  const after = [applyPatch(a, { title: 'a2' }, T1), tombstone(b, T1), c];
  assert.deepEqual(diffCounts([a, b], after), { added: 1, updated: 1, deleted: 1 });
});

test('filterItems matches text, #tags, type and status', () => {
  const items = [
    createItem({ title: 'Review PR', type: 'claude', tags: ['work'], status: 'in_progress' }, T0),
    createItem({ title: 'Read design doc', type: 'doc', notes: 'about caching' }, T0),
    createItem({ title: 'Buy milk', tags: ['home'] }, T0),
  ];
  assert.deepEqual(filterItems(items, { query: '#wor' }).map((i) => i.title), ['Review PR']);
  assert.deepEqual(filterItems(items, { query: 'caching' }).map((i) => i.title), ['Read design doc']);
  assert.deepEqual(filterItems(items, { type: 'task' }).map((i) => i.title), ['Buy milk']);
  assert.deepEqual(filterItems(items, { status: 'in_progress' }).map((i) => i.title), ['Review PR']);
  assert.equal(filterItems([tombstone(items[0], T1)], {}).length, 0);
});

test('sortItems smart order: in progress, then pending by priority and due, then done', () => {
  const items = [
    createItem({ title: 'done', status: 'done' }, T0),
    createItem({ title: 'low', priority: 'low' }, T0),
    createItem({ title: 'urgent', priority: 'urgent' }, T0),
    createItem({ title: 'due soon', due: '2026-10-21' }, T0),
    createItem({ title: 'active', status: 'in_progress' }, T0),
    createItem({ title: 'no due' }, T0),
  ];
  assert.deepEqual(sortItems(items).map((i) => i.title), ['active', 'urgent', 'due soon', 'no due', 'low', 'done']);
  assert.deepEqual(sortItems(items, 'title').map((i) => i.title)[0], 'active');
});

test('parseQuickAdd extracts tags, priority, due date and links', () => {
  const today = '2026-10-20';
  assert.deepEqual(parseQuickAdd('Write report #work #q4 !high @tomorrow', today), {
    title: 'Write report',
    tags: ['work', 'q4'],
    priority: 'high',
    due: '2026-10-21',
  });
  assert.deepEqual(parseQuickAdd('Ship it !! @2026-11-02', today), { title: 'Ship it', priority: 'urgent', due: '2026-11-02' });
  const withLink = parseQuickAdd('Read https://example.com/docs/intro#part-2 later', today);
  assert.equal(withLink.url, 'https://example.com/docs/intro#part-2');
  assert.equal(withLink.title, 'Read later');
  assert.equal(withLink.tags, undefined, 'URL fragments are not tags');
  assert.equal(parseQuickAdd('https://claude.ai/artifact/abc', today).title, 'claude.ai – abc');
  assert.equal(parseQuickAdd('Email bob@example.com', today).title, 'Email bob@example.com');
});

test('cleanTags dedupes case-insensitively and strips #', () => {
  assert.deepEqual(cleanTags(['#A', 'a', ' b c ', '', 'B-C']), ['A', 'b-c']);
});

test('checklists: progress and toggling skip code fences', () => {
  const md = ['# Plan', '- [ ] one', '- [x] two', '```', '- [ ] not a task', '```', '1. [ ] three', '> - [X] quoted'].join('\n');
  assert.deepEqual(checklistProgress(md), { done: 2, total: 4 });
  const toggled = toggleChecklistItem(md, 2);
  assert.match(toggled, /1\. \[x\] three/);
  assert.match(toggled, /- \[ \] not a task/);
  assert.match(toggleChecklistItem(md, 1), /- \[ \] two/);
  assert.equal(toggleChecklistItem(md, 99), md);
});

test('titleFromMarkdown uses the first heading', () => {
  assert.equal(titleFromMarkdown('intro\n## Design notes ##\n# Later'), 'Design notes');
  assert.equal(titleFromMarkdown('no heading', 'fallback'), 'fallback');
});

test('files and review fields are normalized', () => {
  const item = normalizeItem({
    id: 'f',
    type: 'doc',
    kind: 'proposal',
    decision: 'maybe',
    feedback: 7,
    files: [{ path: 'files/a/p.md', size: 12, sha: 'abc' }, { path: 'files/a/p.md' }, { name: 'no path' }, null],
  });
  assert.equal(item.kind, 'proposal');
  assert.equal(item.decision, '');
  assert.equal(item.feedback, '7');
  assert.deepEqual(item.files, [{ path: 'files/a/p.md', name: 'p.md', size: 12, sha: 'abc', addedAt: '' }]);
  assert.equal(normalizeItem({ id: 'g', decision: 'approved' }).decision, 'approved');
  assert.deepEqual(filterItems([item], { query: 'p.md' }).map((i) => i.id), ['f']);
});

test('slugify, safeFileName, fileKind and formatBytes', () => {
  assert.equal(slugify('  Café: Sync Design v2!! '), 'cafe-sync-design-v2');
  assert.equal(slugify('***'), 'item');
  assert.equal(slugify('a'.repeat(80)).length, 48);
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('my report (final).md'), 'my-report-final.md');
  assert.equal(safeFileName('..', 'x.md'), 'x.md');
  assert.equal(safeFileName(''), 'document.md');
  assert.equal(fileKind('README.MD'), 'markdown');
  assert.equal(fileKind('page.htm'), 'html');
  assert.equal(fileKind('logo.svg'), 'svg');
  assert.equal(fileKind('main.py'), 'text');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('pinned items: stored only when set, first by project, filtered like the rest', async () => {
  const { normalizeItem, applyPatch, pinnedFirst, filterItems, projectList, serializeDocument } = await import('../app/js/model.js');
  const a = normalizeItem({ id: 'a', title: 'A', project: 'Zeta', pinned: true });
  assert.equal(a.pinned, true);
  assert.equal('pinned' in normalizeItem({ id: 'b', title: 'B', pinned: 'true' }), false);
  assert.equal('pinned' in applyPatch(a, { pinned: false }), false);
  assert.ok(!serializeDocument([normalizeItem({ id: 'c', title: 'C' })]).includes('pinned'), 'old files do not change');

  const items = [
    normalizeItem({ id: '1', title: 'one' }),
    normalizeItem({ id: '2', title: 'two', pinned: true }),
    normalizeItem({ id: '3', title: 'three', project: 'beta', pinned: true }),
    a,
  ];
  // Pinned first, grouped by project name (those without one last), the rest as given.
  assert.deepEqual(pinnedFirst(items).map((i) => i.id), ['3', 'a', '2', '1']);

  // The filters apply to pinned items as to any other: type, status, #tag, +project, words.
  const pool = [
    normalizeItem({ id: 'p', type: 'idea', status: 'done', title: 'Pinned idea', project: 'Work', tags: ['x'], pinned: true }),
    normalizeItem({ id: 't', type: 'task', title: 'Task', project: 'Work', tags: ['y'] }),
  ];
  const ids = (opts) => filterItems(pool, opts).map((i) => i.id);
  assert.deepEqual(ids({ type: 'task', status: 'pending' }), ['t']);
  assert.deepEqual(ids({ type: 'idea' }), ['p']);
  assert.deepEqual(ids({ query: '#y' }), ['t']);
  assert.deepEqual(ids({ query: '#x' }), ['p']);
  assert.deepEqual(ids({ query: '+work' }), ['p', 't']);
  assert.deepEqual(ids({ query: 'task' }), ['t']);
  // …and those that match come first.
  assert.deepEqual(pinnedFirst(filterItems([...pool].reverse(), { query: '+work' })).map((i) => i.id), ['p', 't']);
  // The setting pinnedPastFilters (keepPinned): pinned items pass the type, status and #tag
  // filters, but not words searched for or another +project.
  const kept = (opts) => filterItems(pool, { keepPinned: true, ...opts }).map((i) => i.id);
  assert.deepEqual(kept({ type: 'task', status: 'pending' }), ['p', 't']);
  assert.deepEqual(kept({ query: '#y' }), ['p', 't']);
  assert.deepEqual(kept({ query: 'task' }), ['t']);
  assert.deepEqual(kept({ query: '+other' }), []);

  const projects = projectList([...items, ...pool]);
  assert.equal(projects.find((p) => p.key === 'zeta').pinned, 1);
  assert.equal(projects.find((p) => p.key === 'work').pinned, 1);
});
