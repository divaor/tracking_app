// In-memory stand-in for the parts of the GitHub REST API the editor uses:
// the Contents API (read at a ref, write) and the Git Data API (blobs, trees,
// commits, refs). Blob shas are real git blob shas; branch updates must be
// fast-forwards, like on GitHub.
import { createHash } from 'node:crypto';

const gitSha = (text) => {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

export function createFakeGitHub({ owner = 'me', repo = 'data', defaultBranch = 'main', token = 'good-token', empty = false } = {}) {
  const blobs = new Map(); // sha → text
  const trees = new Map(); // sha → Map(path → blob sha)
  const commits = new Map(); // sha → { tree, parents, message, date }
  let clock = Date.parse('2026-10-01T09:00:00Z'); // commit dates, a minute apart
  const refs = new Map(); // branch → commit sha
  const log = []; // commit messages, newest last
  const requests = [];
  const hooks = { beforeUpdateRef: null };
  let counter = 0;
  const id = (kind) => `${kind}${String(++counter).padStart(6, '0')}`;
  const base = `/repos/${owner}/${repo}`;
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function addBlob(text) {
    const sha = gitSha(text);
    blobs.set(sha, text);
    return sha;
  }

  function commitFiles(branch, changes, message) {
    const parent = refs.get(branch);
    const files = new Map(parent ? trees.get(commits.get(parent).tree) : []);
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) files.delete(path);
      else files.set(path, addBlob(text));
    }
    const tree = id('tree');
    trees.set(tree, files);
    const sha = id('commit');
    commits.set(sha, { tree, parents: parent ? [parent] : [], message, date: new Date((clock += 60000)).toISOString() });
    refs.set(branch, sha);
    log.push(message);
    return sha;
  }

  if (!empty) commitFiles(defaultBranch, { 'README.md': '# data\n' }, 'Initial commit');

  const resolve = (ref) => {
    const commit = commits.has(ref) ? ref : refs.get(ref || defaultBranch);
    return commit ? trees.get(commits.get(commit).tree) : null;
  };

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method, path: u.pathname });
    if (headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
    if (!u.pathname.startsWith(base)) return reply(404, { message: 'Not Found' });
    const rest = u.pathname.slice(base.length);

    if (rest === '' && method === 'GET') return reply(200, { full_name: `${owner}/${repo}`, private: true, default_branch: defaultBranch, permissions: { push: true } });

    let m;
    if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
      if (!refs.size) return reply(409, { message: 'Git Repository is empty.' });
      const sha = refs.get(decodeURIComponent(m[1]));
      return sha ? reply(200, { object: { sha } }) : reply(404, { message: 'Not Found' });
    }
    if ((m = rest.match(/^\/git\/commits\/(\w+)$/)) && method === 'GET') {
      const c = commits.get(m[1]);
      return c ? reply(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : reply(404, { message: 'Not Found' });
    }
    if ((m = rest.match(/^\/git\/blobs\/(\w+)$/)) && method === 'GET') {
      const text = blobs.get(m[1]);
      return text === undefined ? reply(404, { message: 'Not Found' }) : reply(200, { sha: m[1], encoding: 'base64', content: Buffer.from(text).toString('base64') });
    }
    if ((m = rest.match(/^\/git\/trees\/(\w+)$/)) && method === 'GET') {
      const files = trees.get(m[1]);
      return files ? reply(200, { sha: m[1], tree: [...files].map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644' })), truncated: false }) : reply(404, { message: 'Not Found' });
    }
    if (rest === '/git/trees' && method === 'POST') {
      const files = new Map(body.base_tree ? trees.get(body.base_tree) : []);
      if (body.base_tree && !trees.has(body.base_tree)) return reply(422, { message: 'Invalid base tree' });
      for (const entry of body.tree) {
        if (entry.content !== undefined) files.set(entry.path, addBlob(entry.content));
        else if (entry.sha === null) files.delete(entry.path);
        else if (blobs.has(entry.sha)) files.set(entry.path, entry.sha);
        else return reply(422, { message: `Invalid sha for ${entry.path}` });
      }
      const sha = id('tree');
      trees.set(sha, files);
      return reply(201, { sha });
    }
    if (rest === '/git/commits' && method === 'POST') {
      if (!trees.has(body.tree)) return reply(422, { message: 'Invalid tree' });
      const sha = id('commit');
      commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message, date: new Date((clock += 60000)).toISOString() });
      return reply(201, { sha });
    }
    if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const branch = decodeURIComponent(m[1]);
      hooks.beforeUpdateRef?.(branch);
      hooks.beforeUpdateRef = null;
      const current = refs.get(branch);
      const next = commits.get(body.sha);
      if (!next) return reply(422, { message: 'Object does not exist' });
      if (current && !body.force && !next.parents.includes(current)) return reply(422, { message: 'Update is not a fast forward' });
      refs.set(branch, body.sha);
      log.push(next.message);
      return reply(200, { object: { sha: body.sha } });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const branch = body.ref.replace('refs/heads/', '');
      if (refs.has(branch)) return reply(422, { message: 'Reference already exists' });
      refs.set(branch, body.sha);
      return reply(201, { ref: body.ref, object: { sha: body.sha } });
    }
    // Commits that changed a file or anything under a folder, newest first (first parents).
    if (rest === '/commits' && method === 'GET') {
      const path = u.searchParams.get('path') ?? '';
      const under = (files) => [...(files ?? new Map())].filter(([p]) => !path || p === path || p.startsWith(`${path}/`)).sort().join('|');
      const out = [];
      let sha = commits.has(u.searchParams.get('sha')) ? u.searchParams.get('sha') : refs.get(u.searchParams.get('sha') || defaultBranch);
      const limit = Number(u.searchParams.get('per_page') ?? 30);
      while (sha && out.length < limit) {
        const c = commits.get(sha);
        const parent = c.parents[0];
        if (under(trees.get(c.tree)) !== under(parent ? trees.get(commits.get(parent).tree) : null)) {
          out.push({ sha, commit: { message: c.message, committer: { date: c.date } } });
        }
        sha = parent;
      }
      return reply(200, out);
    }
    if ((m = rest.match(/^\/contents\/(.+)$/))) {
      const path = m[1].split('/').map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const files = resolve(u.searchParams.get('ref'));
        const sha = files?.get(path);
        if (!sha) {
          // A folder: its direct entries.
          const entries = new Map();
          for (const [p, blob] of files ?? []) {
            if (!p.startsWith(`${path}/`)) continue;
            const [name, ...deeper] = p.slice(path.length + 1).split('/');
            entries.set(name, deeper.length ? { name, path: `${path}/${name}`, sha: '', type: 'dir' } : { name, path: p, sha: blob, type: 'file' });
          }
          return entries.size ? reply(200, [...entries.values()]) : reply(404, { message: 'Not Found' });
        }
        return reply(200, { type: 'file', path, sha, size: Buffer.byteLength(blobs.get(sha)), content: Buffer.from(blobs.get(sha)).toString('base64') });
      }
      if (method === 'PUT') {
        const branch = body.branch ?? defaultBranch;
        const current = resolve(branch)?.get(path);
        if (current && body.sha !== current) return reply(409, { message: 'sha mismatch' });
        const commit = commitFiles(branch, { [path]: Buffer.from(body.content, 'base64').toString('utf8') }, body.message);
        return reply(current ? 200 : 201, { content: { sha: resolve(branch).get(path), path }, commit: { sha: commit } });
      }
    }
    return reply(404, { message: 'Not Found' });
  }

  return {
    fetch: fetchImpl,
    requests,
    log,
    hooks,
    gitSha,
    /** Text of a file at the tip of a branch (undefined when missing). */
    read: (path, branch = defaultBranch) => {
      const sha = resolve(branch)?.get(path);
      return sha ? blobs.get(sha) : undefined;
    },
    paths: (branch = defaultBranch) => [...(resolve(branch)?.keys() ?? [])].sort(),
    /** Commits files as "another device" would: { path: text | null }. */
    commit: (changes, message = 'Other device', branch = defaultBranch) => commitFiles(branch, changes, message),
    head: (branch = defaultBranch) => refs.get(branch),
  };
}
