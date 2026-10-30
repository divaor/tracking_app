// attach_file: Claude attaching pictures and other files to items, by a link to download,
// base64, or an upload link that a shell sends the file to (curl -T).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../app/js/model.js';
import { checkDownloadUrl, decodeBase64, MAX_ATTACH_BYTES, withExtension } from '../mcp/attach.js';
import { memoryStore } from '../mcp/oauth.js';
import { createServerFromEnv } from '../mcp/server.js';
import { createUploads } from '../mcp/uploads.js';
import { createFakeGitHub } from './helpers/fake-github.js';

const ENV = { GITHUB_TOKEN: 'good-token', TRACKER_REPO: 'me/data', TRACKER_APP_URL: 'https://me.github.io/tracking_app/', TRACKER_DEVICE: 'Claude Code', MCP_SECRET: 'a-long-enough-secret-value' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

// The public web for downloads; anything for api.github.com goes to the fake GitHub.
function web(pages) {
  const asked = [];
  const fetch = async (url, init = {}) => {
    asked.push({ url: String(url), headers: { ...(init.headers ?? {}) } });
    const page = pages[String(url)];
    if (!page) return new Response('not here', { status: 404 });
    return typeof page === 'function' ? page(init) : page();
  };
  return { asked, fetch };
}

function setup({ pages = {}, store = null } = {}) {
  const github = createFakeGitHub();
  const internet = web(pages);
  const fetchImpl = (url, init) => (String(url).startsWith('https://api.github.com/') ? github.fetch(url, init) : internet.fetch(url, init));
  const { handle, http } = createServerFromEnv(ENV, { fetchImpl, defer: (p) => p, oauthStore: store });
  let id = 0;
  const call = async (name, args = {}, context) => {
    const res = await handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, context);
    const text = res.result.content[0].text;
    return { isError: Boolean(res.result.isError), text, data: res.result.isError ? null : JSON.parse(text) };
  };
  // The same call over HTTP (the address Claude reached is the upload links' base).
  const callHttp = async (name, args = {}) => {
    const res = await http(
      new Request(`https://mcp.example/mcp/${ENV.MCP_SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) }),
    );
    const body = await res.json();
    return { isError: Boolean(body.result.isError), text: body.result.content[0].text, data: body.result.isError ? null : JSON.parse(body.result.content[0].text) };
  };
  const items = () => parseDocument(github.read('tracker.json') ?? '{"items":[]}').filter((i) => !i.deleted);
  const newTask = async (title = 'Broken layout') => (await call('add_items', { items: [{ title }] })).data.added[0].id;
  return { github, internet, http, call, callHttp, items, newTask };
}

test('a picture in base64 is attached like one added in the app; the same name replaces it', async () => {
  const { call, github, items, newTask } = setup();
  const id = await newTask();
  const today = new Date().toISOString().slice(0, 10);

  const first = await call('attach_file', { item_id: id, filename: 'screen.png', content_base64: PNG.toString('base64') });
  assert.equal(first.isError, false, first.text);
  const path = `files/${today}-broken-layout-${id.slice(-6)}/screen.png`;
  assert.deepEqual(first.data.file, { path, name: 'screen.png', kind: 'image', size: `${PNG.length} B`, replaced: false });
  assert.match(first.data.item.link, new RegExp(`#/item/${id}$`));
  assert.deepEqual(github.readBytes(path), PNG);
  const [item] = items();
  assert.equal(item.status, 'pending', 'the status stays');
  assert.equal(item.updatedBy, 'Claude');
  const record = item.files[0];
  assert.deepEqual({ ...record, addedAt: undefined }, { path, name: 'screen.png', size: PNG.length, sha: github.branches.get('main').get(path).sha, addedAt: undefined, type: 'image/png' });
  assert.ok(github.commits.some((c) => c.path === path && c.message === 'Tracker: attach screen.png to “Broken layout” (via Claude Code)'));

  // Claude sees it again as a picture.
  const back = await call('get_item', { id });
  assert.deepEqual(back.data.files.map((f) => [f.name, f.kind]), [['screen.png', 'image']]);

  // The same name again: the file is replaced, not added twice.
  const again = await call('attach_file', { item_id: id, filename: 'screen.png', content_base64: JPEG.toString('base64') });
  assert.equal(again.data.file.replaced, true);
  assert.equal(items()[0].files.length, 1);
  assert.deepEqual(github.readBytes(path), JPEG);

  // A data: URL gives the type, so a name without an extension gets one.
  const data = await call('attach_file', { item_id: id, filename: 'diagram', content_base64: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(data.data.file.name, 'diagram.png');
  // A name that says text over bytes that are not: marked binary, so it is never read as text.
  const odd = await call('attach_file', { item_id: id, filename: 'dump.txt', content_base64: Buffer.from([0, 1, 2, 255]).toString('base64') });
  assert.equal(odd.data.file.kind, 'binary');
  assert.equal(items()[0].files.find((f) => f.name === 'dump.txt').binary, true);
  assert.equal(items()[0].files.length, 3);
});

test('attach_file refuses what it cannot attach', async () => {
  const { call, newTask, items } = setup();
  const id = await newTask();
  const b64 = PNG.toString('base64');
  assert.match((await call('attach_file', { item_id: id, content_base64: b64 })).text, /file name with an extension/);
  assert.match((await call('attach_file', { item_id: id, filename: 'x.png', content_base64: 'not base64!' })).text, /not base64/);
  assert.match((await call('attach_file', { item_id: 'nope-nope', filename: 'x.png', content_base64: b64 })).text, /No item with id or title/);
  assert.match((await call('attach_file', { item_id: id, filename: 'x.png', content_base64: b64, source_url: 'https://pictures.example/x.png' })).text, /not both/);
  // Without bytes and without HTTP (the stdio server): no upload link to give.
  assert.match((await call('attach_file', { item_id: id, filename: 'x.png' })).text, /Upload links need the connector over HTTP/);
  assert.equal(items()[0].files.length, 0);
});

test('a picture from a public link is downloaded, redirects followed, with no credentials sent', async () => {
  const jpeg = () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
  const { call, github, internet, items, newTask } = setup({
    pages: {
      'https://pictures.example/go': () => new Response(null, { status: 302, headers: { location: '/cats/cat.jpg' } }),
      'https://pictures.example/cats/cat.jpg': jpeg,
      'https://pictures.example/photo': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
      'https://pictures.example/named': () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="Login screen.png"' } }),
      'https://pictures.example/sneaky': () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }),
      'https://pictures.example/huge': () => new Response('x', { headers: { 'content-length': String(MAX_ATTACH_BYTES + 1) } }),
    },
  });
  const id = await newTask();
  const got = await call('attach_file', { item_id: id, source_url: 'https://pictures.example/go' });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.data.file.name, 'cat.jpg');
  assert.deepEqual(github.readBytes(got.data.file.path), JPEG);
  assert.ok(internet.asked.every((r) => !Object.keys(r.headers).some((h) => h.toLowerCase() === 'authorization')), 'the GitHub token never goes to the web');

  assert.equal((await call('attach_file', { item_id: id, source_url: 'https://pictures.example/photo' })).data.file.name, 'photo.png', 'an extension from the type');
  assert.equal((await call('attach_file', { item_id: id, source_url: 'https://pictures.example/named' })).data.file.name, 'Login-screen.png', 'the name the server gives');
  assert.equal((await call('attach_file', { item_id: id, source_url: 'https://pictures.example/photo', filename: 'mine.png' })).data.file.name, 'mine.png', 'filename wins');

  assert.match((await call('attach_file', { item_id: id, source_url: 'https://pictures.example/sneaky' })).text, /public address/);
  assert.match((await call('attach_file', { item_id: id, source_url: 'https://pictures.example/huge' })).text, /limit is 10 MB/);
  assert.match((await call('attach_file', { item_id: id, source_url: 'https://pictures.example/missing.png' })).text, /HTTP 404/);
  const asked = internet.asked.length;
  for (const bad of ['http://pictures.example/a.png', 'https://localhost/a.png', 'https://10.1.2.3/a.png', 'https://[::1]/a.png', 'https://2130706433/a.png', 'https://user:pw@pictures.example/a.png', 'ftp://pictures.example/a.png']) {
    assert.equal((await call('attach_file', { item_id: id, source_url: bad })).isError, true, bad);
  }
  assert.equal(internet.asked.length, asked, 'addresses refused are never fetched');
  assert.deepEqual(items()[0].files.map((f) => f.name), ['cat.jpg', 'photo.png', 'Login-screen.png', 'mine.png']);
});

test('checkDownloadUrl allows public https addresses only', () => {
  for (const ok of ['https://pictures.example/a.png', 'https://raw.githubusercontent.com/me/repo/main/a.png', 'https://172.32.0.1/a.png', 'https://8.8.8.8/a.png']) assert.ok(checkDownloadUrl(ok), ok);
  for (const bad of ['https://127.0.0.1/', 'https://0x7f.1/', 'https://192.168.1.10/', 'https://172.16.0.1/', 'https://100.64.0.1/', 'https://169.254.169.254/', 'https://printer.local/', 'https://db.internal/', 'https://intranet/', 'https://[fe80::1]/', 'http://example.com/', 'not a url']) {
    assert.throws(() => checkDownloadUrl(bad), undefined, bad);
  }
  assert.deepEqual(decodeBase64('aGk').bytes, new TextEncoder().encode('hi'), 'padding is optional');
  assert.deepEqual(decodeBase64('_-8').bytes, new Uint8Array([255, 239]), 'URL-safe base64');
  assert.equal(withExtension('report', 'application/pdf'), 'report.pdf');
  assert.equal(withExtension('notes.v2.md', 'text/plain'), 'notes.v2.md');
});

test('an upload link takes the file from a shell (curl -T) and attaches it once', async () => {
  const { callHttp, http, github, items, newTask } = setup({ store: memoryStore() });
  const id = await newTask();
  const link = await callHttp('attach_file', { item_id: id, filename: 'Login screen.png' });
  assert.equal(link.isError, false, link.text);
  const { url, command } = link.data.upload;
  assert.match(url, /^https:\/\/mcp\.example\/upload\/[\w-]+\.[\w-]+$/);
  assert.equal(command, `curl -sS -T <path of the file> '${url}'`);
  assert.equal(link.data.file, 'Login-screen.png');
  assert.equal(items()[0].files.length, 0, 'nothing attached until the file comes');

  assert.equal((await http(new Request(url))).status, 405);
  const put = await http(new Request(url, { method: 'PUT', body: PNG, headers: { 'content-type': 'image/png' } }));
  const answer = await put.json();
  assert.equal(put.status, 200, JSON.stringify(answer));
  assert.equal(answer.ok, true);
  assert.equal(answer.file.name, 'Login-screen.png');
  assert.deepEqual(github.readBytes(answer.file.path), PNG);
  assert.deepEqual(items()[0].files.map((f) => [f.name, f.type]), [['Login-screen.png', 'image/png']]);

  const twice = await http(new Request(url, { method: 'PUT', body: JPEG }));
  assert.equal(twice.status, 410, 'a link works once');
  const forged = await http(new Request(url.replace('/upload/', '/upload/x'), { method: 'PUT', body: PNG }));
  assert.equal(forged.status, 401);

  // Too large: refused, and the link still works for the right file.
  const fresh = (await callHttp('attach_file', { item_id: id, filename: 'big.bin' })).data.upload.url;
  assert.equal((await http(new Request(fresh, { method: 'PUT', body: new Uint8Array(MAX_ATTACH_BYTES + 1) }))).status, 413);
  assert.equal((await http(new Request(fresh, { method: 'PUT', body: new Uint8Array([1, 2, 3]) }))).status, 200);

  // A link for an item that does not exist is never given.
  assert.match((await callHttp('attach_file', { item_id: 'no-such-item', filename: 'x.png' })).text, /No item with id or title/);
});

test('upload links end after their time and only the connector can make them', async () => {
  let clock = Date.parse('2026-10-30T10:00:00Z');
  const uploads = createUploads({ secret: 'a-long-enough-secret-value', now: () => clock });
  const { url, expiresAt } = await uploads.link('https://mcp.example/', { item: 'abc', name: 'a.png' });
  assert.equal(expiresAt, '2026-10-30T10:15:00.000Z');
  const token = url.split('/upload/')[1];
  assert.deepEqual((({ item, name }) => ({ item, name }))(await uploads.open(token)), { item: 'abc', name: 'a.png' });
  clock += 16 * 60_000;
  await assert.rejects(uploads.open(token), (err) => err.status === 410);
  const other = createUploads({ secret: 'another-secret-entirely-here', now: () => clock });
  await assert.rejects(other.open(token), (err) => err.status === 401);
  await assert.rejects(uploads.open('x.y.z'), (err) => err.status === 401);
});
