// Cloudflare Worker entry: the remote MCP server you add to Claude as a
// custom connector. Configure with `wrangler secret put` (see mcp/README.md).
import { kvStore } from './oauth.js';
import { createServerFromEnv } from './server.js';

export default {
  async fetch(request, env, ctx) {
    const { http } = createServerFromEnv(env, {
      defer: (promise) => ctx.waitUntil(promise.catch((err) => console.warn('Background task failed', err))),
      oauthStore: env.OAUTH_KV ? kvStore(env.OAUTH_KV) : null,
    });
    return http(request);
  },
};
