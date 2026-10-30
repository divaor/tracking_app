import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fromBase64, mimeOf, routeOfLink, sortLaunch, toBase64 } from '../app/js/androidApp.js';
import { sharedDraft, sharedFilesTitle } from '../app/js/sharedItems.js';

test('links to the app: items, the icon shortcuts, a notification', () => {
  assert.deepEqual(routeOfLink('tracker-app://item/mvu8fw93-7ddb8811a897aa77'), { kind: 'item', id: 'mvu8fw93-7ddb8811a897aa77' });
  assert.deepEqual(routeOfLink('tracker-app://item/abc/'), { kind: 'item', id: 'abc' });
  assert.deepEqual(routeOfLink('tracker-app://new'), { kind: 'new' });
  assert.deepEqual(routeOfLink('tracker-app://voice'), { kind: 'voice' });
  assert.deepEqual(routeOfLink('tracker-app://open'), { kind: 'open' });
  assert.equal(routeOfLink('tracker-app://item/../x'), null);
  assert.equal(routeOfLink('tracker-editor://file/1'), null);
  assert.equal(routeOfLink('https://example.com'), null);
});

test('what was shared, sorted: links to open, text, files together', async () => {
  const read = async (uri) => {
    if (uri === 'content://gone') throw new Error('gone');
    return new TextEncoder().encode(`bytes of ${uri}`);
  };
  const sorted = await sortLaunch(
    [
      { kind: 'link', url: 'tracker-app://item/abc123' },
      { kind: 'text', text: 'Buy milk', title: '' },
      { kind: 'file', uri: 'content://a', name: 'a.png', mime: 'image/png' },
      { kind: 'file', uri: 'content://gone', name: 'gone.pdf', mime: 'application/pdf' },
      { kind: 'file', uri: 'content://b', name: 'b.pdf', mime: 'application/pdf' },
      { kind: 'link', url: 'nonsense' },
    ],
    read,
  );
  assert.deepEqual(sorted.routes, [{ kind: 'item', id: 'abc123' }]);
  assert.equal(sorted.shared.length, 2);
  assert.deepEqual(sorted.shared[0], { title: '', text: 'Buy milk', files: [] });
  assert.deepEqual(sorted.shared[1].files.map((f) => [f.name, f.type, f.size]), [['a.png', 'image/png', 20], ['b.pdf', 'application/pdf', 20]], 'a file that cannot be read is left out');
});

test('bytes cross to the app as base64; files get their type', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(mimeOf('Report.PDF'), 'application/pdf');
  assert.equal(mimeOf('notes.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeOf('photo.jpeg'), 'image/jpeg');
  assert.equal(mimeOf('archive.xyz'), 'application/octet-stream');
});

test('shared text becomes an item to review', () => {
  assert.deepEqual(sharedDraft({ text: 'https://example.com/a/b/' }), { title: 'example.com/a/b', url: 'https://example.com/a/b/', notes: '' });
  assert.deepEqual(sharedDraft({ title: 'Great article', text: 'Check this https://example.com/x out' }), {
    title: 'Great article',
    url: 'https://example.com/x',
    notes: 'Check this https://example.com/x out',
  });
  assert.deepEqual(sharedDraft({ text: 'Buy milk\nand eggs' }), { title: 'Buy milk', url: '', notes: 'and eggs' });
  assert.deepEqual(sharedDraft({ text: 'Read https://example.com/page now' }), { title: 'Read now', url: 'https://example.com/page', notes: '' });
  const long = 'word '.repeat(60).trim();
  const draft = sharedDraft({ text: long });
  assert.ok(draft.title.length <= 120 && draft.title.endsWith('…'));
  assert.equal(draft.notes, long, 'a title cut short keeps the whole text in the notes');
});

test('a title for shared files', () => {
  assert.equal(sharedFilesTitle([{ name: 'IMG_20261030_140512.jpg', type: 'image/jpeg' }]), 'Photo');
  assert.equal(sharedFilesTitle([{ name: 'PXL_20261030_1405.jpg', type: 'image/jpeg' }]), 'Photo');
  assert.equal(sharedFilesTitle([{ name: 'Screenshot_20261030.png', type: 'image/png' }]), 'Screenshot');
  assert.equal(sharedFilesTitle([{ name: 'Quarterly report.pdf', type: 'application/pdf' }]), 'Quarterly report');
  assert.equal(sharedFilesTitle([{ name: 'a.png', type: 'image/png' }, { name: 'b.png', type: 'image/png' }]), '2 pictures');
  assert.equal(sharedFilesTitle([{ name: 'a.png', type: 'image/png' }, { name: 'b.pdf', type: 'application/pdf' }]), '2 files');
});

test('the Android app: its id, the files it shares, its parts in step', async () => {
  const config = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(config.appId, 'com.divaor.tracker');
  assert.equal(config.webDir, 'app');
  const manifest = await readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  for (const needed of ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE', 'android:scheme="tracker-app"', 'android.intent.action.PROCESS_TEXT', '.ChangesJob', 'POST_NOTIFICATIONS', 'RECOGNIZE_SPEECH', 'TTS_SERVICE']) {
    assert.ok(manifest.includes(needed), `the manifest has ${needed}`);
  }
  const gradle = await readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  assert.match(gradle, /applicationId "com\.divaor\.tracker"/);
  assert.match(gradle, /keyAlias System\.getenv\('ANDROID_KEY_ALIAS'\) \?: 'tracker'/, 'the release key\'s alias');
  // Every method the page calls exists in the plugin.
  const bridge = await readFile(new URL('../app/js/androidApp.js', import.meta.url), 'utf8');
  const plugin = await readFile(new URL('../android/app/src/main/java/com/divaor/tracker/TrackerNativePlugin.java', import.meta.url), 'utf8');
  const called = new Set([...bridge.matchAll(/call\('(\w+)'/g), ...bridge.matchAll(/nativePromise\(PLUGIN, '(\w+)'/g)].map((m) => m[1]));
  for (const method of called) assert.match(plugin, new RegExp(`@PluginMethod\\s+public void ${method}\\(`), `the plugin has ${method}`);
  // The token the change checks read is the one settings.js keeps.
  const changes = await readFile(new URL('../android/app/src/main/java/com/divaor/tracker/Changes.java', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../app/js/settings.js', import.meta.url), 'utf8');
  assert.match(changes, /Secrets\.read\(context, "github-token"\)/);
  assert.match(settings, /secrets\.(get|set)\('github-token'/);
  // The page loads the bridge before the app.
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/androidApp.js') > 0 && html.indexOf('js/androidApp.js') < html.indexOf('js/main.js'));
});
