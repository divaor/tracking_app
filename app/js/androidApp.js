// The Android app: this page in the app's WebView (Capacitor), with `window.desktop` for what a
// phone can do, backed by the app's own plugin (android/app/src/main/java/com/divaor/tracker/
// TrackerNativePlugin.java). Loaded before main.js, so the rest of the page finds it; in a
// browser or the desktop app it does nothing. It imports nothing of the app's, so nothing reads
// window.desktop before it is set.

const cap = globalThis.Capacitor;
const inAndroidApp = Boolean(cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android');

const PLUGIN = 'TrackerNative';
const EDITOR_PACKAGE = 'com.divaor.trackereditor';

// Plugin calls reject with { message, code }: an Error the page can show.
const call = (method, options = {}) =>
  cap.nativePromise(PLUGIN, method, options).catch((err) => {
    throw new Error(err?.message ?? String(err));
  });

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromBase64 = (b64) => Uint8Array.from(atob(b64 ?? ''), (c) => c.charCodeAt(0));

// ---- The app's log (Send a log): the page's errors and what it did, in batches ----
const logLines = [];
let logTimer = null;
/** One line for the app's log (AppLog.java). Never secrets or the items. */
export function logLine(text) {
  logLines.push(String(text));
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  if (!logTimer) logTimer = setTimeout(flushLog, 1500);
}
function flushLog() {
  logTimer = null;
  if (!logLines.length) return;
  cap.nativePromise(PLUGIN, 'log', { lines: logLines.splice(0) }).catch(() => {});
}
/** A console argument as text: errors with their stack, objects as JSON (cut short). */
export function logText(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value)?.slice(0, 1000) ?? String(value);
  } catch {
    return String(value);
  }
}
function watchPage() {
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logLine(`${level}: ${args.map(logText).join(' ')}`);
      original(...args);
    };
  }
  addEventListener('error', (e) => logLine(`error: ${e.error ? logText(e.error) : `${e.message} (${e.filename}:${e.lineno})`}`));
  addEventListener('unhandledrejection', (e) => logLine(`unhandled: ${logText(e.reason)}`));
  addEventListener('pagehide', flushLog);
  logLine(`Page started (WebView ${/Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '?'})`);
}

// ---- What the app was given: links, things shared with it ----

/** tracker-app://item/<id>, new, voice, open → { kind: 'item', id } | { kind: 'new' | 'voice' | 'open' }, or null. */
export function routeOfLink(url) {
  const m = /^tracker-app:\/\/([^?#]*)/i.exec(url ?? '');
  if (!m) return null;
  const path = m[1].replace(/^\/+|\/+$/g, '');
  const item = /^item\/([A-Za-z0-9_-]+)$/.exec(path);
  if (item) return { kind: 'item', id: item[1] };
  return ['new', 'voice', 'open'].includes(path) ? { kind: path } : null;
}

/**
 * [{ kind: 'link' | 'text' | 'file', … }] from the native side → { routes, shared }: what to
 * open, and what was shared ({ title, text } or { files: [File] }; files given at once stay together).
 */
export async function sortLaunch(items, readBytes) {
  const out = { routes: [], shared: [] };
  const files = [];
  for (const item of items) {
    if (item.kind === 'link') {
      const route = routeOfLink(item.url);
      if (route) out.routes.push(route);
    } else if (item.kind === 'text') out.shared.push({ title: item.title ?? '', text: item.text ?? '', files: [] });
    else if (item.kind === 'file') {
      try {
        files.push(new File([await readBytes(item.uri)], item.name || 'Shared file', { type: item.mime || '' }));
      } catch (err) {
        console.warn('A shared file could not be read', err);
      }
    }
  }
  if (files.length) out.shared.push({ title: '', text: '', files });
  return out;
}

const queue = { shared: [], routes: [] };
const subscribers = { shared: new Set(), routes: new Set() };
const take = (kind) => queue[kind].splice(0);
const subscribe = (kind, callback) => {
  subscribers[kind].add(callback);
  return () => subscribers[kind].delete(callback);
};

async function drain() {
  const { items = [] } = await call('takeLaunch').catch(() => ({ items: [] }));
  if (!items.length) return;
  const sorted = await sortLaunch(items, async (uri) => fromBase64((await call('read', { uri })).data));
  queue.shared.push(...sorted.shared);
  queue.routes.push(...sorted.routes);
  if (sorted.shared.length) for (const cb of subscribers.shared) cb();
  if (sorted.routes.length) for (const cb of subscribers.routes) cb();
}

// ---- Requests to model and speech servers: made by the app (no CORS, plain http allowed) ----
const chunkListeners = new Map(); // request id → callback(chunk, done, error)
function httpBridge() {
  cap.addListener(PLUGIN, 'http', (e) => {
    const cb = chunkListeners.get(e.id);
    if (!cb) return;
    if (e.data) cb(fromBase64(e.data), false, null);
    if (e.done || e.error) cb(null, true, e.error ?? null);
  });
  return {
    request: (id, url, init) => call('httpRequest', { id, url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null }),
    abort: (id) => call('httpAbort', { id }).catch(() => {}),
    onChunk(id, callback) {
      chunkListeners.set(id, callback);
      return () => chunkListeners.delete(id);
    },
  };
}

// ---- Listen: Android's own text to speech (the WebView has no speechSynthesis) ----

const interrupted = () => Object.assign(new Error('interrupted'), { code: 'interrupted' });

/**
 * The reader's device engine on the phone (reader.js): `voices()` (shaped like the Web Speech
 * API's, loaded the first time they are asked for; `onVoicesChanged` says when they come),
 * `speak({ text, voice, lang, rate })` resolving when it was spoken, `stop()`, `keepAwake(on)`.
 * As in Tracker Editor's androidApp.js.
 */
function speech() {
  let list = [];
  let loading = null;
  let n = 0;
  let engine = ''; // the engine asked for: a package, '' for the phone's preferred one
  let info = { engine: '', systemEngine: '', engines: [] };
  const waiting = new Map(); // utterance id → { resolve, reject }
  const changed = new Set();
  cap.addListener(PLUGIN, 'tts', (e) => {
    const w = waiting.get(e.id);
    if (!w || e.type === 'start') return;
    waiting.delete(e.id);
    if (e.type === 'done') w.resolve();
    else if (e.type === 'stopped') w.reject(interrupted());
    else w.reject(new Error(e.message || 'the text-to-speech engine failed'));
  });
  // An engine just started may list no voices yet: an empty list is asked for again a few times.
  let retries = 0;
  let retryTimer = null;
  const load = () =>
    (loading ??= call('ttsVoices', { engine }).then(
      (r) => {
        list = (r.voices ?? []).map((v) => ({ voiceURI: v.name, name: v.name, lang: v.lang, localService: !v.network, quality: v.quality, default: v.name === r.defaultVoice }));
        info = { engine: r.engine ?? '', systemEngine: r.systemEngine ?? '', engines: r.engines ?? [] };
        if (list.length) retries = 0;
        else {
          loading = null;
          clearTimeout(retryTimer);
          if (retries++ < 6) retryTimer = setTimeout(() => load().catch(() => {}), 2000);
        }
        changed.forEach((fn) => fn());
        return list;
      },
      (err) => {
        loading = null;
        throw err;
      },
    ));
  return {
    voices: () => (load().catch(() => {}), list),
    loadVoices: load,
    engines: () => info,
    setEngine(name = '') {
      if (name === engine) return;
      engine = name;
      loading = null;
      retries = 0;
      list = [];
      load().catch(() => {});
    },
    onVoicesChanged(fn) {
      changed.add(fn);
      return () => changed.delete(fn);
    },
    speak({ text, voice = '', lang = '', rate = 1, pitch = 1 }) {
      const id = `u${++n}`;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        call('ttsSpeak', { id, text, voice, lang, rate, pitch, engine }).catch((err) => {
          waiting.delete(id);
          reject(err);
        });
      });
    },
    synthesize({ text, voice = '', lang = '', rate = 1, pitch = 1 }) {
      return cap.nativePromise(PLUGIN, 'ttsSynthesize', { id: `s${++n}`, text, voice, lang, rate, pitch, engine }).then(
        (r) => new Blob([fromBase64(r.audio)], { type: r.mime || 'audio/wav' }),
        (err) => {
          throw err?.code === 'interrupted' ? interrupted() : new Error(err?.message || 'the text-to-speech engine failed');
        },
      );
    },
    stop() {
      for (const w of waiting.values()) w.reject(interrupted());
      waiting.clear();
      return call('ttsStop').catch(() => {});
    },
    keepAwake: (on) => call('keepAwake', { on }).catch(() => {}),
  };
}

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', epub: 'application/epub+zip', rtf: 'application/rtf',
};
/** The MIME type the phone needs to find an app for a file, by its name. */
export const mimeOf = (name) => MIME[/\.([^.]+)$/.exec(name ?? '')?.[1]?.toLowerCase()] ?? 'application/octet-stream';

function install() {
  watchPage();
  const backListeners = new Set();
  cap.addListener(PLUGIN, 'back', () => {
    // The newest listener decides; nothing listening, or nothing to close: as Home.
    const last = [...backListeners].at(-1);
    if (!last || !last()) call('minimize').catch(() => {});
  });
  cap.addListener(PLUGIN, 'launch', () => drain());

  window.desktop = {
    platform: 'android',
    versions: { chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '' },
    secrets: {
      get: (key) => call('secretGet', { key }).then((r) => r.value ?? ''),
      set: (key, value) => call('secretSet', { key, value: value || null }),
    },
    // Model and speech servers (localFetch.js): asked by the app, as by the desktop's main process.
    llm: httpBridge(),
    // An attachment opened with another app (the phone asks which).
    openFile: (name, bytes) => call('openBytes', { name, mime: mimeOf(name), data: toBase64(bytes) }),
    // Download / Export: the phone asks where to save it. Resolves the name, or null when cancelled.
    async saveFile(name, bytes, mime = '') {
      const saved = await call('saveAs', { name, mime: mime || mimeOf(name), data: toBase64(bytes) });
      return saved.canceled ? null : saved.name;
    },
    // Open in editor goes to Tracker Editor's app when it is installed.
    hasEditorApp: () => call('appInstalled', { package: EDITOR_PACKAGE }).then((r) => Boolean(r.installed), () => false),
    // Links to items (tracker-app://item/<id>, from Claude's messages or another app).
    onOpenItem(callback) {
      const run = () => {
        for (const route of [...queue.routes]) {
          if (route.kind !== 'item') continue;
          queue.routes.splice(queue.routes.indexOf(route), 1);
          callback(route.id);
        }
      };
      run();
      return subscribe('routes', run);
    },
    // Share → Tracker and "Add to Tracker" on selected text: [{ title, text, files }].
    shared: {
      take: async () => take('shared'),
      onShared: (callback) => subscribe('shared', callback),
    },
    android: {
      // Back: `handler()` returns true when it closed something; the newest one is asked.
      onBack(handler) {
        backListeners.add(handler);
        return () => backListeners.delete(handler);
      },
      minimize: () => call('minimize'),
      // The icon's shortcuts: `callback('new' | 'voice')`.
      onShortcut(callback) {
        const run = () => {
          for (const route of [...queue.routes]) {
            if (route.kind !== 'new' && route.kind !== 'voice') continue;
            queue.routes.splice(queue.routes.indexOf(route), 1);
            callback(route.kind);
          }
        };
        run();
        return subscribe('routes', run);
      },
      // One phrase heard by the phone's speech input (dictation.js): its text.
      dictate: ({ lang = '' } = {}) => call('dictate', { lang, prompt: 'Say the item' }).then((r) => r.text ?? ''),
      // Send a log: the share sheet with the app's log (as from the icon's menu).
      sendLog: () => (flushLog(), call('sendLog')),
      info: () => call('info'),
      // Changes while the app is closed (Changes.java): the sync settings, the state, asking, a check now.
      notifications: {
        configure: (config) => call('notifyConfig', config).catch((err) => console.warn('Change checks', err)),
        state: () => call('notifyState'),
        ask: () => call('notifyAsk'),
        settings: () => call('notifySettings'),
        check: () => call('notifyCheck'),
      },
      // The status and navigation bars' icons follow the page's theme.
      barStyle: (dark) => cap.nativePromise('SystemBars', 'setStyle', { style: dark ? 'DARK' : 'LIGHT' }).catch(() => {}),
      tts: speech(),
    },
  };
  const root = document.documentElement;
  root.dataset.native = 'android';
  // The bars' icons: light on a dark page, dark on a light one.
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const barStyle = () => window.desktop.android.barStyle(root.dataset.theme && root.dataset.theme !== 'system' ? root.dataset.theme === 'dark' : dark.matches);
  new MutationObserver(barStyle).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  dark.addEventListener('change', barStyle);
  barStyle();
  drain();
}

if (inAndroidApp && !globalThis.window?.desktop) install();
