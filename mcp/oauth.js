// OAuth 2.1 authorization server for the connector, following the MCP
// authorization spec: protected-resource metadata (RFC 9728), server metadata
// (RFC 8414), dynamic client registration (RFC 7591), authorization code with
// PKCE (S256) and refresh tokens. You approve a client once by entering the
// connector password (MCP_SECRET).
//
// Clients, codes and tokens are HMAC-signed and need no database. With an
// optional key-value store (Cloudflare KV binding OAUTH_KV) codes become
// single-use and refresh-token reuse is detected.

import { fromBase64Url, toBase64Url } from './push.js';

export const SCOPE = 'tracker';
const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 86400;
const CODE_TTL = 600;
const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'localhost', '127.0.0.1', '[::1]'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const enc = new TextEncoder();
const dec = new TextDecoder();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const randomId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers } });
const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status);

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function createOAuth({ secret, issuer, redirectHosts = [], store = null }) {
  const resource = `${issuer}/mcp`;
  const allowedHosts = [...DEFAULT_REDIRECT_HOSTS, ...redirectHosts];
  let keyPromise = null;
  const key = () =>
    (keyPromise ??= (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const derived = await crypto.subtle.sign('HMAC', base, enc.encode('tracker-oauth-v1'));
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })());

  async function seal(payload) {
    const body = toBase64Url(enc.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign('HMAC', await key(), enc.encode(body));
    return `${body}.${toBase64Url(sig)}`;
  }

  async function unseal(token, typ) {
    const [body, sig, extra] = String(token ?? '').split('.');
    if (!body || !sig || extra !== undefined) return null;
    let ok = false;
    try {
      ok = await crypto.subtle.verify('HMAC', await key(), fromBase64Url(sig), enc.encode(body));
    } catch {
      return null;
    }
    if (!ok) return null;
    let payload;
    try {
      payload = JSON.parse(dec.decode(fromBase64Url(body)));
    } catch {
      return null;
    }
    if (payload.typ !== typ) return null;
    if (payload.exp && payload.exp < nowSeconds()) return null;
    return payload;
  }

  function redirectAllowed(uri) {
    let u;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.hash) return false;
    const host = u.hostname.toLowerCase();
    if (LOOPBACK.has(host) || LOOPBACK.has(`[${host}]`)) return u.protocol === 'http:' || u.protocol === 'https:';
    if (u.protocol !== 'https:') return false;
    return allowedHosts.includes('*') || allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  // Registered loopback redirects match on any port (RFC 8252 section 7.3).
  function redirectMatches(registered, requested) {
    if (registered.includes(requested)) return true;
    let req;
    try {
      req = new URL(requested);
    } catch {
      return false;
    }
    if (!LOOPBACK.has(req.hostname) && !LOOPBACK.has(`[${req.hostname}]`)) return false;
    return registered.some((r) => {
      try {
        const reg = new URL(r);
        return reg.protocol === req.protocol && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
      } catch {
        return false;
      }
    });
  }

  async function loadClient(clientId) {
    const client = await unseal(clientId, 'client');
    return client && Array.isArray(client.r) ? { id: clientId, name: client.n || 'An MCP client', redirectUris: client.r } : null;
  }

  function protectedResourceMetadata() {
    return json({ resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Tracker' });
  }

  function serverMetadata() {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
      service_documentation: 'https://github.com/divaor/tracking_app/blob/HEAD/mcp/README.md',
    });
  }

  async function register(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return oauthError('invalid_client_metadata', 'Body must be JSON.');
    }
    const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (!redirectUris.length) return oauthError('invalid_redirect_uri', 'redirect_uris is required.');
    const bad = redirectUris.find((u) => !redirectAllowed(u));
    if (bad) return oauthError('invalid_redirect_uri', `Redirect URI not allowed: ${bad}. Allowed hosts: ${allowedHosts.join(', ')} (set OAUTH_REDIRECT_HOSTS to add more).`);
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : '';
    const issuedAt = nowSeconds();
    const clientId = await seal({ typ: 'client', n: name, r: redirectUris, iat: issuedAt });
    return json(
      {
        client_id: clientId,
        client_id_issued_at: issuedAt,
        client_name: name || undefined,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      },
      201,
    );
  }

  // Validates an authorization request; returns { params, client } or an error Response.
  async function checkAuthorizeRequest(params) {
    const client = await loadClient(params.get('client_id'));
    if (!client) return { error: page('Unknown app', '<p>This sign-in link is not valid (unknown client). Start the connection again from Claude.</p>', 400) };
    const redirectUri = params.get('redirect_uri') || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
      return { error: page('Invalid redirect', '<p>The app asked to return to an address it did not register. Start the connection again from Claude.</p>', 400) };
    }
    const back = (error, description) => ({ error: redirectWith(redirectUri, { error, error_description: description, state: params.get('state') }) });
    if (params.get('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (!params.get('code_challenge') || params.get('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE with S256 is required.');
    const requestedResource = params.get('resource');
    if (requestedResource && requestedResource.replace(/\/$/, '') !== resource) return back('invalid_target', `This server is ${resource}.`);
    return { client, redirectUri };
  }

  function redirectWith(uri, values) {
    const url = new URL(uri);
    for (const [k, v] of Object.entries(values)) if (v) url.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
  }

  function page(title, inner, status = 200) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Tracker</title><style>
:root{color-scheme:light dark;--bg:#f6f5f1;--card:#fff;--text:#1d1c19;--muted:#6b675f;--border:#e2dfd7;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#181816;--card:#22211e;--text:#ece9e2;--muted:#a9a49a;--border:#36342f;--accent:#8b85f5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:min(420px,100%);padding:28px;border:1px solid var(--border);border-radius:16px;background:var(--card)}
h1{margin:0 0 6px;font-size:21px}p{margin:0 0 12px;color:var(--muted)}strong{color:var(--text)}
label{display:block;margin:16px 0 6px;font-weight:600}input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:10px 14px;border-radius:9px;border:1px solid var(--border);background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.error{color:#c23b3b;font-weight:600}.brand{display:flex;gap:10px;align-items:center;margin-bottom:16px;font-weight:700}
.dot{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#4338ca)}</style></head>
<body><main><div class="brand"><span class="dot"></span>Tracker</div><h1>${escapeHtml(title)}</h1>${inner}</main></body></html>`;
    return new Response(html, {
      status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" },
    });
  }

  function consentPage(params, client, redirectUri, error = '') {
    const hidden = ['response_type', 'client_id', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
      .map((k) => (params.get(k) ? `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k))}">` : ''))
      .join('');
    const host = new URL(redirectUri).host;
    return page(
      'Allow access to your tracker?',
      `<p><strong>${escapeHtml(client.name)}</strong> wants to read and update your tasks, ideas, Claude work and documents. You will be sent back to <strong>${escapeHtml(host)}</strong>.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<label for="password">Connector password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<div class="row"><button type="submit" name="action" value="deny">Cancel</button><button class="primary" type="submit" name="action" value="allow">Allow</button></div></form>
<p style="margin-top:16px;font-size:13px">The password is the <code>MCP_SECRET</code> you set when you deployed the connector.</p>`,
      error ? 401 : 200,
    );
  }

  async function authorize(request) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      const checked = await checkAuthorizeRequest(url.searchParams);
      return checked.error ?? consentPage(url.searchParams, checked.client, checked.redirectUri);
    }
    const form = new URLSearchParams(await request.text());
    const checked = await checkAuthorizeRequest(form);
    if (checked.error) return checked.error;
    const { client, redirectUri } = checked;
    if (form.get('action') === 'deny') return redirectWith(redirectUri, { error: 'access_denied', state: form.get('state'), iss: issuer });
    if (!safeEqual(form.get('password') ?? '', String(secret))) return consentPage(form, client, redirectUri, 'That password is not right.');
    const code = await seal({ typ: 'code', cid: client.id, ru: redirectUri, cc: form.get('code_challenge'), aud: resource, exp: nowSeconds() + CODE_TTL, jti: randomId() });
    return redirectWith(redirectUri, { code, state: form.get('state'), iss: issuer });
  }

  async function issueTokens(clientId, family) {
    const jti = randomId();
    const now = nowSeconds();
    const accessToken = await seal({ typ: 'at', cid: clientId, sc: SCOPE, aud: resource, exp: now + ACCESS_TTL });
    const refreshToken = await seal({ typ: 'rt', cid: clientId, sc: SCOPE, aud: resource, exp: now + REFRESH_TTL, fam: family, jti });
    if (store) await store.put(`rt:${family}`, jti, REFRESH_TTL);
    return json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refreshToken, scope: SCOPE });
  }

  async function token(request) {
    const type = request.headers.get('content-type') ?? '';
    const form = type.includes('application/json') ? new URLSearchParams(await request.json().catch(() => ({}))) : new URLSearchParams(await request.text());
    const grant = form.get('grant_type');
    const requestedResource = form.get('resource');
    if (requestedResource && requestedResource.replace(/\/$/, '') !== resource) return oauthError('invalid_target', `This server is ${resource}.`);

    if (grant === 'authorization_code') {
      const code = await unseal(form.get('code'), 'code');
      if (!code) return oauthError('invalid_grant', 'The authorization code is invalid or expired.');
      if (form.get('client_id') && form.get('client_id') !== code.cid) return oauthError('invalid_grant', 'The code was issued to another client.');
      if (form.get('redirect_uri') && form.get('redirect_uri') !== code.ru) return oauthError('invalid_grant', 'redirect_uri does not match.');
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) || toBase64Url(await sha256(verifier)) !== code.cc) return oauthError('invalid_grant', 'PKCE verification failed.');
      if (store) {
        if (await store.get(`code:${code.jti}`)) return oauthError('invalid_grant', 'The authorization code was already used.');
        await store.put(`code:${code.jti}`, '1', CODE_TTL);
      }
      return issueTokens(code.cid, randomId());
    }

    if (grant === 'refresh_token') {
      const refresh = await unseal(form.get('refresh_token'), 'rt');
      if (!refresh) return oauthError('invalid_grant', 'The refresh token is invalid or expired.');
      if (form.get('client_id') && form.get('client_id') !== refresh.cid) return oauthError('invalid_grant', 'The refresh token was issued to another client.');
      if (store) {
        const current = await store.get(`rt:${refresh.fam}`);
        if (current && current !== refresh.jti) {
          await store.put(`rt:${refresh.fam}`, 'revoked', REFRESH_TTL);
          return oauthError('invalid_grant', 'The refresh token was already used.');
        }
      }
      return issueTokens(refresh.cid, refresh.fam);
    }

    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  /** Validates a bearer access token for the MCP endpoint. */
  async function verifyAccessToken(value) {
    const payload = await unseal(value, 'at');
    return payload && payload.aud === resource ? payload : null;
  }

  const challenge = (error) =>
    `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;

  return { resource, protectedResourceMetadata, serverMetadata, register, authorize, token, verifyAccessToken, challenge, cors: CORS };
}

/** Small key-value store for single-use codes and refresh-token rotation. */
export function kvStore(namespace) {
  return {
    get: (k) => namespace.get(k),
    put: (k, v, ttl) => namespace.put(k, v, { expirationTtl: Math.max(60, ttl) }),
  };
}

export function memoryStore() {
  const map = new Map();
  return {
    async get(k) {
      const entry = map.get(k);
      if (!entry || entry.exp < Date.now()) return null;
      return entry.value;
    },
    async put(k, value, ttl) {
      map.set(k, { value, exp: Date.now() + ttl * 1000 });
    },
  };
}
