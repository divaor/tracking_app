// Copies the browser builds of the front-end libraries from node_modules into
// app/vendor so the web app runs without a build step (GitHub Pages, Electron).
// Run with `npm run vendor` after upgrading htm, marked or dompurify.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'app', 'vendor');

const files = [
  { from: 'node_modules/htm/preact/standalone.module.js', to: 'preact-htm.js', pkg: 'htm' },
  { from: 'node_modules/marked/lib/marked.esm.js', to: 'marked.js', pkg: 'marked' },
  { from: 'node_modules/dompurify/dist/purify.es.mjs', to: 'purify.js', pkg: 'dompurify' },
];

await mkdir(outDir, { recursive: true });
for (const file of files) {
  const { version, license } = JSON.parse(await readFile(path.join(root, 'node_modules', file.pkg, 'package.json'), 'utf8'));
  const source = await readFile(path.join(root, file.from), 'utf8');
  const body = source.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');
  await writeFile(path.join(outDir, file.to), `/* ${file.pkg}@${version} (${license}) - vendored by scripts/vendor.js */\n${body}`);
  console.log(`app/vendor/${file.to} <- ${file.pkg}@${version}`);
}
