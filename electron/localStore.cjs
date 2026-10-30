// The data folder on this computer ("on this computer" mode): the objects of the
// page's localRepo.js kept as files, for Tracker and Tracker Editor at once
// (both desktop apps use the same folder, so they see each other's changes).
// Writes go to a temporary file and are renamed into place; compare-and-swap
// takes a lock file, since two apps write here. The tracker and the editor keep
// the same copy of this file.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const KEY = /^(meta|ref\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|(?:blob|bin|tree|commit)\/[0-9a-f]{40})$/;
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 10000;
const POINTER = 'Tracker data.json';

const README = `This folder holds the data of Tracker and Tracker Editor on this computer
(their items, projects, files and history). Both apps read and write it.

Copy the whole folder to keep a backup. Don't change files in it by hand.
`;

/**
 * Where the data folder is: TRACKER_DATA_DIR when set (tests, a portable setup), the one named
 * in "<appData>/Tracker data.json" (both apps read it), else Documents/Tracker data.
 */
function dataDir({ appData, documents, env = process.env }) {
  if (env.TRACKER_DATA_DIR && path.isAbsolute(env.TRACKER_DATA_DIR)) return env.TRACKER_DATA_DIR;
  try {
    const { dir } = JSON.parse(fs.readFileSync(path.join(appData, POINTER), 'utf8'));
    if (typeof dir === 'string' && path.isAbsolute(dir)) return dir;
  } catch {
    // None chosen: the default.
  }
  return path.join(documents, 'Tracker data');
}

/** Names another folder for both apps (moving what is there is the caller's). */
function setDataDir({ appData }, dir) {
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, POINTER), JSON.stringify({ dir }, null, 2));
}

function fileOf(dir, key) {
  if (typeof key !== 'string' || !KEY.test(key) || key.split('/').includes('..')) throw new Error('Not a data key');
  const [kind, ...rest] = key.split('/');
  if (kind === 'meta') return path.join(dir, 'meta.json');
  if (kind === 'ref') return path.join(dir, 'refs', ...rest);
  return path.join(dir, 'objects', kind, rest[0].slice(0, 2), rest[0].slice(2));
}

async function walk(root, rel = []) {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, ...rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.endsWith('.tmp')) continue;
    if (e.isDirectory()) out.push(...(await walk(root, [...rel, e.name])));
    else if (e.isFile()) out.push({ rel: [...rel, e.name], time: (await fsp.stat(path.join(root, ...rel, e.name))).mtimeMs });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The store over a folder: { dir, get, put, cas, del, list } (see localRepo.js memoryBackend). */
function createLocalStore(dir) {
  let ready = null;
  const prepare = () =>
    (ready ??= (async () => {
      await fsp.mkdir(dir, { recursive: true });
      const readme = path.join(dir, 'README.txt');
      if (!fs.existsSync(readme)) await fsp.writeFile(readme, README);
    })());

  async function read(file) {
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function write(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tmp, value);
    await replace(tmp, file);
  }

  // Windows refuses to replace a file for a moment while something has it open (the other app
  // reading it, a virus scanner): it is tried again for up to a second, as other tools do.
  async function replace(tmp, file) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fsp.rename(tmp, file);
      } catch (err) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt >= 20) {
          await fsp.rm(tmp, { force: true });
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 5));
      }
    }
  }

  // One writer at a time across apps: a lock file, taken over when it is left from a crash.
  async function locked(fn) {
    await prepare();
    const lock = path.join(dir, '.lock');
    const start = Date.now();
    for (;;) {
      try {
        const handle = await fsp.open(lock, 'wx');
        await handle.writeFile(`${process.pid}`);
        await handle.close();
        break;
      } catch (err) {
        // Windows answers EPERM (or EACCES) while the lock another app just let go of is still being
        // deleted: busy too. Only after the wait does that error stand (a folder we cannot write to).
        const held = err.code === 'EEXIST';
        if (!held && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
        const stat = held ? await fsp.stat(lock).catch(() => null) : null;
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fsp.rm(lock, { force: true });
        else if (Date.now() - start > LOCK_WAIT_MS) throw held ? new Error('The data folder is busy (another app is writing to it).') : err;
        else await sleep(15);
      }
    }
    try {
      return await fn();
    } finally {
      await fsp.rm(lock, { force: true });
    }
  }

  return {
    dir,
    async get(key) {
      await prepare();
      return read(fileOf(dir, key));
    },
    async put(key, value) {
      await prepare();
      await write(fileOf(dir, key), String(value));
    },
    cas(key, expected, value) {
      const file = fileOf(dir, key);
      return locked(async () => {
        if ((await read(file)) !== expected) return false;
        await write(file, String(value));
        return true;
      });
    },
    async del(key) {
      await fsp.rm(fileOf(dir, key), { force: true });
    },
    /** [{ key, time }] under a prefix: 'ref/', 'blob/', 'bin/', 'tree/', 'commit/'. */
    async list(prefix) {
      const kind = prefix.split('/')[0];
      if (kind === 'ref') return (await walk(path.join(dir, 'refs'))).map((f) => ({ key: `ref/${f.rel.join('/')}`, time: f.time }));
      if (!['blob', 'bin', 'tree', 'commit'].includes(kind)) return [];
      return (await walk(path.join(dir, 'objects', kind))).map((f) => ({ key: `${kind}/${f.rel.join('')}`, time: f.time })).filter((e) => e.key.startsWith(prefix));
    },
  };
}

/**
 * Calls `onChange` when a branch head in the folder moves (the other app synced),
 * a moment after; not for the values `own` says this app wrote. Returns a stop function.
 */
function watchRefs(dir, onChange, own = () => false) {
  const refs = path.join(dir, 'refs');
  fs.mkdirSync(refs, { recursive: true });
  let timer = null;
  const check = async () => {
    for (const f of await walk(refs)) {
      const key = `ref/${f.rel.join('/')}`;
      const value = await fsp.readFile(path.join(refs, ...f.rel), 'utf8').catch(() => null);
      if (value !== null && !own(key, value)) return onChange();
    }
  };
  let watcher;
  try {
    watcher = fs.watch(refs, { recursive: process.platform !== 'linux' }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => check().catch(() => {}), 250);
    });
  } catch {
    return () => {};
  }
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

module.exports = { createLocalStore, dataDir, setDataDir, watchRefs, fileOf };
