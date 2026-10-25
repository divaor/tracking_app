import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '../app/js/model.js';
import { createServerFromEnv } from '../mcp/server.js';
import { MAX_READ_CHARS } from '../mcp/tracker.js';
import { createFakeGitHub } from './helpers/fake-github.js';

const ENV = {
  GITHUB_TOKEN: 'good-token',
  TRACKER_REPO: 'me/data',
  TRACKER_APP_URL: 'https://me.github.io/tracking_app/',
  TRACKER_DEVICE: 'Claude Code',
  MCP_SECRET: 'a-long-enough-secret-value',
};

function setup(env = {}) {
  const github = createFakeGitHub();
  const { handle, config, http } = createServerFromEnv({ ...ENV, ...env }, { fetchImpl: github.fetch, defer: (p) => p });
  let id = 0;
  const rpc = (method, params) => handle({ jsonrpc: '2.0', id: ++id, method, params });
  const call = async (name, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const text = res.result.content[0].text;
    return { isError: Boolean(res.result.isError), text, data: res.result.isError ? null : JSON.parse(text) };
  };
  const items = () => parseDocument(github.read('tracker.json') ?? '{"items":[]}').filter((i) => !i.deleted);
  return { github, handle, config, http, rpc, call, items };
}

test('initialize, tools/list and prompts follow the MCP shape', async () => {
  const { rpc, handle } = setup();
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'tracker');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /send_document/);
  assert.ok(init.result.instructions.length < 4096, 'Claude Code truncates instructions at 4096 characters');
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-11-25');

  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await rpc('ping')).result, {});

  const { tools } = (await rpc('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'add_items',
    'delete_items',
    'get_item',
    'get_overview',
    'list_editor_files',
    'list_items',
    'list_projects',
    'read_editor_file',
    'read_file',
    'save_editor_file',
    'save_project',
    'search_editor_files',
    'send_document',
    'update_items',
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean', tool.name);
  }

  const { prompts } = (await rpc('prompts/list')).result;
  assert.ok(prompts.some((p) => p.name === 'send_proposal'));
  const prompt = await rpc('prompts/get', { name: 'send_proposal', arguments: { topic: 'caching' } });
  assert.match(prompt.result.messages[0].content.text, /proposal about caching/);

  assert.equal((await rpc('nope/method')).error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'missing_tool' })).error.code, -32602);
});

test('send_document stores the file and files a doc for review', async () => {
  const { call, github, items } = setup();
  const proposal = '# Offline sync\n\nUse a JSON file in GitHub.\n\n- [ ] Decide on conflict handling\n\nÜnïcødé ✓';
  const sent = await call('send_document', {
    title: 'Offline sync proposal',
    kind: 'proposal',
    content: proposal,
    summary: 'Proposes syncing through GitHub. **Decide** whether to approve.',
    project: 'tracking_app',
    url: 'https://claude.ai/code/session_123',
    tags: ['sync'],
  });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(sent.data.created, true);
  assert.match(sent.data.file.path, /^files\/\d{4}-\d{2}-\d{2}-offline-sync-proposal-[0-9a-f]{6}\/proposal\.md$/);
  assert.equal(github.read(sent.data.file.path), proposal);
  assert.equal(sent.data.item.link, `https://me.github.io/tracking_app/#/item/${sent.data.item.id}`);

  const [doc] = items();
  assert.equal(doc.type, 'doc');
  assert.equal(doc.kind, 'proposal');
  assert.equal(doc.status, 'pending');
  assert.equal(doc.project, 'tracking_app');
  assert.equal(doc.files[0].path, sent.data.file.path);
  assert.equal(doc.files[0].size, Buffer.byteLength(proposal));
  assert.match(doc.notes, /Proposes syncing/);
  assert.deepEqual(github.commits.map((c) => c.message), [
    `Tracker: add ${sent.data.file.path} (via Claude Code)`,
    'Tracker: add proposal “Offline sync proposal” (via Claude Code)',
  ]);

  const overview = await call('get_overview');
  assert.equal(overview.data.awaitingReview[0].id, doc.id);
  assert.equal(overview.data.counts.doc.pending, 1);

  const read = await call('read_file', { path: sent.data.file.path });
  assert.equal(read.data.content, proposal);
  assert.equal((await call('read_file', { path: 'tracker.json' })).isError, true, 'only files/ can be read');
  assert.equal((await call('read_file', { path: 'files/../tracker.json' })).isError, true);
});

test('review loop: the user decides, Claude reads feedback and sends a new version', async () => {
  const { call, items, github } = setup();
  const first = await call('send_document', { title: 'API design', kind: 'proposal', content: 'v1', filename: 'design.md' });
  const id = first.data.item.id;

  // The user reviews in the app (simulated through update_items).
  await call('update_items', { updates: [{ id, decision: 'changes', feedback: 'Add error codes.', status: 'done' }] });
  const pending = await call('list_items', { status: 'all', decision: 'changes' });
  assert.deepEqual(pending.data.items.map((i) => i.id), [id]);
  const detail = await call('get_item', { id, include_file_contents: true });
  assert.equal(detail.data.feedback, 'Add error codes.');
  assert.equal(detail.data.files[0].content, 'v1');

  const second = await call('send_document', { item_id: id, title: 'API design', kind: 'proposal', content: 'v2 with error codes', filename: 'design.md', summary: 'Added error codes.' });
  assert.equal(second.isError, false, second.text);
  assert.equal(second.data.created, false);
  assert.equal(second.data.replacedFile, true);
  assert.equal(second.data.file.path, first.data.file.path);
  assert.equal(github.read(first.data.file.path), 'v2 with error codes');
  const [doc] = items();
  assert.equal(doc.status, 'pending', 'back in the review queue');
  assert.equal(doc.decision, '');
  assert.equal(doc.feedback, 'Add error codes.');
  assert.equal(doc.files.length, 1);
  assert.match(doc.notes, /\*\*Update \d{4}-\d{2}-\d{2}:\*\* Added error codes\./);

  const extra = await call('send_document', { item_id: id, title: '', kind: 'artifact', content: '<h1>Mock</h1>', filename: 'mock.html' });
  assert.equal(extra.isError, false, extra.text);
  assert.deepEqual(items()[0].files.map((f) => f.name), ['design.md', 'mock.html']);
});

test('add, update and delete items in batches with validation', async () => {
  const { call, items, github } = setup();
  const added = await call('add_items', {
    items: [
      { title: 'Write tests', tags: ['work'], due: '2026-11-01' },
      { title: 'Refactor sync', type: 'claude', kind: 'pr', url: 'https://github.com/me/app/pull/7', status: 'in_progress' },
      { title: 'Voice capture', type: 'idea' },
    ],
  });
  assert.equal(added.data.added.length, 3);
  assert.equal(github.commits.length, 1, 'one commit for the batch');

  const [task, pr] = added.data.added;
  const updated = await call('update_items', {
    updates: [
      { id: task.id, status: 'done', append_notes: 'Done in session X.', add_tags: ['q4'], remove_tags: ['work'] },
      { id: 'Refactor sync', priority: 'high', due: '' },
    ],
  });
  assert.equal(updated.isError, false, updated.text);
  const now = items();
  const doneTask = now.find((i) => i.id === task.id);
  assert.equal(doneTask.status, 'done');
  assert.ok(doneTask.completedAt);
  assert.deepEqual(doneTask.tags, ['q4']);
  assert.equal(doneTask.notes, 'Done in session X.');
  assert.equal(now.find((i) => i.id === pr.id).priority, 'high');

  const open = await call('list_items', {});
  assert.deepEqual(open.data.items.map((i) => i.title).sort(), ['Refactor sync', 'Voice capture']);
  assert.equal((await call('list_items', { status: 'done', type: 'task' })).data.total, 1);
  assert.equal((await call('list_items', { query: 'session x', status: 'all' })).data.items[0].id, task.id);

  for (const bad of [{ id: task.id, status: 'finished' }, { id: task.id, priority: 'max' }, { id: task.id, due: 'tomorrow' }, { id: task.id, kind: 'pr' }, { id: 'missing' }]) {
    const res = await call('update_items', { updates: [bad] });
    assert.equal(res.isError, true, JSON.stringify(bad));
  }
  assert.equal((await call('add_items', { items: [{ title: '' }] })).isError, true);
  assert.equal((await call('add_items', { items: [{ title: 'x', type: 'meeting' }] })).isError, true);

  const commitsBefore = github.commits.length;
  const removed = await call('delete_items', { ids: [pr.id] });
  assert.deepEqual(removed.data.deleted.map((d) => d.title), ['Refactor sync']);
  assert.equal(github.commits.length, commitsBefore + 1);
  assert.equal(items().some((i) => i.id === pr.id), false);
});

test('retries when the app writes tracker.json at the same time', async () => {
  const { call, github, items } = setup();
  await call('add_items', { items: [{ title: 'first' }] });
  // Simulate the phone saving between our read and our write.
  github.failNextPut('tracker.json', 409, () => {
    const doc = JSON.parse(github.read('tracker.json'));
    doc.items.push({ id: 'phone-1', type: 'task', title: 'from phone', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' });
    github.write('tracker.json', JSON.stringify(doc));
  });
  const res = await call('add_items', { items: [{ title: 'second' }] });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(items().map((i) => i.title).sort(), ['first', 'from phone', 'second']);
});

test('long files are paged to stay within tool output limits', async () => {
  const { call } = setup();
  const big = 'x'.repeat(MAX_READ_CHARS + 500);
  const sent = await call('send_document', { title: 'Big', kind: 'report', content: big, filename: 'big.txt' });
  const page1 = await call('read_file', { path: sent.data.file.path });
  assert.equal(page1.data.content.length, MAX_READ_CHARS);
  assert.equal(page1.data.nextOffset, MAX_READ_CHARS);
  const page2 = await call('read_file', { path: sent.data.file.path, offset: page1.data.nextOffset });
  assert.equal(page2.data.content.length, 500);
  assert.equal(page2.data.nextOffset, undefined);
  const detail = await call('get_item', { id: sent.data.item.id, include_file_contents: true });
  assert.match(detail.data.files[0].truncated, /read_file with offset/);
});

test('uses the configured branch, creating it on first write', async () => {
  const { call, github } = setup({ TRACKER_BRANCH: 'tracker' });
  const sent = await call('send_document', { title: 'On a branch', kind: 'other', content: 'hello' });
  assert.equal(sent.isError, false, sent.text);
  assert.ok(github.branches.has('tracker'));
  assert.equal(github.read('tracker.json', 'tracker') !== undefined, true);
  assert.equal(github.read('tracker.json'), undefined, 'default branch untouched');
});

test('explains missing configuration instead of failing silently', async () => {
  const { call } = setup({ GITHUB_TOKEN: '', TRACKER_REPO: '' });
  const res = await call('get_overview');
  assert.equal(res.isError, true);
  assert.match(res.text, /GITHUB_TOKEN is not set; TRACKER_REPO must be "owner\/repo"/);

  const badToken = setup({ GITHUB_TOKEN: 'wrong' });
  assert.match((await badToken.call('list_items')).text, /rejected the token/);
});

test('server-side GitHub requests send a User-Agent and no browser cache mode', async () => {
  const { call, github } = setup();
  await call('get_overview');
  assert.match(github.requests[0].headers['user-agent'], /^tracker-mcp\//);
});

test('HTTP transport: secret path or bearer token, JSON responses, 202 for notifications', async () => {
  const { http, config } = setup();
  const post = (path, body, headers = {}) =>
    http(new Request(`https://mcp.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) }));
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

  const viaPath = await post(`/mcp/${config.secret}`, init);
  assert.equal(viaPath.status, 200);
  assert.equal(viaPath.headers.get('content-type'), 'application/json');
  assert.equal((await viaPath.json()).result.serverInfo.name, 'tracker');

  assert.equal((await post('/mcp', init, { authorization: `Bearer ${config.secret}` })).status, 200);
  const challenge = await post('/mcp', init);
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('www-authenticate'), /^Bearer resource_metadata="https:\/\/mcp\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  const wrong = await post('/mcp', init, { authorization: 'Bearer wrong' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.equal((await post('/mcp/wrong-secret-of-some-length', init)).status, 404);
  assert.equal((await post('/mcp/%E0%A4%A', init)).status, 404);
  assert.equal((await post('/other', init)).status, 404);

  assert.equal((await post(`/mcp/${config.secret}`, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const batch = await post(`/mcp/${config.secret}`, [init, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.deepEqual((await batch.json()).map((r) => r.id), [1, 2]);

  assert.equal((await post(`/mcp/${config.secret}`, init, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(`/mcp/${config.secret}`, init, { origin: 'https://claude.ai' })).status, 200);

  const get = await http(new Request(`https://mcp.example/mcp/${config.secret}`));
  assert.equal(get.status, 405);
  const bad = await http(new Request(`https://mcp.example/mcp/${config.secret}`, { method: 'POST', body: '{nope' }));
  assert.equal((await bad.json()).error.code, -32700);
  const unconfigured = await setup({ MCP_SECRET: '' }).http(new Request(`https://mcp.example/mcp/x`, { method: 'POST', body: '{}' }));
  assert.equal(unconfigured.status, 500);
});

test('stdio server works end to end against a GitHub API over HTTP', async () => {
  const github = createFakeGitHub();
  const api = await github.listen();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp/stdio.js', import.meta.url))], {
    env: { ...process.env, GITHUB_TOKEN: 'good-token', TRACKER_REPO: 'me/data', GITHUB_API_URL: api.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      responses.get(msg.id)?.(msg);
    }
  });
  const request = (id, method, params) =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'tracker');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const sent = await request(2, 'tools/call', { name: 'send_document', arguments: { title: 'Via stdio', kind: 'artifact', content: '<p>hi</p>', filename: 'page.html' } });
    assert.equal(sent.result.isError, undefined, sent.result.content[0].text);
    const path = JSON.parse(sent.result.content[0].text).file.path;
    assert.equal(github.read(path), '<p>hi</p>');
    assert.equal(parseDocument(github.read('tracker.json'))[0].files[0].name, 'page.html');
  } finally {
    child.kill();
    api.close();
  }
});

test('projects and tags: Claude files work under a project and tags repos', async () => {
  const { call, rpc, items, github } = setup();
  assert.deepEqual((await call('list_projects')).data, { projects: [], tags: [] });

  const created = await call('save_project', { name: 'Platform', area: 'work', description: 'Backend platform' });
  assert.deepEqual(created.data.project, { name: 'Platform', area: 'work', description: 'Backend platform' });
  assert.equal((await call('save_project', { name: 'x', area: 'hobby' })).isError, true);

  await call('add_items', { items: [{ title: 'Add rate limiting', project: 'platform', tags: ['api-gateway'] }] });
  const sent = await call('send_document', { title: 'Auth redesign', kind: 'proposal', content: '# Auth', project: 'PLATFORM', tags: ['api', 'web'] });
  assert.equal(sent.data.item.project, 'Platform', 'project spelling normalized');
  await call('add_items', { items: [{ title: 'Plant tomatoes', project: 'Garden' }] });
  await call('save_project', { name: 'garden', area: 'personal' });

  const listed = await call('list_projects');
  assert.deepEqual(listed.data.projects.map((p) => [p.name, p.area, p.open]), [['Platform', 'work', 2], ['Garden', 'personal', 1]]);
  assert.deepEqual(listed.data.tags.map((t) => t.tag).sort(), ['api', 'api-gateway', 'web']);

  assert.equal((await call('list_items', { area: 'work' })).data.total, 2);
  assert.equal((await call('list_items', { area: 'personal' })).data.total, 1);
  assert.equal((await call('list_items', { project: 'garden' })).data.total, 1);
  assert.equal((await call('list_items', { projects: ['Garden', 'Platform'] })).data.total, 3);
  assert.equal((await call('list_items', { tag: 'web' })).data.items[0].title, 'Auth redesign');

  const updated = await call('update_items', { updates: [{ id: 'Plant tomatoes', project: 'platform', add_tags: ['infra'] }] });
  assert.equal(updated.data.updated[0].project, 'Platform');

  const renamed = await call('save_project', { name: 'platform', rename_to: 'Core Platform' });
  assert.equal(renamed.data.itemsMoved, 3);
  assert.ok(items().every((i) => i.project === 'Core Platform'));
  const doc = JSON.parse(github.read('tracker.json'));
  assert.deepEqual(doc.projects.filter((p) => !p.deleted).map((p) => [p.name, p.area]).sort(), [['Core Platform', 'work'], ['Garden', 'personal']]);

  await call('save_project', { name: 'core platform', delete: true });
  assert.ok(items().every((i) => i.project === ''));

  const prompt = await rpc('prompts/get', { name: 'use_project', arguments: { project: 'Platform', area: 'work' } });
  assert.match(prompt.result.messages[0].content.text, /project "Platform"/);
  assert.match(prompt.result.messages[0].content.text, /tag each item with the repositories/);
});

test('pin and unpin items: on top of the lists and the overview, whatever their status', async () => {
  const { call, items } = setup();
  const added = await call('add_items', {
    items: [
      { title: 'Release checklist', project: 'Tracker App', status: 'done' },
      { title: 'Plain task', project: 'Tracker App' },
      { title: 'Pinned from the start', pinned: true },
    ],
  });
  const [checklist, plain, early] = added.data.added;
  assert.equal(early.pinned, true);
  const pinned = await call('update_items', { updates: [{ id: checklist.id, pinned: true }] });
  assert.equal(pinned.isError, false, pinned.text);
  assert.equal(pinned.data.updated[0].pinned, true);
  assert.equal(items().find((i) => i.id === checklist.id).pinned, true);

  // Asking for the pinned ones includes a done item; open lists put pinned items first.
  const list = await call('list_items', { pinned: true });
  assert.deepEqual(list.data.items.map((i) => i.title), ['Release checklist', 'Pinned from the start']);
  assert.deepEqual((await call('list_items', { pinned: true, status: 'open' })).data.items.map((i) => i.title), ['Pinned from the start']);
  assert.deepEqual((await call('list_items', { pinned: false })).data.items.map((i) => i.title), ['Plain task']);
  assert.equal((await call('list_items', {})).data.items[0].title, 'Pinned from the start');
  const overview = await call('get_overview', {});
  assert.deepEqual(overview.data.pinned.map((i) => i.title), ['Release checklist', 'Pinned from the start']);

  // Unpinning leaves no trace in the data file; anything but true/false is refused.
  await call('update_items', { updates: [{ id: checklist.id, pinned: false }] });
  assert.equal('pinned' in items().find((i) => i.id === checklist.id), false);
  assert.equal((await call('update_items', { updates: [{ id: plain.id, pinned: 'yes' }] })).isError, true);
  // The tool says how.
  const tools = await call('list_items', { pinned: true });
  assert.equal(tools.data.total, 1);
});
