import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServerFromEnv } from '../mcp/server.js';
import { memoryStore } from '../mcp/oauth.js';
import { createFakeGitHub } from './helpers/fake-github.js';

const SECRET = 'connector-password-0123456789';
const BASE = 'https://tracker-mcp.example.workers.dev';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function setup({ store = null, env = {} } = {}) {
  const github = createFakeGitHub();
  const { http } = createServerFromEnv(
    { GITHUB_TOKEN: 'good-token', TRACKER_REPO: 'me/data', MCP_SECRET: SECRET, ...env },
    { fetchImpl: github.fetch, defer: (p) => p, oauthStore: store },
  );
  const request = (path, init = {}) => http(new Request(`${BASE}${path}`, init));
  const form = (path, values) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });
  return { http, request, form };
}

const pkce = () => {
  const verifier = createHash('sha256').update(String(Math.random())).digest('base64url') + 'xyz-padding-to-make-it-long';
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(s, redirect = CLAUDE_CALLBACK, name = 'Claude') {
  const res = await s.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) });
  return { res, body: await res.json() };
}

async function authorizeAndExchange(s, { redirect = CLAUDE_CALLBACK } = {}) {
  const { body: client } = await register(s, redirect);
  const { verifier, challenge } = pkce();
  const params = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'tracker',
    resource: `${BASE}/mcp`,
  };
  const allowed = await s.form('/authorize', { ...params, password: SECRET, action: 'allow' });
  assert.equal(allowed.status, 302);
  const location = new URL(allowed.headers.get('location'));
  const code = location.searchParams.get('code');
  const tokens = await s.form('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect, resource: `${BASE}/mcp` });
  return { client, params, verifier, code, location, tokenResponse: tokens, tokens: await tokens.json() };
}

const mcpCall = (s, token) =>
  s.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

test('discovery: 401 challenge, protected resource and server metadata', async () => {
  const s = setup();
  const res = await s.request('/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="tracker"`);

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const prm = await (await s.request(path)).json();
    assert.equal(prm.resource, `${BASE}/mcp`);
    assert.deepEqual(prm.authorization_servers, [BASE]);
  }
  const meta = await (await s.request('/.well-known/oauth-authorization-server')).json();
  assert.equal(meta.issuer, BASE);
  assert.equal(meta.token_endpoint, `${BASE}/token`);
  assert.equal(meta.registration_endpoint, `${BASE}/register`);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(meta.client_id_metadata_document_supported, undefined, 'CIMD is not advertised; Claude uses registration');
  assert.equal((await s.request('/.well-known/openid-configuration')).status, 200);
  assert.equal((await s.request('/token', { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), '*');
});

test('registration accepts Claude and loopback redirects only (by default)', async () => {
  const s = setup();
  const ok = await register(s);
  assert.equal(ok.res.status, 201);
  assert.equal(ok.body.token_endpoint_auth_method, 'none');
  assert.equal((await register(s, 'http://localhost:51234/callback')).res.status, 201);
  assert.equal((await register(s, 'http://127.0.0.1/callback')).res.status, 201);
  const evil = await register(s, 'https://evil.example/cb');
  assert.equal(evil.res.status, 400);
  assert.equal(evil.body.error, 'invalid_redirect_uri');
  assert.equal((await register(s, 'http://claude.ai/cb')).res.status, 400, 'plain http only for loopback');
  assert.equal((await register(setup({ env: { OAUTH_REDIRECT_HOSTS: 'example.org' } }), 'https://app.example.org/cb')).res.status, 201);
});

test('consent page escapes client input and checks the password', async () => {
  const s = setup();
  const { body: client } = await register(s, CLAUDE_CALLBACK, '<img src=x onerror=alert(1)>');
  const { challenge } = pkce();
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });
  const page = await s.request(`/authorize?${params}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.ok(!html.includes('<img src=x'), 'client name is escaped');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /claude\.ai/);

  const wrong = await s.form('/authorize', { ...Object.fromEntries(params), password: 'nope', action: 'allow' });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /not right/);

  const denied = await s.form('/authorize', { ...Object.fromEntries(params), password: '', action: 'deny' });
  assert.equal(denied.status, 302);
  const deniedUrl = new URL(denied.headers.get('location'));
  assert.equal(deniedUrl.searchParams.get('error'), 'access_denied');
  assert.equal(deniedUrl.searchParams.get('state'), 's1');

  const noPkce = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK });
  const res = await s.request(`/authorize?${noPkce}`);
  assert.equal(new URL(res.headers.get('location')).searchParams.get('error'), 'invalid_request');

  const otherRedirect = new URLSearchParams({ ...Object.fromEntries(params), redirect_uri: 'https://claude.ai/other' });
  assert.equal((await s.request(`/authorize?${otherRedirect}`)).status, 400, 'unregistered redirect is not followed');
  assert.equal((await s.request(`/authorize?client_id=forged.sig&redirect_uri=${CLAUDE_CALLBACK}`)).status, 400);
});

test('full authorization code flow with PKCE, then MCP with the access token', async () => {
  const s = setup();
  const flow = await authorizeAndExchange(s);
  assert.equal(flow.location.origin + flow.location.pathname, CLAUDE_CALLBACK);
  assert.equal(flow.location.searchParams.get('state'), 'xyz');
  assert.equal(flow.location.searchParams.get('iss'), BASE);
  assert.equal(flow.tokenResponse.status, 200);
  assert.equal(flow.tokens.token_type, 'Bearer');
  assert.equal(flow.tokens.expires_in, 3600);
  assert.ok(flow.tokens.refresh_token);

  const res = await mcpCall(s, flow.tokens.access_token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.tools.length, 10);

  const tampered = flow.tokens.access_token.slice(0, -2) + (flow.tokens.access_token.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await mcpCall(s, tampered)).status, 401);
  assert.equal((await mcpCall(s, flow.tokens.refresh_token)).status, 401, 'refresh tokens are not access tokens');

  const otherServer = createServerFromEnv({ GITHUB_TOKEN: 't', TRACKER_REPO: 'me/data', MCP_SECRET: SECRET }, { defer: (p) => p }).http;
  const elsewhere = await otherServer(new Request('https://other.example/mcp', { method: 'POST', headers: { authorization: `Bearer ${flow.tokens.access_token}` }, body: '{}' }));
  assert.equal(elsewhere.status, 401, 'tokens are bound to this server (audience)');
});

test('token endpoint rejects bad verifiers, mismatched clients and wrong resources', async () => {
  const s = setup();
  const { body: client } = await register(s);
  const { challenge } = pkce();
  const allowed = await s.form('/authorize', { response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', password: SECRET, action: 'allow' });
  const code = new URL(allowed.headers.get('location')).searchParams.get('code');
  const bad = await s.form('/token', { grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(50), client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK });
  assert.equal((await bad.json()).error, 'invalid_grant');
  const { body: other } = await register(s);
  const mismatch = await s.form('/token', { grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(50), client_id: other.client_id });
  assert.equal((await mismatch.json()).error, 'invalid_grant');
  const target = await s.form('/token', { grant_type: 'authorization_code', code, resource: 'https://elsewhere.example/mcp' });
  assert.equal((await target.json()).error, 'invalid_target');
  assert.equal((await (await s.form('/token', { grant_type: 'password' })).json()).error, 'unsupported_grant_type');
});

test('refresh tokens rotate; with a store, codes are single-use and reuse is detected', async () => {
  const stateless = setup();
  const first = await authorizeAndExchange(stateless);
  const refreshed = await (await stateless.form('/token', { grant_type: 'refresh_token', refresh_token: first.tokens.refresh_token, client_id: first.client.client_id })).json();
  assert.ok(refreshed.access_token);
  assert.notEqual(refreshed.refresh_token, first.tokens.refresh_token);
  assert.equal((await mcpCall(stateless, refreshed.access_token)).status, 200);

  const s = setup({ store: memoryStore() });
  const flow = await authorizeAndExchange(s);
  const again = await s.form('/token', { grant_type: 'authorization_code', code: flow.code, code_verifier: flow.verifier, client_id: flow.client.client_id, redirect_uri: CLAUDE_CALLBACK });
  assert.equal((await again.json()).error, 'invalid_grant', 'code reuse');

  const r1 = await (await s.form('/token', { grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token })).json();
  assert.ok(r1.refresh_token);
  const reuse = await (await s.form('/token', { grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token })).json();
  assert.equal(reuse.error, 'invalid_grant', 'old refresh token is dead');
  const afterReuse = await (await s.form('/token', { grant_type: 'refresh_token', refresh_token: r1.refresh_token })).json();
  assert.equal(afterReuse.error, 'invalid_grant', 'reuse revokes the whole family');
});

test('Claude Code style loopback redirect works on any port', async () => {
  const s = setup();
  const { body: client } = await register(s, 'http://localhost/callback');
  const { verifier, challenge } = pkce();
  const allowed = await s.form('/authorize', { response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:43123/callback', code_challenge: challenge, code_challenge_method: 'S256', password: SECRET, action: 'allow' });
  assert.equal(allowed.status, 302);
  const location = new URL(allowed.headers.get('location'));
  assert.equal(location.port, '43123');
  const tokens = await (await s.form('/token', { grant_type: 'authorization_code', code: location.searchParams.get('code'), code_verifier: verifier, redirect_uri: 'http://localhost:43123/callback' })).json();
  assert.ok(tokens.access_token);
});

test('expired access tokens are refused', async () => {
  const s = setup();
  const flow = await authorizeAndExchange(s);
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600 * 1000;
  try {
    assert.equal((await mcpCall(s, flow.tokens.access_token)).status, 401);
  } finally {
    Date.now = realNow;
  }
});

test('the legacy secret URL and raw secret bearer keep working', async () => {
  const s = setup();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal((await s.request(`/mcp/${SECRET}`, { method: 'POST', body })).status, 200);
  assert.equal((await s.request('/mcp', { method: 'POST', body, headers: { authorization: `Bearer ${SECRET}` } })).status, 200);
});
