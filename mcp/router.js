// HTTP front door for the connector, on web-standard Request/Response so it
// runs on Cloudflare Workers and Node alike:
//   /mcp                 MCP over Streamable HTTP (OAuth access token)
//   /mcp/<secret>        same, for clients that can only take a URL (legacy)
//   /.well-known/…, /register, /authorize, /token   OAuth (see oauth.js)
//   /push/config, /push/test                       push notifications
//   /upload/<token>      a file's bytes for attach_file (PUT, curl -T; the token is the permission)
import { createGitHubClient } from '../app/js/github.js';
import { MAX_ATTACH_BYTES } from './attach.js';
import { createOAuth } from './oauth.js';
import { UPLOAD_PATH } from './uploads.js';

const TRUSTED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const plain = (body, status, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
const bearer = (request) => (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

async function mcpPost(request, handle) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map(handle))).filter(Boolean);
  if (!responses.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}

export function createHttpHandler({ handle, config, notifier = null, oauthStore = null, fetchImpl, uploads = null, getTracker = null }) {
  return async function serve(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const issuer = (config.publicUrl || url.origin).replace(/\/+$/, '');
    const secret = config.secret;

    if (request.method === 'OPTIONS' && !path.startsWith('/mcp')) return new Response(null, { status: 204, headers: CORS });
    if (path === '/' && request.method === 'GET') return plain('Tracker MCP connector. Add this address + /mcp to Claude as a custom connector.\n', 200);
    if (!secret || secret.length < 16) return plain('MCP_SECRET is not configured (use at least 16 characters).\n', 500);

    if (path.startsWith(UPLOAD_PATH)) return upload(request, path.slice(UPLOAD_PATH.length));

    const oauth = createOAuth({ secret, issuer, redirectHosts: config.redirectHosts, store: oauthStore });

    switch (path) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        return oauth.protectedResourceMetadata();
      case '/.well-known/oauth-authorization-server':
      case '/.well-known/openid-configuration':
        return oauth.serverMetadata();
      case '/register':
        return request.method === 'POST' ? oauth.register(request) : plain('Method not allowed\n', 405, { Allow: 'POST' });
      case '/authorize':
        return request.method === 'GET' || request.method === 'POST' ? oauth.authorize(request) : plain('Method not allowed\n', 405);
      case '/token':
        return request.method === 'POST' ? oauth.token(request) : plain('Method not allowed\n', 405, { Allow: 'POST' });
      case '/push/config':
        if (!notifier) return json({ error: 'Push notifications are not available on this connector.' }, 404, CORS);
        return json({ vapidPublicKey: await notifier.publicKey() }, 200, { ...CORS, 'Cache-Control': 'no-store' });
      case '/push/test':
        return pushTest(request);
      default:
        break;
    }

    if (path !== '/mcp' && !path.startsWith('/mcp/')) return plain('Not found\n', 404);

    // Browsers send Origin; MCP clients usually do not. Requests from other
    // web pages are refused (the MCP spec requires checking Origin when present).
    const origin = request.headers.get('origin');
    if (origin && !TRUSTED_ORIGIN.test(origin) && !config.allowedOrigins.includes(origin)) return plain('Forbidden origin\n', 403);

    if (path === '/mcp') {
      const token = bearer(request);
      const authorized = token && (safeEqual(token, secret) || (await oauth.verifyAccessToken(token)));
      if (!authorized) return plain('Unauthorized\n', 401, { 'WWW-Authenticate': oauth.challenge(token ? 'invalid_token' : '') });
    } else {
      let given = '';
      try {
        given = decodeURIComponent(path.slice('/mcp/'.length));
      } catch {
        // malformed escape: treat as a wrong secret
      }
      if (!safeEqual(given, secret)) return plain('Not found\n', 404);
    }

    if (request.method !== 'POST') return plain('Method not allowed\n', 405, { Allow: 'POST' });
    return mcpPost(request, (message) => handle(message, { baseUrl: issuer }));
  };

  // A file sent to an upload link from attach_file: attached to the link's item under its name.
  async function upload(request, token) {
    if (request.method !== 'PUT' && request.method !== 'POST') return json({ ok: false, error: 'Send the file with PUT (curl -T <file> <link>).' }, 405, { Allow: 'PUT, POST' });
    if (!uploads || !getTracker) return json({ ok: false, error: 'Uploads are not available on this connector.' }, 404);
    let claims;
    try {
      claims = await uploads.open(token);
    } catch (err) {
      return json({ ok: false, error: err.message }, err.status ?? 401);
    }
    const tooBig = { ok: false, error: `The file is over the limit of ${MAX_ATTACH_BYTES / 1024 / 1024} MB.` };
    if (Number(request.headers.get('content-length')) > MAX_ATTACH_BYTES) return json(tooBig, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_ATTACH_BYTES) return json(tooBig, 413);
    try {
      const result = await (await getTracker()).attachBytes(claims.item, claims.name, bytes, { type: request.headers.get('content-type') ?? '' });
      await claims.spend();
      return json({ ok: true, ...result });
    } catch (err) {
      return json({ ok: false, error: err?.message ?? String(err) }, err?.status >= 500 ? 502 : 400);
    }
  }

  // Sends a test notification. The app proves it may do so with the GitHub
  // token it already uses for the data repository.
  async function pushTest(request) {
    if (request.method !== 'POST') return plain('Method not allowed\n', 405, { ...CORS, Allow: 'POST' });
    if (!notifier) return json({ ok: false, error: 'Push notifications are not available on this connector.' }, 404, CORS);
    const token = bearer(request);
    if (!token) return json({ ok: false, error: 'Missing GitHub token.' }, 401, CORS);
    const github = createGitHubClient({ token, owner: config.owner, repo: config.repo, apiBase: config.apiBase, fetchImpl, cacheMode: null, userAgent: 'tracker-mcp' });
    try {
      const info = await github.getRepo();
      if (String(info.full_name).toLowerCase() !== `${config.owner}/${config.repo}`.toLowerCase()) throw new Error('wrong repository');
    } catch {
      return json({ ok: false, error: `That GitHub token cannot access ${config.owner}/${config.repo}.` }, 403, CORS);
    }
    const body = await request.json().catch(() => ({}));
    return json(await notifier.test(String(body.deviceId ?? '')), 200, CORS);
  }
}
