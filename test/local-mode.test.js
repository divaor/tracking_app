// Local mode: the tracker's sync against the data on this device (localRepo.js),
// shared with Tracker Editor, and moving it to GitHub and back (moveData.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from './helpers/fake-git-data.js';
import { createGitHubClient } from '../app/js/github.js';
import { createLocalRepo, memoryBackend } from '../app/js/localRepo.js';
import { moveData } from '../app/js/moveData.js';
import { syncOnce } from '../app/js/sync.js';
import { createItem, mergeItems, mergeProjects, parseData, serializeDocument } from '../app/js/model.js';

let clock = Date.parse('2026-10-21T10:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
const mergeTracker = (theirs, ours) => {
  const a = parseData(theirs);
  const b = parseData(ours);
  return serializeDocument(mergeItems(a.items, b.items), mergeProjects(a.projects, b.projects), a.extra);
};

test('two apps on the same data on this device see each other’s items', async () => {
  const backend = memoryBackend();
  const tracker = createLocalRepo(backend, { now: tick });
  const editor = createLocalRepo(backend, { now: tick });
  const mine = createItem({ title: 'From the tracker', project: 'Alpha' }, tick());
  const first = await syncOnce({ client: tracker, path: 'tracker.json', localItems: [mine], device: 'pc', now: tick });
  assert.equal(first.pushed, true);
  // What the editor writes there ("Send to tracker").
  const theirs = createItem({ title: 'Sent from the editor' }, tick());
  const current = await editor.getFile('tracker.json');
  const doc = parseData(current.text);
  await editor.putFile('tracker.json', { text: serializeDocument([...doc.items, theirs], doc.projects, doc.extra), sha: current.sha, message: 'editor' });
  const second = await syncOnce({ client: tracker, path: 'tracker.json', localItems: first.items, device: 'pc', now: tick });
  assert.deepEqual(second.items.map((i) => i.title).sort(), ['From the tracker', 'Sent from the editor']);
  // History is kept here too.
  assert.equal((await tracker.listCommits({ path: 'tracker.json' })).length, 2);
});

test('to GitHub file by file (the tracker’s client has no trees), and back', async () => {
  const local = createLocalRepo(memoryBackend(), { now: tick });
  const item = createItem({ title: 'Local only' }, tick());
  await syncOnce({ client: local, path: 'tracker.json', localItems: [item], device: 'pc', now: tick });
  await local.putFile('files/2026-10-21-a-123456/a.md', { text: '# A', message: 'doc' });
  const fake = createFakeGitHub();
  const github = createGitHubClient({ token: 'good-token', owner: 'me', repo: 'data', fetchImpl: fake.fetch, cacheMode: '' });
  assert.equal(github.createTree, undefined);
  const moved = await moveData({ from: local, to: github, toTrackerPath: 'data/tracker.json', mergeTracker });
  assert.deepEqual(moved, { copied: 1, tracker: true });
  assert.equal(parseData((await github.getFile('data/tracker.json')).text).items[0].title, 'Local only');
  assert.equal((await github.getFile('files/2026-10-21-a-123456/a.md')).text, '# A');
  // The tracker's own sync there carries on with the same items.
  const there = await syncOnce({ client: github, path: 'data/tracker.json', localItems: [item], device: 'pc', now: tick });
  assert.equal(there.pushed, false);
  // Back: a new item on GitHub comes to this device.
  const phone = createItem({ title: 'From the phone' }, tick());
  const file = await github.getFile('data/tracker.json');
  await github.putFile('data/tracker.json', { text: serializeDocument([...parseData(file.text).items, phone], []), sha: file.sha, message: 'phone' });
  await moveData({ from: github, to: local, fromTrackerPath: 'data/tracker.json', toTrackerPath: 'tracker.json', mergeTracker });
  assert.deepEqual(parseData((await local.getFile('tracker.json')).text).items.map((i) => i.title).sort(), ['From the phone', 'Local only']);
});
