// Builds the tracker MCP server from environment variables. Shared by the
// Cloudflare Worker, the Node HTTP server and the stdio server.
import { DEFAULT_EDITOR_URL } from '../app/js/editorLinks.js';
import { createGitHubClient } from '../app/js/github.js';
import { createNotifier } from './notify.js';
import { createMcpServer } from './protocol.js';
import { createHttpHandler } from './router.js';
import { createTracker } from './tracker.js';
import { createTools, INSTRUCTIONS, PROMPTS, SERVER_INFO } from './tools.js';
import { createUploads } from './uploads.js';

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
    editorUrl: String(env.TRACKER_EDITOR_URL ?? '').trim() || DEFAULT_EDITOR_URL,
    secret: String(env.MCP_SECRET ?? ''),
    allowedOrigins: list(env.MCP_ALLOWED_ORIGINS),
    redirectHosts: list(env.OAUTH_REDIRECT_HOSTS),
    publicUrl: String(env.MCP_PUBLIC_URL ?? '').trim(),
    vapidSubject: String(env.VAPID_SUBJECT ?? '').trim(),
    apiBase: String(env.GITHUB_API_URL ?? '').trim() || 'https://api.github.com',
  };
}

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

export function configProblems(config) {
  const problems = [];
  if (!config.token) problems.push('GITHUB_TOKEN is not set');
  if (!config.owner || !config.repo) problems.push('TRACKER_REPO must be "owner/repo"');
  return problems;
}

/**
 * @param env        environment variables (Worker env or process.env)
 * @param fetchImpl  fetch used for GitHub and push services (tests inject one)
 * @param defer      keeps background work (push notifications) alive after the
 *                   response; on Workers this is ctx.waitUntil
 * @param oauthStore optional key-value store for OAuth (see oauth.js)
 */
export function createServerFromEnv(env, { fetchImpl, defer = (p) => p.catch((err) => console.warn(err)), oauthStore = null } = {}) {
  const config = readConfig(env);
  const configured = configProblems(config).length === 0;
  const github = () =>
    createGitHubClient({
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      apiBase: config.apiBase,
      fetchImpl,
      cacheMode: null,
      userAgent: `tracker-mcp/${SERVER_INFO.version}`,
    });
  const notifier =
    configured && config.secret.length >= 16
      ? createNotifier({
          client: github(),
          path: config.path,
          branch: config.branch,
          secret: config.secret,
          subject: config.vapidSubject || config.appUrl || `https://github.com/${config.owner}/${config.repo}`,
          fetchImpl,
        })
      : null;
  const getTracker = async () => {
    const problems = configProblems(config);
    if (problems.length) throw new Error(`The tracker connector is not configured: ${problems.join('; ')}.`);
    const onChange = (events) => {
      if (notifier && events.length) defer(notifier.notify(events));
    };
    return createTracker({ client: github(), ...config, onChange, fetchImpl });
  };
  const uploads = config.secret.length >= 16 ? createUploads({ secret: config.secret, store: oauthStore }) : null;
  const handle = createMcpServer({ info: SERVER_INFO, instructions: INSTRUCTIONS, tools: createTools(getTracker, { uploads }), prompts: PROMPTS });
  return { config, handle, notifier, http: createHttpHandler({ handle, config, notifier, oauthStore, fetchImpl, uploads, getTracker }) };
}
