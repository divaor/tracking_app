// The connector's release board tools: get_board, get_board_records, update_board, set_session,
// import_board and export_board (with their upload and download links), against a fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBoardChanges, boardTick, parseBoard, readBoardData, serializeBoard } from '../app/js/boards.js';
import { memoryStore } from '../mcp/oauth.js';
import { createServerFromEnv } from '../mcp/server.js';
import { DEMO } from './fixtures/board-demo.js';
import { createFakeGitHub } from './helpers/fake-github.js';

const ENV = { GITHUB_TOKEN: 'good-token', TRACKER_REPO: 'me/data', TRACKER_APP_URL: 'https://me.github.io/tracking_app/', TRACKER_DEVICE: 'Claude Code', MCP_SECRET: 'a-long-enough-secret-value' };
const PATH = 'boards/demo-app.json';
const page = (data = DEMO) => `<!doctype html><title>Board</title><script>\nwindow.DEMO_DATA = ${JSON.stringify(data, null, 1)};\n</script><script>(function(){ return { x: "}" }; })();</script>`;

function setup({ store = null } = {}) {
  const github = createFakeGitHub();
  const { handle, http } = createServerFromEnv(ENV, { fetchImpl: github.fetch, defer: (p) => p, oauthStore: store });
  let id = 0;
  const call = async (name, args = {}) => {
    const res = await handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const text = res.result.content[0].text;
    return { isError: Boolean(res.result.isError), text, data: res.result.isError ? null : JSON.parse(text) };
  };
  const callHttp = async (name, args = {}) => {
    const res = await http(
      new Request(`https://mcp.example/mcp/${ENV.MCP_SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) }),
    );
    const body = await res.json();
    return { isError: Boolean(body.result.isError), text: body.result.content[0].text, data: body.result.isError ? null : JSON.parse(body.result.content[0].text) };
  };
  const board = () => parseBoard(github.read(PATH));
  return { github, http, call, callHttp, board };
}

test('update_board makes a board, then get_board says where it stands', async () => {
  const { call, board, github } = setup();
  assert.match((await call('get_board', { project: 'Demo app' })).text, /has no release board yet.*import_board/);
  const made = await call('update_board', {
    project: 'Demo app',
    session: 'Docs',
    changes: [
      { part: 'releases', id: 'R1', set: { title: 'Sign-in', status: 'deploying', steps: [{ label: 'Merge', done: true }, { label: 'Deploy', done: false }] } },
      { part: 'features', id: 'f-login', set: { name: 'Login', release: 'R1', status: 'merged' } },
      { part: 'actions', id: 'a-deploy', set: { text: 'Deploy R1', when: 'Mon 11-02', release: 'R1' } },
    ],
    log: 'R1 cut',
    log_release: 'R1',
    now: { headline: 'R1 goes out Monday', summary: 'Login is merged.' },
  });
  assert.equal(made.isError, false, made.text);
  assert.equal(made.data.created, true);
  assert.deepEqual(made.data.changed.map((c) => `${c.part}/${c.id}:${c.action}`), ['releases/R1:added', 'features/f-login:added', 'actions/a-deploy:added']);
  assert.equal(made.data.link, 'https://me.github.io/tracking_app/#/release-board/demo-app');
  assert.ok(github.commits.some((c) => c.path === PATH && c.message === 'Tracker: release board “Demo app”: R1 cut (via Claude Code · Docs)'));
  const saved = board();
  assert.equal(saved.project, 'Demo app');
  assert.equal(saved.features[0].updatedBy, 'Claude Code · Docs');
  assert.deepEqual(saved.log.map((l) => [l.text, l.release, l.by]), [['R1 cut', 'R1', 'Claude Code · Docs']]);

  const got = (await call('get_board', { project: 'demo APP' })).data;
  assert.equal(got.project, 'Demo app');
  assert.equal(got.headline, 'R1 goes out Monday');
  assert.deepEqual(got.tiles, { releasesOut: '1 of 1 (fully or partly)', featuresLive: '0 of 1 (0%)', testsPassed: '0 of 0', waitingOnYou: 1, openDecisions: 0 });
  assert.deepEqual(got.releases, [{ id: 'R1', title: 'Sign-in', status: 'deploying', steps: '1 of 2 done (50%)', nextStep: 'Deploy' }]);
  assert.deepEqual(got.waitingOnYou.map((a) => a.text), ['Deploy R1']);
  assert.equal(got.updated.by, 'Claude Code · Docs');
  assert.equal(got.counts.features, 1);
});

test('import_board brings a board file in under the project\'s spelling; records come back filtered and paged', async () => {
  const { call, board } = setup();
  await call('add_items', { items: [{ title: 'Ship reports', project: 'Demo App' }] });
  const imported = await call('import_board', { project: 'demo app', content: page() });
  assert.equal(imported.isError, false, imported.text);
  assert.deepEqual(imported.data.imported, { releases: 2, features: 4, tests: 2, decisions: 2, events: 2, sessions: 2, repos: 1, actions: 2, briefs: 1, log: 2 });
  assert.equal(imported.data.variable, 'DEMO_DATA');
  assert.equal(board().project, 'Demo App', 'the existing project\'s spelling');

  const got = (await call('get_board', { project: 'Demo App' })).data;
  assert.deepEqual(got.tiles, { releasesOut: '2 of 2 (fully or partly)', featuresLive: '2 of 4 (50%)', testsPassed: '1 of 2', waitingOnYou: 2, openDecisions: 1 });
  assert.deepEqual(got.openDecisions, [{ id: 'd-2', code: 'D2', title: 'Report format', release: 'R2', date: '2026-10-29' }]);
  assert.deepEqual(got.sessions.map((x) => x.name), ['Reports', 'Release']);

  const r2 = (await call('get_board_records', { project: 'Demo App', part: 'features', release: 'R2' })).data;
  assert.deepEqual(r2.records.map((f) => f.id), ['f-reports', 'f-export']);
  assert.equal(r2.total, 2);
  const paged = (await call('get_board_records', { project: 'Demo App', part: 'features', limit: 3 })).data;
  assert.deepEqual([paged.records.length, paged.nextOffset, paged.total], [3, 3, 4]);
  const rest = (await call('get_board_records', { project: 'Demo App', part: 'features', limit: 3, offset: 3 })).data;
  assert.deepEqual([rest.records.map((f) => f.id), rest.nextOffset], [['f-export'], undefined]);
  assert.deepEqual((await call('get_board_records', { project: 'Demo App', part: 'features', query: 'csv' })).data.records.map((f) => f.id), ['f-export']);
  assert.deepEqual((await call('get_board_records', { project: 'Demo App', part: 'tests', status: 'passed' })).data.records.map((t) => t.id), ['t-login']);
  assert.deepEqual((await call('get_board_records', { project: 'Demo App', part: 'releases', ids: ['R2'] })).data.records[0].commands[0].id, 'c-merge');
  assert.match((await call('get_board_records', { project: 'Demo App', part: 'nope' })).text, /part must be one of/);

  // Importing again merges: what the board has beyond the file stays.
  await call('update_board', { project: 'Demo App', changes: [{ part: 'tests', id: 't-extra', set: { title: 'Extra' } }] });
  await call('import_board', { project: 'Demo App', content: page() });
  assert.ok(board().tests.some((t) => t.id === 't-extra'));
});

test('dotted fields, removals, unknown statuses and what changed since', async () => {
  const { call, board } = setup();
  await call('import_board', { project: 'Demo app', content: page() });
  const before = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5)); // "changed since" is strictly after
  const updated = await call('update_board', {
    project: 'Demo app',
    session: 'Release',
    changes: [
      { part: 'releases', id: 'R2', set: { 'steps.1.done': true, 'steps.1.date': '2026-10-31', 'dates.merged': '2026-10-31' } },
      { part: 'features', id: 'f-reports', set: { status: 'shipped-ish' } },
      { part: 'actions', id: board().actions[0].id, remove: true },
    ],
  });
  assert.equal(updated.isError, false, updated.text);
  assert.match(updated.data.warnings[0], /“shipped-ish” is not one of the board's statuses/);
  const got = (await call('get_board', { project: 'Demo app', since: before })).data;
  assert.equal(got.releases.find((r) => r.id === 'R2').steps, '2 of 3 done (67%)');
  assert.equal(got.waitingOnYou.length, 1);
  assert.deepEqual(got.changedSince.changes.map((c) => `${c.part}/${c.id}`).sort(), [`actions/${board().actions[0].id}`, 'features/f-reports', 'releases/R2'].sort());
  assert.ok(got.changedSince.changes.find((c) => c.part === 'actions').deleted);
  assert.match((await call('update_board', { project: 'Demo app' })).text, /Nothing to change/);
  assert.match((await call('update_board', { project: 'Demo app', changes: [{ part: 'nope', id: 'x', set: {} }] })).text, /not a part of a board/);
});

test('set_session keeps a session\'s row; a race with another writer keeps both changes', async () => {
  const { call, board, github } = setup();
  await call('import_board', { project: 'Demo app', content: page() });
  const set = await call('set_session', { project: 'Demo app', name: 'Docs', state: 'working', status: 'in_progress', now: 'Writing the guide' });
  assert.equal(set.isError, false, set.text);
  const row = board().sessions.find((s) => s.id === 'Docs');
  assert.deepEqual([row.name, row.state, row.now, row.updatedBy], ['Docs', 'working', 'Writing the guide', 'Claude Code · Docs']);
  assert.match(row.reported, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  // Another session writes between our read and our write: ours is made again on its version.
  github.failNextPut(PATH, 409, () => {
    const theirs = parseBoard(github.read(PATH));
    theirs.tests = theirs.tests.map((t) => (t.id === 't-reports' ? { ...t, status: 'passed', updatedAt: new Date().toISOString(), updatedBy: 'Claude · QA' } : t));
    github.write(PATH, JSON.stringify(theirs));
  });
  const mine = await call('update_board', { project: 'Demo app', changes: [{ part: 'features', id: 'f-export', set: { status: 'built' } }], session: 'Reports' });
  assert.equal(mine.isError, false, mine.text);
  assert.equal(board().tests.find((t) => t.id === 't-reports').status, 'passed', 'theirs stays');
  assert.equal(board().features.find((f) => f.id === 'f-export').status, 'built', 'ours lands');
});

test('a board file that cannot be read is left alone; older log entries go to an archive', async () => {
  const { call, github } = setup();
  github.write(PATH, '{ broken');
  assert.match((await call('update_board', { project: 'Demo app', log: 'x' })).text, /cannot be read, so it was left as it is/);
  assert.equal(github.read(PATH), '{ broken');

  const many = { ...DEMO, log: Array.from({ length: 503 }, (_, i) => ({ time: `2026-09-${String(1 + (i % 28)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00`, text: `entry ${i}` })) };
  github.write(PATH, '{"version":1,"project":"Demo app"}');
  await call('import_board', { project: 'Demo app', content: JSON.stringify(many) });
  await call('update_board', { project: 'Demo app', log: 'The newest entry' });
  const saved = parseBoard(github.read(PATH));
  assert.equal(saved.log.length, 500);
  assert.equal(saved.log[0].text, 'The newest entry');
  const archived = JSON.parse(github.read('boards/demo-app/log-2026-09.json'));
  assert.equal(archived.log.length, 4);
});

test('import and export through links: the board file goes up with curl -T and comes down with curl -o', async () => {
  const { callHttp, call, http } = setup({ store: memoryStore() });
  const link = await callHttp('import_board', { project: 'Demo app' });
  assert.equal(link.isError, false, link.text);
  assert.match(link.data.upload.url, /^https:\/\/mcp\.example\/upload\//);
  const put = await http(new Request(link.data.upload.url, { method: 'PUT', body: page() }));
  const answer = await put.json();
  assert.equal(put.status, 200, JSON.stringify(answer));
  assert.equal(answer.imported.features, 4);
  assert.equal((await http(new Request(link.data.upload.url, { method: 'PUT', body: page() }))).status, 410, 'once');

  const exported = await callHttp('export_board', { project: 'Demo app' });
  assert.equal(exported.isError, false, exported.text);
  assert.equal(exported.data.variable, 'DEMO_DATA');
  assert.ok(exported.data.script.startsWith('window.DEMO_DATA = '), 'small boards come back whole');
  assert.match(exported.data.download.url, /^https:\/\/mcp\.example\/download\//);
  const got = await http(new Request(exported.data.download.url));
  assert.equal(got.status, 200);
  assert.match(got.headers.get('content-disposition'), /demo-app-board\.js/);
  const script = await got.text();
  assert.equal(script, exported.data.script);
  assert.deepEqual(readBoardData(script).data, DEMO, 'the page\'s data, as it was');
  assert.equal((await http(new Request(exported.data.download.url))).status, 200, 'a download link works until it ends');
  assert.equal((await http(new Request(exported.data.download.url, { method: 'PUT', body: 'x' }))).status, 405, 'downloads are fetched');
  assert.equal((await http(new Request(exported.data.download.url.replace('/download/', '/upload/'), { method: 'PUT', body: 'x' }))).status, 401, 'not an upload link');
  assert.equal((await http(new Request(link.data.upload.url.replace('/upload/', '/download/')))).status, 401, 'not a download link');
  // Over stdio there is no link: the script comes back whole.
  const plain = await call('export_board', { project: 'Demo app', variable: 'MY_DATA' });
  assert.ok(plain.data.script.startsWith('window.MY_DATA = '));
  assert.equal(plain.data.download, undefined);
  assert.match((await call('import_board', { project: 'Demo app' })).text, /Upload links need the connector over HTTP/);
});

test('the release_board prompt says how to keep a board current', async () => {
  const github = createFakeGitHub();
  const { handle } = createServerFromEnv(ENV, { fetchImpl: github.fetch });
  const prompt = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'release_board', arguments: { project: 'Demo app', session: 'Docs' } } });
  const text = prompt.result.messages[0].content.text;
  assert.match(text, /release board of "Demo app"/);
  assert.match(text, /you are "Docs"/);
  assert.match(text, /set_session/);
  assert.match(text, /update_board/);
});

test('comments and ticks from the app: get_board shows what awaits Claude; Claude answers with update_board; get_overview has the boards', async () => {
  const { call, board, github } = setup();
  await call('import_board', { project: 'Demo app', content: page() });
  // On the phone: a comment on a feature and on a command, and the first action ticked done.
  let b = applyBoardChanges(board(), [
    { part: 'features', id: 'f-export', comment: 'Is CSV enough?' },
    { part: 'releases', id: 'R2', comment: 'Output: merged cleanly', command: 'c-merge' },
  ], { at: new Date(Date.now() - 120_000).toISOString(), by: 'Phone' }).board;
  b = boardTick(b, { kind: 'action', id: b.actions[0].id }, true, { at: new Date(Date.now() - 60_000).toISOString(), by: 'Phone' });
  github.write(PATH, serializeBoard(b));

  const got = (await call('get_board', { project: 'Demo app' })).data;
  assert.deepEqual(got.waitingOnYou.map((a) => a.text), ['Run the migration']);
  assert.equal(got.tiles.waitingOnYou, 1);
  assert.deepEqual(got.commentsAwaiting.map((c) => [c.part, c.id, c.command ?? '', c.by, c.text]), [
    ['releases', 'R2', 'c-merge', 'Phone', 'Output: merged cleanly'],
    ['features', 'f-export', '', 'Phone', 'Is CSV enough?'],
  ]);

  // Claude answers one; it cannot delete the user's comment.
  const userComment = board().features.find((f) => f.id === 'f-export').comments[0].id;
  const answered = await call('update_board', { project: 'Demo app', session: 'Docs', changes: [{ part: 'features', id: 'f-export', comment: 'CSV first, PDF later.', uncomment: userComment }] });
  assert.equal(answered.isError, false, answered.text);
  const comments = board().features.find((f) => f.id === 'f-export').comments;
  assert.deepEqual(comments.map((c) => [c.by, c.text, Boolean(c.deleted)]), [['Phone', 'Is CSV enough?', false], ['Claude Code · Docs', 'CSV first, PDF later.', false]]);
  assert.deepEqual((await call('get_board', { project: 'Demo app' })).data.commentsAwaiting.map((c) => c.id), ['R2']);
  const bad = await call('update_board', { project: 'Demo app', changes: [{ part: 'tests', id: 'nope', comment: 'x' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /no tests nope to comment on/);

  const overview = (await call('get_overview')).data;
  assert.deepEqual(overview.releaseBoards.map((r) => [r.project, r.waitingOnYou, r.openDecisions, r.commentsAwaiting]), [['Demo app', ['Run the migration (Mon 11-02)'], 1, 1]]);
  assert.equal(overview.releaseBoards[0].link, 'https://me.github.io/tracking_app/#/release-board/demo-app');
  assert.equal(overview.releaseBoards[0].waitingOnYouTotal, undefined, 'all of them listed');

  // A long list of changes says how many were left out.
  const many = Array.from({ length: 65 }, (_, i) => ({ part: 'tests', id: `t-${i}`, set: { title: `Test ${i}`, status: 'scheduled' } }));
  await new Promise((r) => setTimeout(r, 5));
  const before = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await call('update_board', { project: 'Demo app', changes: many });
  const since = (await call('get_board', { project: 'Demo app', since: before })).data.changedSince;
  assert.deepEqual([since.total, since.shown, since.changes.length], [65, 60, 60]);
  assert.match(since.more, /^5 older changes not listed/);
});
