// The Android check (.github/workflows/android-check.yml): installs a debug APK (built with
// WebView debugging on) on the emulator that is running, opens the app and checks, in its real
// WebView over Chrome's DevTools protocol and with adb as a person would: the page and its bridge,
// secrets kept by the phone, a model server on the computer next to the phone (no CORS, plain
// http), the phone's voices, Share → Tracker (text, and a picture), a tracker-app:// link, Back,
// an attachment opened with another app, saving a file, and the change notifications while the
// app is closed (a fake GitHub API on this machine). Writes android-check/report.json,
// screenshots and the WebView's console lines; exits 1 when a check fails.
//   node scripts/android-check.mjs path/to/app-debug.apk
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _android as android } from 'playwright-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = 'com.divaor.tracker';
const OUT = path.join(ROOT, 'android-check');
// This machine, as the emulator reaches it.
const HOST = 'http://10.0.2.2:8790';
const apk = process.argv[2];
if (!apk) throw new Error('Usage: node scripts/android-check.mjs app-debug.apk');
fs.mkdirSync(OUT, { recursive: true });

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 180_000 });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600) : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// What the phone's screen shows (uiautomator's dump): the texts on it.
const screenTexts = () => {
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/window.xml');
    return [...adb('shell', 'cat', '/sdcard/window.xml').matchAll(/text="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  } catch {
    return [];
  }
};
const screencap = (name) => fs.writeFileSync(path.join(OUT, name), execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));
// One part failing does not stop the others.
const part = async (name, run) => {
  try {
    await run();
  } catch (err) {
    check(name, false, err.stack ?? String(err));
  }
};

// A model server and a GitHub API on this machine (the phone's network, as far as it knows).
const asked = [];
let commitDate = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    asked.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '', body });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"from your computer"}}]}\n\ndata: [DONE]\n\n'), 300);
      return;
    }
    if (/^\/repos\/me\/data\/commits/.test(req.url)) {
      // Made after the app started looking (a minute after the first look), the same each time.
      commitDate ??= new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const date = commitDate;
      const commit = (sha, message) => ({ sha, commit: { message, committer: { date }, author: { date } } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([commit('b2', 'Tracker: add “Check the oil” (via Claude)'), commit('b1', 'Tracker: sync from Phone (1 added)')]));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => server.listen(8790, '0.0.0.0', r));

let device;
try {
  console.log(adb('shell', 'getprop', 'ro.build.version.release').trim(), '| WebView', adb('shell', 'dumpsys', 'package', 'com.google.android.webview').match(/versionName=(\S+)/)?.[1] ?? '?');
  adb('install', '-r', '-g', apk);
  adb('shell', 'svc', 'power', 'stayon', 'true');
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('logcat', '-c');
  adb('shell', 'am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
  [device] = await android.devices({ omitDriverInstall: true });
  const webview = await device.webView({ pkg: PKG }, { timeout: 120_000 });
  const page = await webview.page();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.topbar', { state: 'attached' });
  const until = async (fn, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(400)) {
      try {
        if (await fn()) return true;
      } catch {}
    }
    return false;
  };
  const modalText = () => page.evaluate(() => document.querySelector('.modal')?.textContent ?? '');
  const closeAll = async () => {
    for (let i = 0; i < 4 && (await page.$('.modal')); i++) {
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      await wait(700);
    }
  };

  await part('the page and its bridge', async () => {
    const info = await page.evaluate(async () => ({
      href: location.href,
      platform: window.desktop?.platform,
      native: document.documentElement.dataset.native,
      sw: Boolean(await navigator.serviceWorker?.getRegistration?.()),
      device: (await import('/js/settings.js')).getSettings().device,
    }));
    check('the app’s page loads with its bridge (no service worker)', info.platform === 'android' && info.native === 'android' && !info.sw && info.device === 'Phone', info);
  });

  await part('secrets', async () => {
    const value = await page.evaluate(async () => {
      await window.desktop.secrets.set('github-token', 'check-token');
      return window.desktop.secrets.get('github-token');
    });
    check('a secret is kept by the phone and read back', value === 'check-token', value);
  });

  await part('a model server on the network', async () => {
    const reply = await page.evaluate(async (host) => {
      const { localFetch } = await import('/js/localFetch.js');
      const parts = [];
      const res = await localFetch(`${host}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}' });
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(new TextDecoder().decode(value));
      }
      return { status: res.status, type: res.headers.get('content-type'), parts };
    }, HOST);
    check('a model on the computer is reached by the app (plain http, no CORS), its answer streamed', reply.status === 200 && reply.parts.join('').includes('from your computer') && reply.parts.length >= 2, reply);
    check('…with the request as the page made it', asked.some((a) => a.url === '/v1/chat/completions' && a.method === 'POST' && a.body === '{"stream":true}'));
  });

  await part('the phone’s voices', async () => {
    const tts = await page.evaluate(async () => {
      const t = window.desktop?.android?.tts;
      if (!t) return { error: 'no tts bridge' };
      const out = {};
      try {
        let voices = await t.loadVoices();
        for (let i = 0; i < 8 && !voices.length; i++) voices = await new Promise((r) => setTimeout(r, 2000)).then(() => t.loadVoices());
        out.voices = voices.length;
      } catch (err) {
        return { ...out, error: err.message };
      }
      if (!out.voices) return out;
      out.spoken = await Promise.race([
        t.speak({ text: 'Hello from the tracker.', lang: 'en-US' }).then(() => 'done', (err) => `error: ${err.message}`),
        new Promise((r) => setTimeout(() => r('no answer in 20 s'), 20_000)),
      ]);
      return out;
    });
    if (/no text-to-speech engine/.test(tts.error ?? '')) return check('the phone’s voices (no engine on this emulator)', true, tts);
    check('Listen: the phone’s voices, and one speaks', !tts.error && tts.voices > 0 && tts.spoken === 'done', tts);
  });

  await part('Share → Tracker: text', async () => {
    adb('shell', 'am', 'start', '-a', 'android.intent.action.SEND', '-t', 'text/plain', '--es', 'android.intent.extra.TEXT', '"Read this later https://example.com/article"', '-n', `${PKG}/.MainActivity`);
    const ok = await until(async () => (await page.evaluate(() => [...document.querySelectorAll('.modal input')].map((i) => i.value).join(' | '))).includes('https://example.com/article'));
    const fields = await page.evaluate(() => [...document.querySelectorAll('.modal input')].map((i) => i.value).filter(Boolean));
    check('shared text opens a new item with its title and link', ok && fields.some((v) => v.startsWith('Read this later')), fields);
    screencap('shared-text.png');
    // The title has the keyboard up: the first Back closes the keyboard, the next the item (as in any app).
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    if (!(await until(async () => !(await page.$('.modal')), 2500))) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    check('Back closes it', await until(async () => !(await page.$('.modal'))));
  });

  await part('Share → Tracker: a picture', async () => {
    // A picture in the phone's Pictures, through the media store (a content:// address, as a gallery shares it).
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const local = path.join(OUT, 'tracker-check.png');
    fs.writeFileSync(local, png);
    adb('push', local, '/sdcard/Pictures/tracker-check.png');
    adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file:///sdcard/Pictures/tracker-check.png');
    let uri = '';
    for (let i = 0; i < 15 && !uri; i++) {
      await wait(1000);
      const found = adb('shell', 'content', 'query', '--uri', 'content://media/external/images/media', '--projection', '_id:_display_name').split('\n').find((l) => l.includes('tracker-check.png'));
      const id = /_id=(\d+)/.exec(found ?? '')?.[1];
      if (id) uri = `content://media/external/images/media/${id}`;
    }
    if (!uri) return check('a shared picture (this emulator did not list it in its media store: not checked)', true);
    // As a gallery shares it: the picture, and the right to read it (am grants it for the intent's data).
    adb('shell', 'am', 'start', '-a', 'android.intent.action.SEND', '-t', 'image/png', '-d', uri, '--eu', 'android.intent.extra.STREAM', uri, '--grant-read-uri-permission', '-n', `${PKG}/.MainActivity`);
    const asked2 = await until(() => page.$('.shared-dialog'));
    const why = asked2 ? '' : await page.evaluate((u) => globalThis.Capacitor.nativePromise('TrackerNative', 'read', { uri: u }).then((r) => `readable (${r.length} bytes)`, (err) => `not readable: ${err?.message ?? err}`), uri);
    check('a shared picture asks where it goes', asked2, why ? `${uri}: ${why}` : '');
    if (!asked2) return;
    screencap('shared-picture.png');
    await page.fill('.shared-dialog .shared-new input', 'Shared from the gallery');
    await page.click('.shared-dialog .shared-new button');
    check('…a new item with the picture on it', await until(async () => (await modalText()).includes('Shared from the gallery') && (await modalText()).includes('tracker-check')));
    await closeAll();
  });

  await part('a link to an item', async () => {
    const id = await page.evaluate(async () => (await import('/js/store.js')).store.add({ title: 'Linked from a message', notes: 'Hello.' }).id);
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `tracker-app://item/${id}`, '-n', `${PKG}/.MainActivity`);
    check('tracker-app://item/<id> opens it', await until(async () => (await page.evaluate(() => document.querySelector('.modal .item-title')?.textContent ?? '')) === 'Linked from a message'));
    await closeAll();
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'tracker-app://new', '-n', `${PKG}/.MainActivity`);
    check('the Quick add shortcut focuses quick add', await until(() => page.evaluate(() => Boolean(document.activeElement?.closest?.('.quick-add')))));
  });

  await part('Back on the Overview', async () => {
    await page.evaluate(() => (location.hash = '#/list'));
    await wait(500);
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    check('Back on another view goes to the Overview', await until(() => page.evaluate(() => !location.hash.replace(/^#\/?/, ''))));
  });

  await part('an attachment opened with another app', async () => {
    const opened = await page.evaluate(() =>
      window.desktop.openFile('notes.txt', new TextEncoder().encode('Some notes.')).then(
        () => 'ok',
        (err) => err.message,
      ),
    );
    await wait(1500);
    const texts = screenTexts();
    check('the phone offers apps to open it with (or says none can)', opened === 'ok' || /No app/.test(opened), { opened, screen: texts.slice(0, 8) });
    screencap('open-with.png');
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await wait(800);
  });

  await part('saving a file', async () => {
    const saving = page.evaluate(() => window.desktop.saveFile('export.json', new TextEncoder().encode('{}'), 'application/json'));
    await wait(3000);
    const texts = screenTexts();
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    const saved = await saving.catch((err) => `error: ${err.message}`);
    check('Download / Export asks the phone where to save (cancelled: nothing saved)', saved === null && texts.some((t) => /export\.json|Save|Downloads|Recent/i.test(t)), { saved, screen: texts.slice(0, 10) });
  });

  await part('notifications while the app is closed', async () => {
    await page.evaluate(async () => {
      const s = await import('/js/settings.js');
      s.saveSettings({ storage: 'github', owner: 'me', repo: 'data', path: 'tracker.json', branch: '', device: 'Phone' });
    });
    await wait(800);
    // The checks against the fake GitHub on this machine.
    const state = await page.evaluate(async (api) => {
      const n = window.desktop.android.notifications;
      await n.configure({ enabled: true, api, owner: 'me', repo: 'data', branch: '', device: 'Phone', items: true, documents: true, devices: false });
      return n.state();
    }, HOST);
    check('the checks are scheduled (JobScheduler)', state.enabled && state.scheduled, state);
    const looked = await page.evaluate(() => window.desktop.android.notifications.check().then((r) => r, (err) => ({ error: err.message })));
    check('a look finds what Claude did (not this phone’s own sync)', looked.shown === 1, looked);
    check('…asking GitHub with the token', asked.some((a) => /^\/repos\/me\/data\/commits\?per_page=30&since=/.test(a.url) && a.auth === 'Bearer check-token'));
    await wait(1500);
    const shade = adb('shell', 'dumpsys', 'notification', '--noredact');
    check('…and tells it in a notification', /Check the oil/.test(shade) && /Claude on your tracker/.test(shade), shade.match(/Check the oil.{0,80}/)?.[0] ?? '');
    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    await wait(1200);
    screencap('notification.png');
    adb('shell', 'cmd', 'statusbar', 'collapse');
    const again = await page.evaluate(() => window.desktop.android.notifications.check().then((r) => r, (err) => ({ error: err.message })));
    check('the next look tells nothing twice', again.shown === 0, again);
  });

  screencap('app.png');
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('ran', false, err.stack ?? String(err));
} finally {
  try {
    // The WebView's console only (never the app's own log).
    fs.writeFileSync(path.join(OUT, 'webview-console.txt'), adb('logcat', '-d', '-s', 'chromium:*', 'Capacitor/Console:*', 'Tracker:*'));
  } catch {
    // no log
  }
  await device?.close().catch(() => {});
  server.close();
}
fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
