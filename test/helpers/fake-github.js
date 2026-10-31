// In-memory stand-in for the parts of the GitHub REST API the tracker uses.
// `fetch` can be passed as fetchImpl; `listen` serves it over HTTP for
// out-of-process tests (the stdio server).
import { createServer } from 'node:http';

export function createFakeGitHub({ owner = 'me', repo = 'data', defaultBranch = 'main', token = 'good-token' } = {}) {
  const branches = new Map([[defaultBranch, new Map()]]);
  const commits = [];
  const requests = [];
  const failures = [];
  let version = 0;
  const base = `/repos/${owner}/${repo}`;
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ method, path: u.pathname, headers });
    if (headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });

    if (u.pathname === base && method === 'GET') {
      return reply(200, { full_name: `${owner}/${repo}`, private: true, default_branch: defaultBranch, permissions: { push: true } });
    }
    if (u.pathname.startsWith(`${base}/branches/`)) {
      const name = decodeURIComponent(u.pathname.slice(`${base}/branches/`.length));
      return branches.has(name) ? reply(200, { name }) : reply(404, { message: 'Branch not found' });
    }
    if (u.pathname.startsWith(`${base}/git/ref/heads/`)) return reply(200, { object: { sha: `head-${version}` } });
    if (u.pathname.startsWith(`${base}/git/blobs/`) && method === 'GET') {
      const sha = u.pathname.slice(`${base}/git/blobs/`.length);
      for (const files of branches.values()) {
        for (const file of files.values()) {
          if (file.sha === sha) return reply(200, { sha, encoding: 'base64', content: (file.bytes ?? Buffer.from(file.text)).toString('base64') });
        }
      }
      return reply(404, { message: 'Not Found' });
    }
    if (u.pathname === `${base}/git/refs` && method === 'POST') {
      const body = JSON.parse(init.body);
      const name = body.ref.replace('refs/heads/', '');
      branches.set(name, new Map(branches.get(defaultBranch)));
      return reply(201, { ref: body.ref });
    }
    if (u.pathname.startsWith(`${base}/contents/`)) {
      const path = decodeURIComponent(u.pathname.slice(`${base}/contents/`.length));
      if (method === 'GET') {
        const files = branches.get(u.searchParams.get('ref') ?? defaultBranch);
        const file = files?.get(path);
        if (!file) {
          // A folder: its entries, as the contents API lists them.
          const prefix = `${path.replace(/\/+$/, '')}/`;
          const names = new Map();
          for (const [p, f] of files ?? []) {
            if (!p.startsWith(prefix)) continue;
            const [name, ...rest] = p.slice(prefix.length).split('/');
            if (!names.has(name)) names.set(name, rest.length ? { name, path: `${prefix}${name}`, type: 'dir', sha: '' } : { name, path: p, type: 'file', sha: f.sha });
          }
          if (names.size) return reply(200, [...names.values()]);
          return reply(404, { message: 'Not Found' });
        }
        const bytes = file.bytes ?? Buffer.from(file.text);
        return reply(200, { type: 'file', sha: file.sha, size: bytes.length, content: bytes.toString('base64') });
      }
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        const failure = failures.findIndex((f) => f.path === path);
        if (failure >= 0) {
          const [{ status, beforeFail }] = failures.splice(failure, 1);
          beforeFail?.();
          return reply(status, { message: 'injected failure' });
        }
        const files = branches.get(body.branch ?? defaultBranch);
        if (!files) return reply(404, { message: 'Branch not found' });
        const current = files.get(path);
        if (current && !body.sha) return reply(422, { message: '"sha" wasn\'t supplied.' });
        if (current && body.sha !== current.sha) return reply(409, { message: 'sha mismatch' });
        const sha = `sha-${++version}`;
        const bytes = Buffer.from(body.content, 'base64');
        files.set(path, { text: bytes.toString('utf8'), bytes, sha });
        commits.push({ path, message: body.message, branch: body.branch ?? defaultBranch });
        return reply(current ? 200 : 201, { content: { sha, path }, commit: { sha: `commit-${version}` } });
      }
      if (method === 'DELETE') {
        const body = JSON.parse(init.body);
        const files = branches.get(body.branch ?? defaultBranch);
        const current = files?.get(path);
        if (!current) return reply(404, { message: 'Not Found' });
        if (body.sha !== current.sha) return reply(409, { message: 'sha mismatch' });
        files.delete(path);
        version++;
        commits.push({ path, message: body.message, branch: body.branch ?? defaultBranch, deleted: true });
        return reply(200, { content: null, commit: { sha: `commit-${version}` } });
      }
    }
    return reply(404, { message: 'Not Found' });
  }

  return {
    fetch: fetchImpl,
    commits,
    requests,
    branches,
    read: (path, branch = defaultBranch) => branches.get(branch)?.get(path)?.text,
    write(path, text, branch = defaultBranch) {
      branches.get(branch).set(path, { text, sha: `sha-${++version}` });
    },
    /** Puts bytes (a picture…) at `path`; returns its sha. */
    writeBytes(path, bytes, branch = defaultBranch) {
      const sha = `sha-${++version}`;
      branches.get(branch).set(path, { text: Buffer.from(bytes).toString('utf8'), bytes: Buffer.from(bytes), sha });
      return sha;
    },
    readBytes: (path, branch = defaultBranch) => branches.get(branch)?.get(path)?.bytes,
    failNextPut(path, status, beforeFail) {
      failures.push({ path, status, beforeFail });
    },
    // Serves the fake over HTTP; resolves to { url, close }.
    listen() {
      const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const response = await fetchImpl(`http://fake${req.url}`, {
          method: req.method,
          headers: req.headers,
          body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
        });
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(await response.text());
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
      });
    },
  };
}
