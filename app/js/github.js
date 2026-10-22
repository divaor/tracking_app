// Minimal GitHub REST client: reads and writes a single file through the
// Contents API using a personal access token.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(value) {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const encodePath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function describeError(status, data, headers) {
  const detail = data?.message ? ` GitHub says: “${data.message}”.` : '';
  switch (status) {
    case 401:
      return 'GitHub rejected the token (401). Check that it was copied correctly and has not expired.';
    case 403:
      if (headers.get('x-ratelimit-remaining') === '0') return 'GitHub API rate limit reached. Sync will retry later.';
      return `Permission denied (403). The token needs “Contents: Read and write” access to this repository.${detail}`;
    case 404:
      return 'Not found (404). Check the owner, repository and branch, and that the token has access to that repository.';
    case 409:
      return `Conflict (409).${detail}`;
    case 422:
      return `GitHub refused the change (422).${detail}`;
    default:
      return `GitHub error ${status}.${detail}`;
  }
}

// `cacheMode` and `userAgent` differ by runtime: browsers need no-store (see
// below) and refuse a custom User-Agent; servers need a User-Agent for GitHub.
export function createGitHubClient({
  token,
  owner,
  repo,
  fetchImpl = globalThis.fetch.bind(globalThis),
  apiBase = 'https://api.github.com',
  cacheMode = 'no-store',
  userAgent = '',
}) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function request(method, path, { body, query } = {}) {
    const url = new URL(apiBase + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value) url.searchParams.set(key, value);
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (userAgent) headers['User-Agent'] = userAgent;
    // no-store: the API sends Cache-Control: max-age=60, and a cached read
    // would hand back a stale sha and make every write conflict.
    const init = { method, headers, body: body ? JSON.stringify(body) : undefined };
    if (cacheMode) init.cache = cacheMode;
    let res;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch {
      throw new GitHubError('Could not reach GitHub. Check your internet connection.', 0);
    }
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new GitHubError(describeError(res.status, data, res.headers), res.status);
    return data;
  }

  return {
    getRepo() {
      return request('GET', repoPath);
    },

    // Returns { sha, text } or null when the file (or branch) does not exist.
    async getFile(filePath, ref) {
      let data;
      try {
        data = await request('GET', `${repoPath}/contents/${encodePath(filePath)}`, { query: { ref } });
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      if (Array.isArray(data) || data?.type !== 'file') {
        throw new GitHubError(`“${filePath}” in ${owner}/${repo} is a folder, not a file. Choose a file path such as tracker.json.`, 400);
      }
      let content = data.content;
      if (!content && data.size > 0) {
        // Files over 1 MB come back without inline content; the blob API has them.
        content = (await request('GET', `${repoPath}/git/blobs/${data.sha}`)).content;
      }
      return { sha: data.sha, text: decodeBase64(content ?? '') };
    },

    async putFile(filePath, { text, sha, branch, message }) {
      const body = { message, content: encodeBase64(text) };
      if (sha) body.sha = sha;
      if (branch) body.branch = branch;
      const data = await request('PUT', `${repoPath}/contents/${encodePath(filePath)}`, { body });
      return { sha: data?.content?.sha ?? null, commit: data?.commit?.sha ?? null };
    },

    async deleteFile(filePath, { sha, branch, message }) {
      const body = { message, sha };
      if (branch) body.branch = branch;
      await request('DELETE', `${repoPath}/contents/${encodePath(filePath)}`, { body });
    },

    // Creates `branch` from the default branch if it does not exist yet.
    async ensureBranch(branch) {
      try {
        await request('GET', `${repoPath}/branches/${encodePath(branch)}`);
        return false;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      const info = await request('GET', repoPath);
      if (info.default_branch === branch) return false;
      let base;
      try {
        base = await request('GET', `${repoPath}/git/ref/heads/${encodePath(info.default_branch)}`);
      } catch (err) {
        if (err.status === 409 || err.status === 404) {
          throw new GitHubError('The repository is empty. Leave “Branch” blank for the first sync, or add a README to the repository first.', 409);
        }
        throw err;
      }
      await request('POST', `${repoPath}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });
      return true;
    },
  };
}
