// Minimal MCP server: JSON-RPC dispatch for tools and prompts. Transports
// (HTTP in router.js, stdio in stdio.js) feed messages to `handle`.

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
          // A result with its own content (a picture for Claude to look at) goes as it is.
          if (Array.isArray(result?.mcpContent)) return ok(id, { content: result.mcpContent });
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
