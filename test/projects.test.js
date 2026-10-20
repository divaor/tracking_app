import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createItem,
  deleteProjectRecord,
  matchesQuery,
  matchesScope,
  mergeProjects,
  normalizeProject,
  parseData,
  parseQuickAdd,
  projectKey,
  projectList,
  resolveProjectName,
  retagItems,
  serializeDocument,
  upsertProjectRecord,
} from '../app/js/model.js';
import { syncOnce } from '../app/js/sync.js';

const T0 = '2026-10-20T10:00:00.000Z';
const T1 = '2026-10-20T11:00:00.000Z';

test('project records normalize, upsert and delete by case-insensitive name', () => {
  assert.equal(projectKey('  API   Platform '), 'api platform');
  const p = normalizeProject({ name: ' API  Platform ', area: 'work', color: '#ABCDEF', extra: 1 });
  assert.deepEqual([p.key, p.name, p.area, p.color, p.extra], ['api platform', 'API Platform', 'work', '#abcdef', 1]);
  assert.equal(normalizeProject({ name: 'x', area: 'hobby', color: 'red' }).area, '');

  let list = upsertProjectRecord([], 'Home Reno', { area: 'personal' }, T0, 'Phone');
  list = upsertProjectRecord(list, 'home reno', { color: '#123456' }, T1, 'Laptop');
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].name, list[0].area, list[0].color, list[0].updatedBy], ['Home Reno', 'personal', '#123456', 'Laptop']);
  list = deleteProjectRecord(list, 'HOME RENO', T1);
  assert.equal(list[0].deleted, true);
  assert.ok(list[0].updatedAt > T1, 'deletion is newer than the last edit');
});

test('mergeProjects: last write wins per project key', () => {
  const a = upsertProjectRecord([], 'Infra', { area: 'work' }, T0);
  const b = upsertProjectRecord([], 'infra', { area: 'personal' }, T1);
  assert.equal(mergeProjects(a, b)[0].area, 'personal');
  assert.equal(mergeProjects(b, a)[0].area, 'personal');
});

test('documents carry projects and keep unknown top-level fields', () => {
  const items = [createItem({ title: 'x', project: 'Infra' }, T0)];
  const projects = upsertProjectRecord([], 'Infra', { area: 'work' }, T0);
  const text = serializeDocument(items, projects, { future: { a: 1 }, items: 'ignored' });
  const parsed = parseData(text);
  assert.equal(parsed.projects[0].name, 'Infra');
  assert.deepEqual(parsed.extra, { future: { a: 1 } });
  assert.equal(serializeDocument(parsed.items, parsed.projects, parsed.extra), text, 'stable round trip');
  assert.deepEqual(parseData('{"items":[]}').projects, []);
});

test('projectList merges registry and item projects with counts, work first', () => {
  const items = [
    createItem({ title: 'a', project: 'web app' }, T0),
    createItem({ title: 'b', project: 'Web App', status: 'done' }, T0),
    createItem({ title: 'c', project: 'Garden' }, T0),
    createItem({ title: 'd' }, T0),
  ];
  const registry = [...upsertProjectRecord([], 'Web App', { area: 'work' }, T0), ...upsertProjectRecord([], 'Taxes', { area: 'personal' }, T0)];
  const list = projectList(items, registry);
  assert.deepEqual(list.map((p) => [p.name, p.area, p.open, p.total, p.registered]), [
    ['Web App', 'work', 1, 2, true],
    ['Taxes', 'personal', 0, 0, true],
    ['Garden', '', 1, 1, false],
  ]);
  assert.match(list[2].color, /^#[0-9a-f]{6}$/, 'unregistered projects get a stable color');
  assert.equal(resolveProjectName('web APP', list), 'Web App');
  assert.equal(resolveProjectName('New thing', list), 'New thing');
});

test('scope filter: areas, specific projects and items without a project', () => {
  const byKey = new Map(upsertProjectRecord(upsertProjectRecord([], 'Web App', { area: 'work' }, T0), 'Garden', { area: 'personal' }, T0).map((p) => [p.key, p]));
  const work = createItem({ title: 'w', project: 'web app' }, T0);
  const home = createItem({ title: 'h', project: 'Garden' }, T0);
  const loose = createItem({ title: 'l' }, T0);
  const pick = (scope) => [work, home, loose].filter((i) => matchesScope(i, scope, byKey)).map((i) => i.title);
  assert.deepEqual(pick([]), ['w', 'h', 'l']);
  assert.deepEqual(pick(['area:work']), ['w']);
  assert.deepEqual(pick(['area:personal', 'none']), ['h', 'l']);
  assert.deepEqual(pick(['project:garden', 'project:web app']), ['w', 'h']);
});

test('quick add +project and search by +project', () => {
  const fields = parseQuickAdd('Fix login +web-app #repo-api #repo-web', '2026-10-20', ['Web App', 'Garden']);
  assert.equal(fields.project, 'Web App');
  assert.deepEqual(fields.tags, ['repo-api', 'repo-web']);
  assert.equal(fields.title, 'Fix login');
  assert.equal(parseQuickAdd('Plan +NewProj', '2026-10-20', []).project, 'NewProj');
  const item = createItem({ title: 'x', project: 'Web App' }, T0);
  assert.ok(matchesQuery(item, '+webapp'));
  assert.ok(matchesQuery(item, '+web'));
  assert.ok(!matchesQuery(item, '+garden'));
});

test('retagItems renames, merges and removes tags', () => {
  const items = [createItem({ title: 'a', tags: ['api', 'Backend'] }, T0), createItem({ title: 'b', tags: ['web'] }, T0)];
  const renamed = retagItems(items, 'backend', 'api', T1);
  assert.deepEqual(renamed[0].tags, ['api'], 'merged into existing tag');
  assert.equal(renamed[1], items[1], 'untouched items are not rewritten');
  assert.deepEqual(retagItems(items, 'API', '', T1)[0].tags, ['Backend']);
});

test('sync merges project changes from two devices and keeps unknown fields', async () => {
  let remote = { text: serializeDocument([], [], { future: true }), sha: 's0' };
  const client = {
    async getFile() {
      return remote;
    },
    async putFile(path, { text, sha }) {
      if (sha !== remote.sha) throw Object.assign(new Error('conflict'), { status: 409 });
      remote = { text, sha: `${sha}+` };
      return { sha: remote.sha };
    },
  };
  const now = () => T1;
  const phone = upsertProjectRecord([], 'Garden', { area: 'personal' }, T0);
  await syncOnce({ client, path: 't.json', localItems: [], localProjects: phone, now });
  const laptop = upsertProjectRecord([], 'Web App', { area: 'work' }, T0);
  const result = await syncOnce({ client, path: 't.json', localItems: [], localProjects: laptop, now });
  assert.deepEqual(result.projects.map((p) => p.name).sort(), ['Garden', 'Web App']);
  assert.equal(parseData(remote.text).extra.future, true);
});
