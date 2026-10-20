import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, createItem, parseDocument, tombstone } from '../app/js/model.js';
import { syncOnce } from '../app/js/sync.js';
import { GitHubError } from '../app/js/github.js';

// In-memory stand-in for the GitHub Contents API.
function fakeRepo({ text = null, branches = ['main'] } = {}) {
  const repo = {
    text,
    sha: text ? 'sha-0' : null,
    version: 0,
    commits: [],
    branches: new Set(branches),
    beforePut: null,
    async getFile(path, ref) {
      if (ref && !repo.branches.has(ref)) return null;
      return repo.text == null ? null : { sha: repo.sha, text: repo.text };
    },
    async putFile(path, { text: body, sha, branch, message }) {
      if (repo.beforePut) {
        const hook = repo.beforePut;
        repo.beforePut = null;
        await hook();
      }
      if (branch && !repo.branches.has(branch)) throw new GitHubError('Branch not found', 404);
      if ((repo.sha ?? undefined) !== (sha ?? undefined)) throw new GitHubError('sha mismatch', 409);
      repo.text = body;
      repo.sha = `sha-${++repo.version}`;
      repo.commits.push(message);
      return { sha: repo.sha };
    },
    async ensureBranch(branch) {
      const created = !repo.branches.has(branch);
      repo.branches.add(branch);
      return created;
    },
  };
  return repo;
}

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-01T11:00:00.000Z';
const now = () => '2026-10-02T00:00:00.000Z';

test('first sync creates the data file', async () => {
  const repo = fakeRepo();
  const item = createItem({ title: 'first' }, T0);
  const result = await syncOnce({ client: repo, path: 'tracker.json', localItems: [item], device: 'Laptop', now });
  assert.equal(result.pushed, true);
  assert.equal(repo.commits[0], 'Tracker: create data file (from Laptop)');
  assert.deepEqual(parseDocument(repo.text).map((i) => i.title), ['first']);
});

test('two devices converge, including edits and deletions', async () => {
  const repo = fakeRepo();
  const shared = createItem({ title: 'shared' }, T0);
  const doomed = createItem({ title: 'doomed' }, T0);

  // Laptop creates two items.
  let laptop = (await syncOnce({ client: repo, path: 't.json', localItems: [shared, doomed], device: 'Laptop', now })).items;
  // Phone starts empty and pulls them without writing.
  let phone = (await syncOnce({ client: repo, path: 't.json', localItems: [], device: 'Phone', now })).items;
  assert.equal(repo.commits.length, 1, 'pull-only sync does not commit');
  assert.equal(phone.length, 2);

  // Phone finishes one, laptop deletes the other and adds a new one.
  phone = phone.map((i) => (i.id === shared.id ? applyPatch(i, { status: 'done' }, T1) : i));
  laptop = [...laptop.map((i) => (i.id === doomed.id ? tombstone(i, T1) : i)), createItem({ title: 'new' }, T1)];

  phone = (await syncOnce({ client: repo, path: 't.json', localItems: phone, device: 'Phone', now })).items;
  const laptopResult = await syncOnce({ client: repo, path: 't.json', localItems: laptop, device: 'Laptop', now });
  assert.deepEqual(laptopResult.counts, { added: 1, updated: 0, deleted: 1 });
  assert.equal(repo.commits.at(-1), 'Tracker: sync from Laptop (1 added, 1 deleted)');
  phone = (await syncOnce({ client: repo, path: 't.json', localItems: phone, device: 'Phone', now })).items;

  const view = (items) => items.filter((i) => !i.deleted).map((i) => `${i.title}:${i.status}`).sort();
  assert.deepEqual(view(phone), ['new:pending', 'shared:done']);
  assert.deepEqual(view(laptopResult.items), ['new:pending', 'shared:done']);
});

test('retries when another device writes in between', async () => {
  const other = createItem({ title: 'from other device' }, T0);
  const repo = fakeRepo({ text: JSON.stringify({ items: [] }) });
  repo.beforePut = async () => {
    repo.text = JSON.stringify({ items: [other] });
    repo.sha = 'sha-other';
  };
  const mine = createItem({ title: 'mine' }, T1);
  const result = await syncOnce({ client: repo, path: 't.json', localItems: [mine], now });
  assert.deepEqual(parseDocument(repo.text).map((i) => i.title).sort(), ['from other device', 'mine']);
  assert.equal(result.items.length, 2);
});

test('never overwrites a remote file it cannot parse', async () => {
  const repo = fakeRepo({ text: '{ broken json' });
  await assert.rejects(syncOnce({ client: repo, path: 't.json', localItems: [createItem({ title: 'x' })], now }), /not valid JSON/);
  assert.equal(repo.text, '{ broken json');
  assert.equal(repo.commits.length, 0);
});

test('creates a missing branch before the first write', async () => {
  const repo = fakeRepo();
  await syncOnce({ client: repo, path: 't.json', branch: 'tracker-data', localItems: [createItem({ title: 'x' })], now });
  assert.ok(repo.branches.has('tracker-data'));
  assert.equal(repo.commits.length, 1);
});

test('gives up after repeated conflicts and surfaces non-conflict errors immediately', async () => {
  const repo = fakeRepo({ text: JSON.stringify({ items: [] }) });
  let puts = 0;
  repo.putFile = async () => {
    puts++;
    throw new GitHubError('conflict', 409);
  };
  await assert.rejects(syncOnce({ client: repo, path: 't.json', localItems: [createItem({ title: 'x' })], now, maxAttempts: 3 }), /conflict/);
  assert.equal(puts, 3);

  puts = 0;
  repo.putFile = async () => {
    puts++;
    throw new GitHubError('bad token', 401);
  };
  await assert.rejects(syncOnce({ client: repo, path: 't.json', localItems: [createItem({ title: 'x' })], now }), /bad token/);
  assert.equal(puts, 1);
});
