// The data repo kept on this device instead of GitHub ("on this computer" mode):
// the same files (tracker.json, editor/index.json, editor/files/…, files/…) in a
// small git-like store, with the calls the two apps' sync code makes to GitHub
// (github.js), so that code runs unchanged. Blobs are kept by their git blob sha
// (the same as GitHub's for the same text), trees as changes from the tree
// before them, branch heads move by compare-and-swap. A backend keeps the
// objects: a folder through the desktop app's main process, IndexedDB in the
// browser, memory in the tests. Pure, so the Node tests can import it. The
// tracker and the editor keep the same copy of this file.
import { GitHubError } from './github.js';

const DEFAULT_BRANCH = 'main';
// A full tree every so many changes, so reading one never walks far.
const SNAPSHOT_EVERY = 64;
// History kept: commits older than this are dropped by prune(), the last one before it stays as the first.
export const KEEP_DAYS = 180;
// Objects younger than this are never removed (another app may be in the middle of a sync).
const GRACE_MS = 24 * 60 * 60 * 1000;

/** The git blob sha of a text: sha1("blob <bytes>\0" + text). */
export async function blobSha(text) {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return hex(new Uint8Array(digest));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const newId = () => hex(globalThis.crypto.getRandomValues(new Uint8Array(20)));

/**
 * A backend in memory: { get, put, cas, del, list }. `list(prefix)` gives
 * [{ key, time }]; `cas(key, expected, value)` writes only when the key holds
 * `expected` (null: missing) and says whether it did.
 */
export function memoryBackend(now = () => Date.now()) {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.get(key)?.value ?? null;
    },
    async put(key, value) {
      map.set(key, { value, time: now() });
    },
    async cas(key, expected, value) {
      if ((map.get(key)?.value ?? null) !== expected) return false;
      map.set(key, { value, time: now() });
      return true;
    },
    async del(key) {
      map.delete(key);
    },
    async list(prefix) {
      return [...map].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, time: v.time }));
    },
  };
}

/**
 * The store as a client with github.js's calls: getRepo, getBranchHead,
 * getCommitTree, getFile, getBlobText, listDir, listCommits, createTree,
 * createCommit, updateBranch, createBranch, putFile, deleteFile, ensureBranch;
 * plus listTree (every file at a ref), getMeta/setMeta and prune.
 */
export function createLocalRepo(backend, { now = () => new Date().toISOString() } = {}) {
  const trees = new Map(); // id → Map(path → sha), the last few read
  const json = async (key) => {
    const raw = await backend.get(key);
    return raw === null ? null : JSON.parse(raw);
  };
  const remember = (id, map) => {
    trees.set(id, map);
    if (trees.size > 24) trees.delete(trees.keys().next().value);
    return map;
  };
  const notFound = (what) => new GitHubError(`${what} is not in the data on this device.`, 404);

  async function readTree(id) {
    if (trees.has(id)) return trees.get(id);
    const tree = await json(`tree/${id}`);
    if (!tree) throw notFound('A folder listing');
    if (tree.full) return remember(id, new Map(Object.entries(tree.full)));
    const map = new Map(await readTree(tree.base));
    for (const [path, sha] of Object.entries(tree.set ?? {})) map.set(path, sha);
    for (const path of tree.del ?? []) map.delete(path);
    return remember(id, map);
  }

  async function readCommit(id) {
    const commit = await json(`commit/${id}`);
    if (!commit) throw notFound('A version');
    return commit;
  }

  const getMeta = async () => (await json('meta')) ?? {};
  const defaultBranch = async () => (await getMeta()).defaultBranch || DEFAULT_BRANCH;
  const head = (branch) => backend.get(`ref/${branch}`);

  /** A ref (branch, commit id, or nothing: the default branch) as a commit id, or null. */
  async function resolve(ref) {
    if (!ref) return head(await defaultBranch());
    const tip = await head(ref);
    if (tip) return tip;
    return (await backend.get(`commit/${ref}`)) !== null ? ref : null;
  }

  async function treeAt(ref) {
    const commit = await resolve(ref);
    return commit ? readTree((await readCommit(commit)).tree) : null;
  }

  async function storeBlob(text) {
    const sha = await blobSha(text);
    if ((await backend.get(`blob/${sha}`)) === null) await backend.put(`blob/${sha}`, text);
    return sha;
  }

  async function writeTree(baseId, set, del) {
    const id = newId();
    const base = baseId ? await json(`tree/${baseId}`) : null;
    const depth = base ? (base.full ? 0 : (base.depth ?? 0)) + 1 : 0;
    if (!baseId || depth >= SNAPSHOT_EVERY) {
      const map = baseId ? new Map(await readTree(baseId)) : new Map();
      for (const [path, sha] of Object.entries(set)) map.set(path, sha);
      for (const path of del) map.delete(path);
      await backend.put(`tree/${id}`, JSON.stringify({ full: Object.fromEntries(map) }));
      remember(id, map);
    } else {
      await backend.put(`tree/${id}`, JSON.stringify({ base: baseId, set, del, depth }));
    }
    return id;
  }

  async function commitOn(branch, tip, set, del, message) {
    const tree = await writeTree(tip ? (await readCommit(tip)).tree : null, set, del);
    const id = newId();
    await backend.put(`commit/${id}`, JSON.stringify({ tree, parents: tip ? [tip] : [], message, date: now() }));
    return (await backend.cas(`ref/${branch}`, tip ?? null, id)) ? id : null;
  }

  // The paths a commit changed: its tree's own changes, or the difference with its parent's.
  async function changedPaths(commit) {
    const tree = await json(`tree/${commit.tree}`);
    const parent = commit.parents[0] ? await readCommit(commit.parents[0]) : null;
    if (tree && !tree.full && parent && tree.base === parent.tree) return [...Object.keys(tree.set ?? {}), ...(tree.del ?? [])];
    const after = await readTree(commit.tree);
    const before = parent ? await readTree(parent.tree) : new Map();
    const out = [...after].filter(([p, sha]) => before.get(p) !== sha).map(([p]) => p);
    for (const p of before.keys()) if (!after.has(p)) out.push(p);
    return out;
  }

  const client = {
    local: true,

    async getRepo() {
      return { default_branch: await defaultBranch(), full_name: 'this device', private: true };
    },

    getBranchHead: (branch) => head(branch),

    async getCommitTree(commitSha) {
      return (await readCommit(commitSha)).tree;
    },

    /** { sha, text } of a file at a ref, or null when it does not exist. */
    async getFile(filePath, ref) {
      const map = await treeAt(ref);
      if (!map) return null;
      const sha = map.get(filePath);
      if (!sha) {
        if ([...map.keys()].some((p) => p.startsWith(`${filePath}/`))) throw new GitHubError(`“${filePath}” is a folder, not a file.`, 400);
        return null;
      }
      return { sha, text: await client.getBlobText(sha) };
    },

    async getBlobText(sha) {
      const text = await backend.get(`blob/${sha}`);
      if (text === null) throw notFound('A file version');
      return text;
    },

    /** Every file at a ref: [{ path, sha }] (empty when there is nothing yet). */
    async listTree(ref) {
      const map = await treeAt(ref);
      return map ? [...map].map(([path, sha]) => ({ path, sha })) : [];
    },

    async listDir(dirPath, ref) {
      const map = await treeAt(ref);
      if (!map) return null;
      const prefix = dirPath ? `${dirPath.replace(/\/+$/, '')}/` : '';
      const entries = new Map();
      for (const [path, sha] of map) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split('/');
        if (!entries.has(name)) entries.set(name, rest.length ? { name, path: prefix + name, sha: '', type: 'dir' } : { name, path, sha, type: 'file' });
      }
      return entries.size ? [...entries.values()] : null;
    },

    /** Commits that touched `path` (a file or a folder), newest first: [{ sha, message, date }]. */
    async listCommits({ path: filePath = '', branch, perPage = 50 }) {
      const out = [];
      let id = await resolve(branch);
      const inside = (p) => !filePath || p === filePath || p.startsWith(`${filePath.replace(/\/+$/, '')}/`);
      while (id && out.length < perPage) {
        const commit = await json(`commit/${id}`);
        if (!commit) break;
        if ((await changedPaths(commit)).some(inside)) out.push({ sha: id, message: commit.message, date: commit.date });
        id = commit.parents[0] ?? null;
      }
      return out;
    },

    /** A tree from `baseTree` plus changes: { path, content } writes, { path, sha } points at a blob, { path, sha: null } deletes. */
    async createTree(baseTree, changes) {
      const set = {};
      const del = [];
      for (const change of changes) {
        if (change.content !== undefined) set[change.path] = await storeBlob(change.content);
        else if (change.sha) {
          if ((await backend.get(`blob/${change.sha}`)) === null) throw new GitHubError(`A file version for “${change.path}” is missing (422).`, 422);
          set[change.path] = change.sha;
        } else del.push(change.path);
      }
      return writeTree(baseTree || null, set, del);
    },

    async createCommit(message, treeSha, parents) {
      const id = newId();
      await backend.put(`commit/${id}`, JSON.stringify({ tree: treeSha, parents, message, date: now() }));
      return id;
    },

    /** Moves the branch to a commit made on its tip; fails with 422 when the tip moved meanwhile. */
    async updateBranch(branch, commitSha) {
      const commit = await readCommit(commitSha);
      const tip = await head(branch);
      if (tip !== (commit.parents[0] ?? null) || !(await backend.cas(`ref/${branch}`, tip, commitSha))) throw new GitHubError('Update is not a fast forward (422).', 422);
      return { sha: commitSha };
    },

    async createBranch(branch, commitSha) {
      if (!(await backend.cas(`ref/${branch}`, null, commitSha))) throw new GitHubError('Reference already exists (422).', 422);
      return { sha: commitSha };
    },

    /** Creates or replaces one file; `sha` must be the current one (409 otherwise, 422 when it exists and none is given). */
    async putFile(filePath, { text, sha, branch, message }) {
      const name = branch || (await defaultBranch());
      for (let attempt = 0; attempt < 8; attempt++) {
        const tip = await head(name);
        const current = tip ? (await readTree((await readCommit(tip)).tree)).get(filePath) : undefined;
        if (sha && current !== sha) throw new GitHubError(`“${filePath}” does not match ${sha} (409).`, 409);
        if (!sha && current) throw new GitHubError(`“${filePath}” exists and no sha was given (422).`, 422);
        const blob = await storeBlob(text);
        const commit = await commitOn(name, tip, { [filePath]: blob }, [], message);
        if (commit) return { sha: blob, commit };
      }
      throw new GitHubError('The data on this device kept changing; try again (409).', 409);
    },

    async deleteFile(filePath, { sha, branch, message }) {
      const name = branch || (await defaultBranch());
      for (let attempt = 0; attempt < 8; attempt++) {
        const tip = await head(name);
        const current = tip ? (await readTree((await readCommit(tip)).tree)).get(filePath) : undefined;
        if (!current) throw notFound(`“${filePath}”`);
        if (current !== sha) throw new GitHubError(`“${filePath}” does not match ${sha} (409).`, 409);
        if (await commitOn(name, tip, {}, [filePath], message)) return;
      }
      throw new GitHubError('The data on this device kept changing; try again (409).', 409);
    },

    /** Creates `branch` from the default branch when missing; true when it did. */
    async ensureBranch(branch) {
      if (await head(branch)) return false;
      const base = await head(await defaultBranch());
      if (!base) throw new GitHubError('There is nothing on this device yet (409).', 409);
      await client.createBranch(branch, base);
      return true;
    },

    getMeta,

    /** Merges `patch` into the store's notes (where the data went, when it was tidied). */
    async setMeta(patch) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await backend.get('meta');
        const next = JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), ...patch });
        if (await backend.cas('meta', raw, next)) return JSON.parse(next);
      }
      throw new GitHubError('Could not save the data notes (409).', 409);
    },

    /**
     * Drops versions older than `keepDays` (the last one before stays, as the
     * first) and what only they used. Objects written in the last day stay, so
     * a sync running in the other app meanwhile keeps what it wrote.
     */
    async prune({ keepDays = KEEP_DAYS, nowMs = Date.now() } = {}) {
      const cutoff = new Date(nowMs - keepDays * 86400000).toISOString();
      const commits = new Set();
      for (const { key } of await backend.list('ref/')) {
        let id = await backend.get(key);
        while (id && !commits.has(id)) {
          const commit = await json(`commit/${id}`);
          if (!commit) break;
          commits.add(id);
          if (commit.date < cutoff && commit.parents.length) {
            // The oldest kept: its own full tree, no parents.
            const map = await readTree(commit.tree);
            await backend.put(`tree/${commit.tree}`, JSON.stringify({ full: Object.fromEntries(map) }));
            await backend.put(`commit/${id}`, JSON.stringify({ ...commit, parents: [] }));
            break;
          }
          id = commit.parents[0] ?? null;
        }
      }
      const treeIds = new Set();
      const blobs = new Set();
      const markTree = async (id) => {
        while (id && !treeIds.has(id)) {
          treeIds.add(id);
          const tree = await json(`tree/${id}`);
          if (!tree) return;
          for (const sha of Object.values(tree.full ?? tree.set ?? {})) blobs.add(sha);
          id = tree.base;
        }
      };
      for (const id of commits) await markTree((await json(`commit/${id}`))?.tree);
      const keep = { commit: commits, tree: treeIds, blob: blobs };
      let removed = 0;
      for (const kind of ['commit', 'tree', 'blob']) {
        for (const { key, time } of await backend.list(`${kind}/`)) {
          if (keep[kind].has(key.slice(kind.length + 1)) || nowMs - time < GRACE_MS) continue;
          await backend.del(key);
          removed++;
        }
      }
      trees.clear();
      await client.setMeta({ prunedAt: new Date(nowMs).toISOString() });
      return { removed };
    },
  };
  return client;
}
