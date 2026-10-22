import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeDocument } from '../app/js/model.js';
import { EDITOR_INDEX, ENCRYPTED_MARK } from '../mcp/editor.js';
import { createServerFromEnv } from '../mcp/server.js';
import { MAX_READ_CHARS } from '../mcp/tracker.js';
import { createFakeGitHub } from './helpers/fake-github.js';

const ENV = { GITHUB_TOKEN: 'good-token', TRACKER_REPO: 'me/data', TRACKER_DEVICE: 'Claude Code' };
const LINK = 'https://divaor.github.io/tracker-editor/#/file/';

function setup(env = {}) {
  const github = createFakeGitHub();
  const { handle } = createServerFromEnv({ ...ENV, ...env }, { fetchImpl: github.fetch, defer: (p) => p });
  const call = async (name, args = {}) => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const text = res.result.content[0].text;
    return { isError: Boolean(res.result.isError), text, data: res.result.isError ? null : JSON.parse(text) };
  };
  const index = () => JSON.parse(github.read(EDITOR_INDEX));
  const record = (id) => index().files.find((f) => f.id === id);
  return { github, call, index, record };
}

let clock = 0;
// Writes editor files the way the editor syncs them: the text at
// editor/files/<id>/<name> and a record (with that text's sha) in the index.
function seed(github, files, extra = { custom: { keep: true } }) {
  const records = files.map(({ text = '', ...fields }, i) => {
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, ++clock + i)).toISOString();
    const r = { id: `f${i}`, name: `file${i}.md`, project: '', tags: [], language: '', size: Buffer.byteLength(text), modifiedAt: at, modifiedBy: 'Laptop', createdAt: at, updatedAt: at, updatedBy: 'Laptop', ...fields };
    const path = `editor/files/${r.id}/${r.name}`;
    github.write(path, text);
    return { ...r, sha: github.branches.get('main').get(path).sha };
  });
  github.write(EDITOR_INDEX, JSON.stringify({ app: 'tracker-editor', schema: 1, updatedAt: '2026-10-01T00:00:00.000Z', ...extra, files: records }, null, 2));
  return records;
}

test('list_editor_files: newest first, filters, links, tombstones skipped', async () => {
  const { github, call } = setup();
  seed(github, [
    { id: 'old', name: 'old notes.md', project: 'Platform', tags: ['sql'], text: 'old', modifiedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', name: 'query.sql', project: 'Platform', tags: ['sql', 'db'], text: 'select 1', modifiedAt: '2026-10-20T00:00:00.000Z' },
    { id: 'gone', name: 'gone.md', deleted: true, modifiedAt: '2026-10-21T00:00:00.000Z' },
    { id: 'home', name: 'recipes.md', project: 'Home', text: 'soup', modifiedAt: '2026-05-01T00:00:00.000Z' },
  ]);
  const all = (await call('list_editor_files')).data;
  assert.equal(all.total, 3);
  assert.deepEqual(all.files.map((f) => f.id), ['new', 'home', 'old']);
  assert.deepEqual(all.files[0], { id: 'new', name: 'query.sql', project: 'Platform', tags: ['sql', 'db'], size: '8 B', modifiedAt: '2026-10-20T00:00:00.000Z', modifiedBy: 'Laptop', link: `${LINK}new` });

  assert.deepEqual((await call('list_editor_files', { project: 'platform' })).data.files.map((f) => f.id), ['new', 'old']);
  assert.deepEqual((await call('list_editor_files', { tag: '#DB' })).data.files.map((f) => f.id), ['new']);
  assert.deepEqual((await call('list_editor_files', { query: 'notes' })).data.files.map((f) => f.id), ['old']);
  const limited = (await call('list_editor_files', { limit: 1 })).data;
  assert.deepEqual([limited.total, limited.shown, limited.files.length], [3, 1, 1]);

  const custom = setup({ TRACKER_EDITOR_URL: 'https://example.com/editor' });
  seed(custom.github, [{ id: 'a b', text: 'x' }]);
  assert.equal((await custom.call('list_editor_files')).data.files[0].link, 'https://example.com/editor/#/file/a%20b');

  const empty = setup();
  assert.deepEqual((await empty.call('list_editor_files')).data, { total: 0, shown: 0, files: [] });
});

test('read_editor_file pages long files and finds files by name', async () => {
  const { github, call } = setup();
  const long = `${'a'.repeat(MAX_READ_CHARS)}tail`;
  seed(github, [
    { id: 'long', name: 'Long.txt', text: long },
    { id: 'gone', name: 'gone.md', text: 'x', deleted: true },
  ]);
  const first = (await call('read_editor_file', { id: 'long' })).data;
  assert.equal(first.totalChars, long.length);
  assert.equal(first.content.length, MAX_READ_CHARS);
  assert.equal(first.nextOffset, MAX_READ_CHARS);
  assert.equal(first.link, `${LINK}long`);
  const rest = (await call('read_editor_file', { id: 'long', offset: first.nextOffset })).data;
  assert.equal(rest.content, 'tail');
  assert.equal(rest.nextOffset, undefined);

  assert.equal((await call('read_editor_file', { id: 'long.txt' })).data.id, 'long');
  assert.match((await call('read_editor_file', { id: 'gone' })).text, /deleted in the editor/);
  assert.match((await call('read_editor_file', { id: 'gone.md' })).text, /No editor file/);
  assert.match((await call('read_editor_file', { id: 'nope' })).text, /list_editor_files/);
});

test('search_editor_files: lines and snippets, newest first, skips encrypted and large files', async () => {
  const { github, call } = setup();
  seed(github, [
    { id: 'older', name: 'older.md', text: 'intro\nThe Deploy key lives here\nend', modifiedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'newer', name: 'newer.md', text: `${'x'.repeat(200)} deploy ${'y'.repeat(200)}\nno\nredeploy now`, modifiedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'secret', name: 'secret.md', encrypted: true, text: `${ENCRYPTED_MARK}\nZGVwbG95` },
    { id: 'marked', name: 'marked.md', text: `${ENCRYPTED_MARK}\ndeploy` },
    { id: 'big', name: 'big.log', text: 'deploy', size: 400 * 1024 },
    { id: 'none', name: 'none.md', text: 'nothing to see' },
  ]);
  const res = (await call('search_editor_files', { query: 'DEPLOY' })).data;
  assert.deepEqual(res.files.map((f) => f.id), ['newer', 'older']);
  assert.deepEqual(res.files[0].lines.map((l) => l.line), [1, 3]);
  assert.match(res.files[0].lines[0].text, /^…x+ deploy y+…$/);
  assert.ok(res.files[0].lines[0].text.length < 180);
  assert.deepEqual(res.files[1].lines, [{ line: 2, text: 'The Deploy key lives here' }]);
  assert.equal(res.files[0].link, `${LINK}newer`);
  assert.match(res.note, /2 files were not searched/);
  assert.ok(!JSON.stringify(res).includes('ZGVwbG95'));

  const named = (await call('search_editor_files', { query: 'secret' })).data;
  assert.deepEqual(named.files.map((f) => [f.id, f.lines.length]), [['secret', 0]]);
  assert.match((await call('search_editor_files', { query: ' ' })).text, /^Error:/);
});

test('search_editor_files stops at the 60 newest files and at the line limit', async () => {
  const { github, call } = setup();
  seed(github, Array.from({ length: 65 }, (_, i) => ({ id: `n${i}`, name: `n${i}.md`, text: 'needle\nneedle', modifiedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() })));
  const res = (await call('search_editor_files', { query: 'needle', limit: 100 })).data;
  assert.equal(res.searched, 60);
  assert.equal(res.files.length, 50);
  assert.equal(res.files[0].id, 'n64');
  assert.match(res.note, /60 most recently changed of 65 files/);
  assert.match(res.note, /Stopped at 100 matching lines/);
});

test('save_editor_file creates a file: text first, then the index, with the tracker\'s project spelling', async () => {
  const { github, call, index, record } = setup();
  github.write('tracker.json', serializeDocument([], [{ key: 'platform', name: 'Platform', area: 'work', color: '', description: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]));
  seed(github, [{ id: 'kept', name: 'kept.md', text: 'kept' }]);
  const before = github.commits.length;

  const res = await call('save_editor_file', { name: 'Deploy notes.md', content: '# Deploy\n\nSteps ✓', project: ' platform ', tags: ['#ops', 'ops', 'ci'] });
  assert.equal(res.isError, false, res.text);
  const { file, path, created } = res.data;
  assert.equal(created, true);
  assert.equal(path, `editor/files/${file.id}/Deploy notes.md`);
  assert.equal(github.read(path), '# Deploy\n\nSteps ✓');
  assert.equal(file.link, `${LINK}${file.id}`);
  assert.deepEqual([file.project, file.tags, file.modifiedBy], ['Platform', ['ops', 'ci'], 'Claude Code']);

  const saved = record(file.id);
  assert.equal(saved.sha, github.branches.get('main').get(path).sha);
  assert.equal(saved.size, Buffer.byteLength('# Deploy\n\nSteps ✓'));
  assert.equal(saved.updatedBy, 'Claude Code');
  assert.equal(saved.createdAt, saved.updatedAt);
  assert.deepEqual(Object.keys(saved), ['id', 'name', 'project', 'tags', 'language', 'sha', 'size', 'modifiedAt', 'modifiedBy', 'createdAt', 'updatedAt', 'updatedBy']);
  assert.deepEqual(index().custom, { keep: true });
  assert.equal(index().app, 'tracker-editor');
  assert.ok(record('kept'));
  assert.deepEqual(github.commits.slice(before).map((c) => c.path), [path, EDITOR_INDEX]);

  assert.match((await call('save_editor_file', { content: 'x' })).text, /name .* is required/);
  assert.match((await call('save_editor_file', { name: 'a.md' })).text, /content is required/);
  assert.match((await call('save_editor_file', { name: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) })).text, /the limit is 2\.0 MB/);
});

test('save_editor_file replaces the text of a file, keeping its other fields', async () => {
  const { github, call, record } = setup();
  const [orig] = seed(github, [{ id: 'f', name: 'plan.md', project: 'Platform', tags: ['x'], language: 'markdown', text: 'v1', extraField: 'kept' }]);
  const res = await call('save_editor_file', { id: 'f', content: 'v2 longer' });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.data.created, false);
  assert.equal(github.read('editor/files/f/plan.md'), 'v2 longer');
  const saved = record('f');
  assert.equal(saved.sha, github.branches.get('main').get('editor/files/f/plan.md').sha);
  assert.notEqual(saved.sha, orig.sha);
  assert.equal(saved.size, 9);
  assert.equal(saved.modifiedBy, 'Claude Code');
  assert.ok(saved.modifiedAt > orig.modifiedAt);
  // Only the text changed: the metadata keeps its timestamp, so a rename elsewhere still wins.
  assert.deepEqual([saved.updatedAt, saved.updatedBy, saved.name, saved.project, saved.language, saved.extraField], [orig.updatedAt, 'Laptop', 'plan.md', 'Platform', 'markdown', 'kept']);

  // The same text again writes nothing new.
  const commits = github.commits.length;
  await call('save_editor_file', { id: 'f', content: 'v2 longer' });
  assert.ok(!github.commits.slice(commits).some((c) => c.path === 'editor/files/f/plan.md'));

  // Project and tags alone bump updatedAt past the previous value.
  github.write(EDITOR_INDEX, github.read(EDITOR_INDEX).replaceAll(orig.updatedAt, '2099-01-01T00:00:00.000Z'));
  await call('save_editor_file', { id: 'f', project: '', tags: ['a', 'b'] });
  const meta = record('f');
  assert.deepEqual([meta.project, meta.tags, meta.updatedBy], ['', ['a', 'b'], 'Claude Code']);
  assert.equal(meta.updatedAt, '2099-01-01T00:00:00.001Z');
});

test('save_editor_file renames: the text moves to the new path and the old one is removed', async () => {
  const { github, call, record } = setup();
  const [orig] = seed(github, [{ id: 'r', name: 'draft.md', text: 'hello' }]);
  const res = await call('save_editor_file', { id: 'r', name: 'final/plan.md' });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.data.path, 'editor/files/r/final plan.md');
  assert.equal(github.read('editor/files/r/final plan.md'), 'hello');
  assert.equal(github.read('editor/files/r/draft.md'), undefined);
  const saved = record('r');
  assert.equal(saved.name, 'final plan.md');
  assert.equal(saved.modifiedAt, orig.modifiedAt);
  assert.ok(saved.updatedAt > orig.updatedAt);

  // Rename and new text together.
  await call('save_editor_file', { id: 'r', name: 'done.md', content: 'bye' });
  assert.equal(github.read('editor/files/r/done.md'), 'bye');
  assert.equal(github.read('editor/files/r/final plan.md'), undefined);
  assert.equal(record('r').name, 'done.md');
});

test('encrypted editor files are never returned or overwritten', async () => {
  const { github, call, record } = setup();
  const sealed = `${ENCRYPTED_MARK}\nc2VjcmV0`;
  seed(github, [
    { id: 'flag', name: 'flag.md', encrypted: true, text: sealed },
    { id: 'mark', name: 'mark.md', text: sealed },
  ]);
  for (const id of ['flag', 'mark']) {
    const read = await call('read_editor_file', { id });
    assert.equal(read.isError, false);
    assert.equal(read.data.encrypted, true);
    assert.equal(read.data.content, undefined);
    assert.match(read.data.message, /end-to-end encrypted/);
    assert.ok(!read.text.includes('c2VjcmV0'));

    const before = github.read(EDITOR_INDEX);
    for (const args of [{ content: 'plain' }, { name: 'renamed.md' }, { tags: ['x'] }]) {
      const save = await call('save_editor_file', { id, ...args });
      assert.equal(save.isError, true);
      assert.match(save.text, /end-to-end encrypted.*not changed/);
    }
    assert.equal(github.read(`editor/files/${id}/${id}.md`), sealed);
    assert.equal(github.read(EDITOR_INDEX), before);
  }
  assert.equal(record('flag').encrypted, true);
});

test('deleted editor files stay deleted', async () => {
  const { github, call, record } = setup();
  seed(github, [{ id: 'dead', name: 'dead.md', deleted: true, text: 'old' }]);
  const before = github.read(EDITOR_INDEX);
  const res = await call('save_editor_file', { id: 'dead', content: 'back?' });
  assert.match(res.text, /deleted in the editor/);
  assert.equal(github.read(EDITOR_INDEX), before);
  assert.equal(github.read('editor/files/dead/dead.md'), 'old');
  assert.equal(record('dead').deleted, true);
});

test('save_editor_file retries the index when another device wrote it, without writing the text twice', async () => {
  const { github, call, index } = setup();
  seed(github, [{ id: 'a', name: 'a.md', text: 'a' }]);
  github.failNextPut(EDITOR_INDEX, 409, () => {
    const data = JSON.parse(github.read(EDITOR_INDEX));
    data.files.push({ ...data.files[0], id: 'b', name: 'b.md' });
    data.files[0] = { ...data.files[0], name: 'renamed elsewhere.md', updatedAt: '2026-10-21T00:00:00.000Z' };
    github.write(EDITOR_INDEX, JSON.stringify(data));
  });
  const before = github.commits.length;
  const res = await call('save_editor_file', { name: 'c.md', content: 'c' });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(index().files.map((f) => f.name).sort(), ['b.md', 'c.md', 'renamed elsewhere.md']);
  assert.equal(github.commits.slice(before).filter((c) => c.path.startsWith('editor/files/')).length, 1);

  // An update after a conflict applies to the other device's version of the record.
  github.failNextPut(EDITOR_INDEX, 409, () => {
    const data = JSON.parse(github.read(EDITOR_INDEX));
    data.files = data.files.map((f) => (f.id === 'b' ? { ...f, tags: ['from-phone'], updatedAt: '2026-10-21T00:00:00.000Z' } : f));
    github.write(EDITOR_INDEX, JSON.stringify(data));
  });
  await call('save_editor_file', { id: 'b', content: 'b2' });
  const b = index().files.find((f) => f.id === 'b');
  assert.deepEqual([b.tags, b.size, b.modifiedBy], [['from-phone'], 2, 'Claude Code']);
  assert.equal(b.sha, github.branches.get('main').get('editor/files/b/b.md').sha);
});

test('an editor index that cannot be parsed is left alone', async () => {
  const { github, call } = setup();
  github.write(EDITOR_INDEX, '{ not json');
  assert.match((await call('list_editor_files')).text, /not valid JSON/);
  assert.match((await call('save_editor_file', { name: 'x.md', content: 'x' })).text, /left alone/);
  assert.equal(github.read(EDITOR_INDEX), '{ not json');
  assert.equal(github.commits.length, 0);
});
