// Find by asking in the tracker (2.6): its sources (items, their text files, release board records,
// Tracker Editor's files) and a whole run with a scripted model, where encrypted names never go out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardSources,
  editorEncrypted,
  editorSource,
  editorTextPath,
  ENCRYPTED_MARK,
  fileSource,
  findPicture,
  itemSource,
  parseEditorIndex,
  runFind,
  safeName,
  textFilesOf,
} from '../app/js/findSources.js';
import { applyBoardChanges, emptyBoard } from '../app/js/boards.js';
import { addCommentPatch, applyPatch, createItem } from '../app/js/model.js';

const at = '2026-10-20T09:00:00.000Z';
const now = '2026-11-01T12:00:00.000Z';

function items() {
  let leak = createItem({ title: 'Fix the leak', project: 'Kitchen', tags: ['home'], notes: 'Under the sink', url: 'https://example.com/pipe', feedback: '' }, at);
  leak = applyPatch(leak, addCommentPatch(leak, 'Called the plumber', 'Phone', at), at);
  leak = { ...leak, files: [{ path: 'files/x/plan.md', name: 'plan.md', size: 10, sha: 's1', addedAt: at }, { path: 'files/x/photo.jpg', name: 'photo.jpg', size: 10, sha: 's2', addedAt: at }] };
  const proposal = createItem({ title: 'Caching proposal', type: 'doc', project: 'Deep Time', feedback: 'Looks good', status: 'done' }, at);
  const gone = { ...createItem({ title: 'Gone', files: [{ path: 'files/g/a.md', name: 'a.md', sha: 's3' }] }, at), deleted: true };
  return [leak, proposal, gone];
}

test('items as sources: what a person remembers them by', () => {
  const [leak, proposal] = items();
  const s = itemSource(leak);
  assert.equal(s.id, `i:${leak.id}`);
  assert.equal(s.kind, 'item');
  assert.equal(s.name, 'Fix the leak');
  assert.equal(s.place, 'Tracker · Kitchen');
  assert.deepEqual([s.type, s.status, s.project, s.tags], ['task', 'pending', 'Kitchen', ['home']]);
  assert.match(s.text, /^Fix the leak\nUnder the sink\nMe: Called the plumber\nFiles: plan\.md, photo\.jpg\nhttps:\/\/example\.com\/pipe$/);
  assert.match(itemSource(proposal).text, /Feedback: Looks good/);
  assert.equal(itemSource({ ...proposal, project: '' }).place, 'Tracker');
});

test('text files on items: pictures and deleted items left out', () => {
  const list = textFilesOf(items());
  assert.deepEqual(list.map((x) => x.file.name), ['plan.md']);
  const s = fileSource(list[0].item, list[0].file, '# Plan\nBuy a new trap');
  assert.equal(s.id, `a:${list[0].item.id}:files/x/plan.md`);
  assert.equal(s.place, 'On “Fix the leak”');
  assert.deepEqual([s.kind, s.itemId, s.path, s.project], ['file', list[0].item.id, 'files/x/plan.md', 'Kitchen']);
});

test('release board records: their words, where they open', () => {
  const board = applyBoardChanges(emptyBoard('Deep Time'), [
    { part: 'releases', id: '2.3', set: { title: 'Layers', status: 'planned', steps: [{ label: 'Built', done: true }, { label: 'Phone playtest', done: false }] } },
    { part: 'tests', id: 't-phone', set: { title: 'Phone playtest', release: '2.3', status: 'pending' } },
    { part: 'actions', id: 'a-try', set: { text: 'Try the layers on the phone', done: true } },
    { part: 'features', id: 'f-old', remove: true },
  ], { at, by: 'Claude' }).board;
  const sources = boardSources('deep-time', board);
  assert.deepEqual(sources.map((s) => s.id), ['b:deep-time:releases:2.3', 'b:deep-time:tests:t-phone', 'b:deep-time:actions:a-try']);
  const release = sources[0];
  assert.equal(release.name, '2.3 · Layers');
  assert.equal(release.place, 'Deep Time · release board · release');
  assert.match(release.text, /Layers\nplanned\nBuilt\nPhone playtest/);
  assert.doesNotMatch(release.text, /Claude|2026-/, 'no stamps');
  assert.equal(release.href, '#/release-board/deep-time/release/2.3');
  assert.equal(sources[1].href, '#/release-board/deep-time/test/t-phone');
  assert.equal(sources[2].href, '#/release-board/deep-time', 'steps waiting open the board');
  assert.equal(sources[2].status, 'done');
});

test('Tracker Editor files: the index, their paths, encrypted ones by name only', () => {
  assert.equal(safeName('  ../a/b\\c.md '), 'a b c.md');
  assert.equal(safeName(''), 'untitled.txt');
  assert.equal(editorTextPath({ id: 'abc', name: 'notes/today.md' }), 'editor/files/abc/notes today.md');
  const index = JSON.stringify({ app: 'tracker-editor', files: [{ id: 'a', name: 'docker.md' }, { id: 'b', name: 'old.md', deleted: true }, { name: 'no id' }, { id: 'c', name: 'keys.md', encrypted: true }] });
  assert.deepEqual(parseEditorIndex(index).map((r) => r.id), ['a', 'c']);
  assert.equal(parseEditorIndex('{oops'), null);
  assert.equal(parseEditorIndex('{"files": 3}'), null);
  assert.equal(editorEncrypted({ name: 'x' }, `${ENCRYPTED_MARK}\nAAAA`), true);
  const plain = editorSource({ id: 'a', name: 'docker.md', project: 'Deep Time', tags: ['docker'], modifiedAt: '2026-10-30T10:00:00Z' }, 'docker compose up -d');
  assert.deepEqual([plain.id, plain.kind, plain.from, plain.place, plain.text, plain.encrypted, plain.untitled], ['e:a', 'editor', 'editor', 'Tracker Editor · Deep Time', 'docker compose up -d', false, false]);
  const secret = editorSource({ id: 'c', name: 'keys.md', encrypted: true }, 'the password is hunter2');
  assert.deepEqual([secret.text, secret.encrypted], ['', true], 'never its text');
  assert.equal(editorSource({ id: 'd', name: 'new 3' }).untitled, true);
});

test('the picture for the plan: the kinds there are, items’ and the editor’s tags', () => {
  const list = items().filter((i) => !i.deleted);
  const picture = findPicture({ today: '2026-11-01', items: list, projects: ['Kitchen', 'Deep Time'], boards: [], files: 1, editor: [{ id: 'a', name: 'secret name.md', tags: ['docker', 'HOME'] }] });
  assert.deepEqual(picture.kinds.map((k) => k.id), ['item', 'file', 'editor']);
  assert.deepEqual(picture.tags, ['home', 'docker']);
  assert.deepEqual(picture.types.map((t) => t.id), ['task', 'idea', 'claude', 'doc']);
  assert.match(picture.about, /Tracker Editor/);
  assert.doesNotMatch(JSON.stringify(picture), /secret name/, 'never the editor files’ names');
});

test('a run: the plan, the search, the pick; encrypted names never go to the model', async () => {
  const list = items().filter((i) => !i.deleted);
  const sources = [
    ...list.map(itemSource),
    editorSource({ id: 'a', name: 'docker.md', modifiedAt: '2026-10-30T10:00:00Z' }, 'Deploy\ndocker compose up -d'),
    editorSource({ id: 'k', name: 'docker keys.md', encrypted: true }, ''),
    editorSource({ id: 'b', name: 'compose notes', modifiedAt: '2026-09-30T10:00:00Z' }, 'docker run -p 80:80 nginx'),
  ];
  const picture = findPicture({ today: '2026-11-01', items: list, projects: ['Kitchen', 'Deep Time'], editor: [{ id: 'a', name: 'x' }] });
  const asked = [];
  const chat = async (messages, purpose) => {
    asked.push({ purpose, text: messages.map((m) => m.content).join('\n') });
    if (purpose === 'find-plan') return '{"intent": "find", "terms": ["docker", "docker compose"], "names": ["docker"], "kinds": ["editor", "item"]}';
    return '{"results": [{"id": "c2", "why": "docker run at line 1"}, {"id": "c1", "why": "docker compose up -d at line 2"}]}';
  };
  const phases = [];
  const out = await runFind('the file where I copied a docker command', { picture, loadSources: async () => sources, chat, now, onPhase: (p) => phases.push(p) });
  assert.deepEqual(phases, ['planning', 'searching', 'picking']);
  assert.deepEqual(asked.map((a) => a.purpose), ['find-plan', 'find-pick']);
  assert.equal(out.picked, true);
  assert.deepEqual(out.results.map((r) => [r.id, r.why]), [
    ['e:b', 'docker run at line 1'],
    ['e:a', 'docker compose up -d at line 2'],
  ]);
  assert.deepEqual(out.encrypted.map((r) => r.id), ['e:k'], 'the encrypted one apart, found by its name');
  for (const a of asked) assert.doesNotMatch(a.text, /docker keys/, `${a.purpose} never names an encrypted file`);
  // The model fails at planning: the question's words are searched; at picking: the ranking stands.
  const failing = await runFind('docker compose', { picture, loadSources: async () => sources, chat: async () => { throw new Error('offline'); }, now });
  assert.equal(failing.plan.plain, true);
  assert.equal(failing.picked, false);
  assert.ok(failing.results.some((r) => r.id === 'e:a'));
  const noModel = await runFind('docker compose', { picture, loadSources: async () => sources, chat: null, now });
  assert.deepEqual(noModel.results.map((r) => r.id).slice(0, 1), ['e:a']);
  // Stopped: the abort goes through.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runFind('docker', { picture, loadSources: async () => sources, chat: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, now, signal: controller.signal }), /aborted/);
  // Asked for the encrypted files: the group, and no pick.
  asked.length = 0;
  const secrets = await runFind('my encrypted password files', { picture, loadSources: async () => sources, chat: async (m, purpose) => (asked.push(purpose), '{"intent": "list", "encrypted": true}'), now });
  assert.deepEqual(asked, ['find-plan']);
  assert.deepEqual([secrets.results.length, secrets.encrypted.map((r) => r.id)], [0, ['e:k']]);
});
