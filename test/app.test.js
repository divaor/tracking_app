// Consistency checks across the app files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../app/js/version.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.join(root, 'app');

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)])),
  );
  return files.flat();
}

test('APP_VERSION matches package.json', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});

test('service worker precaches every app file and its cache name tracks the version', async () => {
  const sw = await readFile(path.join(appDir, 'sw.js'), 'utf8');
  const assets = JSON.parse(`[${/const ASSETS = \[([\s\S]*?)\];/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
  const files = (await listFiles(appDir)).map((f) => path.relative(appDir, f).split(path.sep).join('/')).filter((f) => f !== 'sw.js');
  assert.deepEqual([...assets].filter((a) => a !== './').sort(), files.sort());
  assert.match(sw, new RegExp(`const CACHE = 'tracker-v${APP_VERSION.replace(/\./g, '\\.')}'`));
});

test('every relative import in the app resolves to a file', async () => {
  const jsFiles = (await listFiles(appDir)).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}vendor${path.sep}`));
  const all = new Set(await listFiles(appDir));
  for (const file of jsFiles) {
    const source = await readFile(file, 'utf8');
    for (const [, spec] of source.matchAll(/from '(\.[^']+)'/g)) {
      assert.ok(all.has(path.resolve(path.dirname(file), spec)), `${path.relative(root, file)} imports missing ${spec}`);
    }
  }
});
