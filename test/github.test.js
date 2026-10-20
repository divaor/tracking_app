import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient, decodeBase64, encodeBase64 } from '../app/js/github.js';

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method, pathname, search: searchParams.toString(), init, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${init.method} ${pathname}`];
    const [status, body] = handler ? handler(calls.at(-1)) : [404, { message: 'Not Found' }];
    return new Response(body == null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('base64 helpers round-trip UTF-8 and large strings', () => {
  const samples = ['', 'hello', 'ünïcødé ✓ 🚀 日本語', 'x'.repeat(200000)];
  for (const s of samples) assert.equal(decodeBase64(encodeBase64(s)), s);
  assert.equal(decodeBase64('aGVs\nbG8='), 'hello', 'GitHub wraps base64 with newlines');
});

test('getFile sends auth headers, encodes the path and decodes content', async () => {
  const { fetchImpl, calls } = mockFetch({
    'GET /repos/me/data/contents/notes/my%20file.json': () => [200, { type: 'file', sha: 'abc', size: 5, content: encodeBase64('{"a":"é"}') }],
  });
  const client = createGitHubClient({ token: 'tok', owner: 'me', repo: 'data', fetchImpl });
  const file = await client.getFile('notes/my file.json', 'dev');
  assert.deepEqual(file, { sha: 'abc', text: '{"a":"é"}' });
  assert.equal(calls[0].search, 'ref=dev');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.cache, 'no-store');
});

test('getFile returns null on 404 and falls back to the blob API for big files', async () => {
  const { fetchImpl } = mockFetch({
    'GET /repos/me/data/contents/big.json': () => [200, { type: 'file', sha: 'big', size: 2_000_000, content: '', encoding: 'none' }],
    'GET /repos/me/data/git/blobs/big': () => [200, { content: encodeBase64('{"items":[]}'), encoding: 'base64' }],
  });
  const client = createGitHubClient({ token: 't', owner: 'me', repo: 'data', fetchImpl });
  assert.equal(await client.getFile('missing.json'), null);
  assert.equal((await client.getFile('big.json')).text, '{"items":[]}');
});

test('getFile refuses folders', async () => {
  const { fetchImpl } = mockFetch({ 'GET /repos/me/data/contents/dir': () => [200, [{ name: 'x' }]] });
  const client = createGitHubClient({ token: 't', owner: 'me', repo: 'data', fetchImpl });
  await assert.rejects(client.getFile('dir'), /is a folder/);
});

test('putFile sends base64 content with sha and branch', async () => {
  const { fetchImpl, calls } = mockFetch({
    'PUT /repos/me/data/contents/tracker.json': () => [200, { content: { sha: 'new' }, commit: { sha: 'c1' } }],
  });
  const client = createGitHubClient({ token: 't', owner: 'me', repo: 'data', fetchImpl });
  const res = await client.putFile('tracker.json', { text: 'ü', sha: 'old', branch: 'data', message: 'msg' });
  assert.deepEqual(res, { sha: 'new', commit: 'c1' });
  assert.deepEqual(calls[0].body, { message: 'msg', content: encodeBase64('ü'), sha: 'old', branch: 'data' });
});

test('errors carry status and a helpful message', async () => {
  const { fetchImpl } = mockFetch({
    'GET /repos/me/data': () => [401, { message: 'Bad credentials' }],
  });
  const client = createGitHubClient({ token: 't', owner: 'me', repo: 'data', fetchImpl });
  await assert.rejects(client.getRepo(), (err) => err.status === 401 && /rejected the token/.test(err.message));

  const offline = createGitHubClient({ token: 't', owner: 'me', repo: 'data', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.getRepo(), (err) => err.status === 0 && /Could not reach GitHub/.test(err.message));
});

test('ensureBranch creates the branch from the default branch head', async () => {
  const { fetchImpl, calls } = mockFetch({
    'GET /repos/me/data': () => [200, { default_branch: 'main' }],
    'GET /repos/me/data/git/ref/heads/main': () => [200, { object: { sha: 'head' } }],
    'POST /repos/me/data/git/refs': () => [201, { ref: 'refs/heads/tracker' }],
  });
  const client = createGitHubClient({ token: 't', owner: 'me', repo: 'data', fetchImpl });
  assert.equal(await client.ensureBranch('tracker'), true);
  assert.deepEqual(calls.at(-1).body, { ref: 'refs/heads/tracker', sha: 'head' });
});

test('ensureBranch explains empty repositories', async () => {
  const { fetchImpl } = mockFetch({
    'GET /repos/me/data': () => [200, { default_branch: 'main' }],
    'GET /repos/me/data/git/ref/heads/main': () => [409, { message: 'Git Repository is empty.' }],
  });
  const client = createGitHubClient({ token: 't', owner: 'me', repo: 'data', fetchImpl });
  await assert.rejects(client.ensureBranch('tracker'), /repository is empty/);
});
