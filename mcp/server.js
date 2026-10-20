// Builds the tracker MCP server from environment variables. Shared by the
// Cloudflare Worker, the Node HTTP server and the stdio server.
import { createGitHubClient } from '../app/js/github.js';
import { createMcpServer } from './protocol.js';
import { createTracker } from './tracker.js';
import { createTools, INSTRUCTIONS, PROMPTS, SERVER_INFO } from './tools.js';

export function readConfig(env = {}) {
  const [owner = '', repo = ''] = String(env.TRACKER_REPO ?? '').trim().split('/');
  return {
    token: String(env.GITHUB_TOKEN ?? '').trim(),
    owner,
    repo,
    branch: String(env.TRACKER_BRANCH ?? '').trim(),
    path: String(env.TRACKER_PATH ?? '').trim() || 'tracker.json',
    filesDir: String(env.TRACKER_FILES_DIR ?? '').trim() || 'files',
    device: String(env.TRACKER_DEVICE ?? '').trim() || 'Claude',
    appUrl: String(env.TRACKER_APP_URL ?? '').trim(),
    secret: String(env.MCP_SECRET ?? ''),
    allowedOrigins: String(env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    apiBase: String(env.GITHUB_API_URL ?? '').trim() || 'https://api.github.com',
  };
}

export function configProblems(config) {
  const problems = [];
  if (!config.token) problems.push('GITHUB_TOKEN is not set');
  if (!config.owner || !config.repo) problems.push('TRACKER_REPO must be "owner/repo"');
  return problems;
}

export function createServerFromEnv(env, { fetchImpl } = {}) {
  const config = readConfig(env);
  const getTracker = async () => {
    const problems = configProblems(config);
    if (problems.length) throw new Error(`The tracker connector is not configured: ${problems.join('; ')}.`);
    const client = createGitHubClient({
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      apiBase: config.apiBase,
      fetchImpl,
      cacheMode: null,
      userAgent: `tracker-mcp/${SERVER_INFO.version}`,
    });
    return createTracker({ client, ...config });
  };
  return {
    config,
    handle: createMcpServer({ info: SERVER_INFO, instructions: INSTRUCTIONS, tools: createTools(getTracker), prompts: PROMPTS }),
  };
}
