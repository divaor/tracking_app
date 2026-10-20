// Cloudflare Worker entry: a remote MCP server you can add to Claude as a
// custom connector. Configure with `wrangler secret put` (see mcp/README.md).
import { handleHttp } from './protocol.js';
import { createServerFromEnv } from './server.js';

export default {
  async fetch(request, env) {
    const { config, handle } = createServerFromEnv(env);
    return handleHttp(request, { handle, secret: config.secret, allowedOrigins: config.allowedOrigins });
  },
};
