// The data folder on this computer (electron/localStore.cjs): files for the objects,
// two apps writing at once through the lock, keys checked, the other app's changes seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalRepo } from '../app/js/localRepo.js';

const require = createRequire(import.meta.url);
const { createLocalStore, dataDir, setDataDir, watchRefs, fileOf } = require('../electron/localStore.cjs');
const temp = () => mkdtempSync(path.join(tmpdir(), 'data-'));

test('where the folder is: Documents/Tracker data, or the one both apps were told', () => {
  const appData = temp();
  const documents = temp();
  assert.equal(dataDir({ appData, documents, env: {} }), path.join(documents, 'Tracker data'));
  const other = path.join(temp(), 'Elsewhere');
  setDataDir({ appData }, other);
  assert.equal(dataDir({ appData, documents, env: {} }), other);
  writeFileSync(path.join(appData, 'Tracker data.json'), '{"dir":"relative/path"}');
  assert.equal(dataDir({ appData, documents, env: {} }), path.join(documents, 'Tracker data'), 'only absolute folders');
  assert.equal(dataDir({ appData, documents, env: { TRACKER_DATA_DIR: '/tmp/x-data' } }), '/tmp/x-data', 'TRACKER_DATA_DIR wins');
});

test('keys map to files inside the folder, nothing else', () => {
  const dir = temp();
  assert.equal(fileOf(dir, 'meta'), path.join(dir, 'meta.json'));
  assert.equal(fileOf(dir, 'ref/main'), path.join(dir, 'refs', 'main'));
  assert.equal(fileOf(dir, `blob/${'ab'.repeat(20)}`), path.join(dir, 'objects', 'blob', 'ab', 'ab'.repeat(19)));
  for (const bad of ['../x', 'ref/../../etc', 'blob/zz', 'other/1', 'ref/a/../b', '']) assert.throws(() => fileOf(dir, bad), /Not a data key/, bad);
});

test('the repo over the folder: two apps writing at once both land; a README explains it', async () => {
  const dir = temp();
  const editor = createLocalRepo(createLocalStore(dir));
  const tracker = createLocalRepo(createLocalStore(dir));
  await editor.putFile('tracker.json', { text: '{}', message: 'start' });
  await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => editor.putFile(`editor/files/${i}/a.md`, { text: `e${i}`, message: `e${i}` })),
    ...Array.from({ length: 6 }, (_, i) => tracker.putFile(`files/${i}/b.md`, { text: `t${i}`, message: `t${i}` })),
  ]);
  const paths = (await tracker.listTree()).map((e) => e.path);
  assert.equal(paths.length, 13);
  assert.equal((await editor.getFile('files/3/b.md')).text, 't3');
  assert.ok(readFileSync(path.join(dir, 'README.txt'), 'utf8').includes('Tracker and Tracker Editor'));
  assert.ok(!existsSync(path.join(dir, '.lock')), 'the lock is let go');
  const store = createLocalStore(dir);
  assert.ok((await store.list('blob/')).length >= 13);
  assert.equal((await store.list('ref/'))[0].key, 'ref/main');
});

test('a lock left from a crash is taken over', async () => {
  const dir = temp();
  const store = createLocalStore(dir);
  await store.put('meta', '{}');
  writeFileSync(path.join(dir, '.lock'), '99999');
  const old = (Date.now() - 60000) / 1000;
  utimesSync(path.join(dir, '.lock'), old, old);
  assert.equal(await store.cas('ref/main', null, 'abc'), true);
  assert.equal(await store.cas('ref/main', null, 'def'), false, 'compare-and-swap still compares');
  assert.equal(await store.get('ref/main'), 'abc');
});

test('the other app’s writes are noticed; this app’s own are not', async () => {
  const dir = temp();
  const store = createLocalStore(dir);
  await store.put('meta', '{}');
  let seen = 0;
  const own = new Set(['mine']);
  const stop = watchRefs(dir, () => seen++, (_key, value) => own.has(value));
  await new Promise((r) => setTimeout(r, 100));
  await store.cas('ref/main', null, 'mine');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(seen, 0);
  await store.cas('ref/main', 'mine', 'theirs');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(seen, 1);
  stop();
});

test('a file another program holds open for a moment (Windows) is replaced once it lets go', async () => {
  const fsp = require('node:fs').promises;
  const rename = fsp.rename;
  const dir = temp();
  const store = createLocalStore(dir);
  await store.put('meta', '{"a":1}');
  let refused = 0;
  fsp.rename = async (...args) => {
    if (refused < 3) {
      refused++;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename(...args);
  };
  try {
    await store.put('meta', '{"a":2}');
    assert.equal(refused, 3);
    assert.equal(await store.get('meta'), '{"a":2}');
    // Held for good: the error comes back, and no temporary file is left behind.
    fsp.rename = async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    };
    await assert.rejects(store.put('meta', '{"a":3}'), /EBUSY/);
    assert.deepEqual(require('node:fs').readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    assert.equal(await store.get('meta'), '{"a":2}');
  } finally {
    fsp.rename = rename;
  }
});
