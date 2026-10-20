// Minimal MCP server: JSON-RPC dispatch for tools and prompts, plus a
// stateless Streamable HTTP handler built on web-standard Request/Response so
// it runs on Cloudflare Workers and Node alike.

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function createMcpServer({ info, instructions, tools, prompts = [] }) {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const promptsByName = new Map(prompts.map((p) => [p.name, p]));

  return async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return fail(message?.id ?? null, -32600, 'Invalid request');
    }
    // Notifications and responses from the client need no answer.
    if (message.method === undefined || message.id === undefined || message.id === null) return null;
    const { id, method, params = {} } = message;

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: info,
          instructions,
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        });
      case 'tools/call': {
        const tool = toolsByName.get(params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const result = await tool.run(params.arguments ?? {});
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return ok(id, { content: [{ type: 'text', text }] });
        } catch (err) {
          // Tool failures are reported to the model so it can correct course.
          return ok(id, { content: [{ type: 'text', text: `Error: ${err?.message ?? err}` }], isError: true });
        }
      }
      case 'prompts/list':
        return ok(id, { prompts: prompts.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) });
      case 'prompts/get': {
        const prompt = promptsByName.get(params.name);
        if (!prompt) return fail(id, -32602, `Unknown prompt: ${params.name}`);
        return ok(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.text(params.arguments ?? {}) } }] });
      }
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'resources/templates/list':
        return ok(id, { resourceTemplates: [] });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const plain = (body, status, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

const TRUSTED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Browsers send Origin; MCP clients usually do not. Requests from other web
// pages are refused (the MCP spec requires checking Origin when present).
function originAllowed(origin, extra) {
  return !origin || TRUSTED_ORIGIN.test(origin) || extra.includes(origin);
}

/**
 * Serves MCP over Streamable HTTP at `/mcp/<secret>` (for connectors that can
 * only take a URL) or at `/mcp` with `Authorization: Bearer <secret>`.
 */
export async function handleHttp(request, { handle, secret, allowedOrigins = [] }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (!originAllowed(request.headers.get('origin'), allowedOrigins)) return plain('Forbidden origin\n', 403);

  if (path === '/' && request.method === 'GET') return plain('Tracker MCP server. Connect your MCP client to /mcp/<secret>.\n', 200);
  if (path !== '/mcp' && !path.startsWith('/mcp/')) return plain('Not found\n', 404);
  if (!secret || secret.length < 16) return plain('MCP_SECRET is not configured (use at least 16 characters).\n', 500);

  if (path === '/mcp') {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!auth || !safeEqual(token, secret)) return plain('Unauthorized\n', 401);
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

  let body;
  try {
    body = await request.json();
  } catch {
    return json(fail(null, -32700, 'Parse error'), 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map(handle))).filter(Boolean);
  if (!responses.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}
