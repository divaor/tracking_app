// Electron main process: serves the web app from app:// (a secure, standard
// origin so IndexedDB and ES modules work), keeps the GitHub token encrypted
// with the OS keychain, opens outside links in the default browser, and can
// keep running in the system tray so notifications keep arriving. It also
// makes the model's requests (no CORS setup needed), receives a model
// service's answers by webhook, and opens the quick add window from a global shortcut.
const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, net, protocol, safeStorage, screen, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_DIR = path.join(__dirname, '..', 'app');
const APP_ORIGIN = 'app://tracker';
const REPO_URL = 'https://github.com/divaor/tracking_app';
// The model connections' keys are providers.js's LLM_KEY_SECRETS (test/providers.test.js checks the list).
const SECRET_KEYS = new Set(['github-token', 'llm-api-key', 'llm-webhook-secret', 'llm-key-local', 'llm-key-anthropic', 'llm-key-openai', 'llm-key-gemini', 'llm-key-openrouter', 'llm-key-mistral', 'llm-key-groq', 'llm-key-custom']);
// Tracker Editor's desktop app opens tracker-editor:// links.
const EDITOR_SCHEME = 'tracker-editor:';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Windows only shows notifications for apps with an AppUserModelID.
if (process.platform === 'win32') app.setAppUserModelId('com.divaor.tracker');

let mainWindow = null;
let tray = null;
let quitting = false;

// ---- Small JSON files in the user data folder ------------------------------

const dataFile = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`Could not write ${name}`, err);
  }
}

// ---- Secrets ------------------------------------------------------------

function getSecret(key) {
  const entry = readJson('secrets.json', {})[key];
  if (!entry) return '';
  const buffer = Buffer.from(entry.data, 'base64');
  if (!entry.encrypted) return buffer.toString('utf8');
  try {
    return safeStorage.decryptString(buffer);
  } catch {
    return '';
  }
}

function setSecret(key, value) {
  const secrets = readJson('secrets.json', {});
  if (!value) {
    delete secrets[key];
  } else if (safeStorage.isEncryptionAvailable()) {
    secrets[key] = { encrypted: true, data: safeStorage.encryptString(value).toString('base64') };
  } else {
    secrets[key] = { encrypted: false, data: Buffer.from(value, 'utf8').toString('base64') };
  }
  writeJson('secrets.json', secrets);
}

const fromApp = (event) => event.senderFrame?.url?.startsWith(`${APP_ORIGIN}/`);

ipcMain.handle('secret:get', (event, key) => {
  if (!fromApp(event) || !SECRET_KEYS.has(key)) throw new Error('Not allowed');
  return getSecret(key);
});

ipcMain.handle('secret:set', (event, key, value) => {
  if (!fromApp(event) || !SECRET_KEYS.has(key) || typeof value !== 'string') throw new Error('Not allowed');
  setSecret(key, value);
  return true;
});

ipcMain.handle('window:show', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  showWindow();
});

ipcMain.handle('background:get', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  return runInBackground();
});

ipcMain.handle('background:set', (event, value) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  return setRunInBackground(value);
});

ipcMain.handle('editor:installed', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  try {
    return Boolean(app.getApplicationNameForProtocol(`${EDITOR_SCHEME}//`));
  } catch {
    return false;
  }
});

// ---- Model requests (Ollama, LM Studio, a model service, …) ------------------
// As in Tracker Editor: made here rather than in the page so the server needs
// no CORS settings. The body streams back to the page in chunks.

const requests = new Map(); // id → AbortController

ipcMain.handle('llm:request', async (event, id, url, init) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only http and https model servers are supported');
  const controller = new AbortController();
  requests.set(id, controller);
  let res;
  try {
    // Chromium's network stack: the system's certificates and proxy, as at work.
    res = await net.fetch(target.href, { method: init.method, headers: init.headers, body: init.body ?? undefined, signal: controller.signal, bypassCustomProtocolHandlers: true });
  } catch (err) {
    requests.delete(id);
    const refused = err?.cause?.code === 'ECONNREFUSED' || /ERR_CONNECTION_REFUSED/.test(err?.message ?? '');
    throw new Error(refused ? `Nothing is listening at ${target.origin}` : (err?.message ?? 'Request failed'));
  }
  const sender = event.sender;
  (async () => {
    try {
      if (res.body) for await (const chunk of res.body) if (!sender.isDestroyed()) sender.send('llm:chunk', id, chunk, false, null);
      if (!sender.isDestroyed()) sender.send('llm:chunk', id, null, true, null);
    } catch (err) {
      if (!sender.isDestroyed()) sender.send('llm:chunk', id, null, true, err?.name === 'AbortError' ? 'Stopped' : (err?.message ?? 'Stream failed'));
    } finally {
      requests.delete(id);
    }
  })();
  return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers) };
});

ipcMain.on('llm:abort', (event, id) => {
  if (fromApp(event)) requests.get(id)?.abort();
});

// ---- Answers from a model service, by webhook --------------------------------
// For services that answer later (asyncLlm.js): they POST each task's events
// here. With a webhook secret set, the body must carry its HMAC-SHA256 (hex,
// in the profile's signature header); anything else is refused.

let hook = null; // { server, port, path, header, sender }

function onHook(req, res) {
  if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== hook.path) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const secret = getSecret('llm-webhook-secret');
    if (secret) {
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      const got = String(req.headers[hook.header.toLowerCase()] ?? '').trim().replace(/^sha256=/i, '').toLowerCase();
      if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        res.writeHead(401).end();
        return;
      }
    }
    // Answered at once: services wait only a few seconds.
    res.writeHead(204).end();
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      return;
    }
    if (hook && !hook.sender.isDestroyed()) hook.sender.send('webhook:event', data);
  });
}

ipcMain.handle('webhook:listen', async (event, opts = {}) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  const port = Number(opts.port);
  const hookPath = String(opts.path || '/llm-webhook');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.');
  if (!hookPath.startsWith('/')) throw new Error('The webhook path must start with /.');
  const header = String(opts.signatureHeader || 'X-Signature');
  if (hook?.port === port) {
    Object.assign(hook, { path: hookPath, header, sender: event.sender });
    return { port };
  }
  hook?.server.close();
  hook = null;
  const server = http.createServer(onHook);
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use on this computer (Tracker Editor may use it: pick another).` : err.message)));
    server.listen(port, '0.0.0.0', resolve);
  });
  hook = { server, port, path: hookPath, header, sender: event.sender };
  return { port };
});

ipcMain.handle('webhook:close', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  hook?.server.close();
  hook = null;
  return true;
});

// ---- Quick add from anywhere: a small window from a global shortcut ---------
// What is typed there goes to the main window (its quick add, with the model
// when one is on), through quick-adds.json so nothing is lost if that window
// is not up yet.

const DEFAULT_QUICK_ADD = 'CommandOrControl+Alt+T';
let quickWindow = null;
let quickShortcut = null;
let quickStatus = 'off'; // 'ok' | 'taken' | 'invalid' | 'off'
const pendingAdds = [];

const quickPrefs = () => ({ enabled: false, shortcut: DEFAULT_QUICK_ADD, ...readJson('prefs.json', {}).quickAdd });

function registerQuickAdd() {
  if (quickShortcut) globalShortcut.unregister(quickShortcut);
  quickShortcut = null;
  quickStatus = 'off';
  const { enabled, shortcut } = quickPrefs();
  if (!enabled) return;
  try {
    if (globalShortcut.register(shortcut, openQuickAdd)) {
      quickShortcut = shortcut;
      quickStatus = 'ok';
    } else quickStatus = 'taken';
  } catch {
    quickStatus = 'invalid';
  }
}

function openQuickAdd() {
  if (quickWindow) {
    quickWindow.show();
    quickWindow.focus();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(560, area.width - 40);
  quickWindow = new BrowserWindow({
    width,
    height: 190,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * 0.22),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'Quick add',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'quickAddPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  quickWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  quickWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  quickWindow.once('ready-to-show', () => {
    quickWindow.show();
    quickWindow.focus();
  });
  quickWindow.on('blur', () => quickWindow?.webContents.send('quick:blur'));
  quickWindow.on('closed', () => {
    quickWindow = null;
  });
  quickWindow.loadURL(`${APP_ORIGIN}/quick-add.html`);
}

const fromQuick = (event) => quickWindow && event.sender === quickWindow.webContents;
const quickState = () => ({ ...quickPrefs(), status: quickStatus });

ipcMain.handle('quick:get', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  return quickState();
});
ipcMain.handle('quick:set', (event, patch = {}) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  const next = { ...quickPrefs() };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (typeof patch.shortcut === 'string' && patch.shortcut.trim()) next.shortcut = patch.shortcut.trim().slice(0, 60);
  writeJson('prefs.json', { ...readJson('prefs.json', {}), quickAdd: next });
  registerQuickAdd();
  updateTray(true);
  return quickState();
});
ipcMain.handle('quick:open', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  openQuickAdd();
});
ipcMain.handle('quick:close', (event) => {
  if (fromQuick(event)) quickWindow.close();
});
ipcMain.handle('quick:submit', (event, entry) => {
  const text = String(entry?.text ?? '').trim();
  if (!fromQuick(event) || !text) return false;
  pendingAdds.push({ text: text.slice(0, 2000), type: ['task', 'idea', 'claude', 'doc'].includes(entry.type) ? entry.type : 'task', at: Date.now() });
  writeJson('quick-adds.json', pendingAdds);
  quickWindow.close();
  // A window that is still loading takes them when it starts.
  if (!mainWindow) createWindow();
  else if (!mainWindow.webContents.isLoading()) mainWindow.webContents.send('command', 'quick-adds');
  return true;
});
// The main window takes what was typed.
ipcMain.handle('quick:take', (event) => {
  if (event.sender !== mainWindow?.webContents) return [];
  const taken = pendingAdds.splice(0);
  writeJson('quick-adds.json', []);
  return taken;
});

// ---- Window -------------------------------------------------------------

function isSafeExternal(url) {
  try {
    return ['https:', 'http:', 'mailto:', EDITOR_SCHEME].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function restoreBounds() {
  const saved = readJson('window-state.json', null);
  const defaults = { width: 1280, height: 840 };
  if (!saved?.bounds) return defaults;
  const area = screen.getDisplayMatching(saved.bounds).workArea;
  const visible =
    saved.bounds.x < area.x + area.width - 80 &&
    saved.bounds.y < area.y + area.height - 80 &&
    saved.bounds.x + saved.bounds.width > area.x + 80 &&
    saved.bounds.y >= area.y - 20;
  return visible ? { ...saved.bounds, maximized: saved.maximized } : defaults;
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function send(command) {
  if (!mainWindow) return;
  showWindow();
  mainWindow.webContents.send('command', command);
}

// ---- Background mode (system tray) -------------------------------------------

const runInBackground = () => readJson('prefs.json', {}).runInBackground !== false;

function setRunInBackground(value) {
  writeJson('prefs.json', { ...readJson('prefs.json', {}), runInBackground: Boolean(value) });
  updateTray();
  return runInBackground();
}

function updateTray(rebuild = false) {
  if (!runInBackground()) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (tray && !rebuild) return;
  if (tray) {
    tray.setContextMenu(trayMenu());
    return;
  }
  try {
    const icon = nativeImage.createFromPath(path.join(APP_DIR, 'icons', 'icon-192.png')).resize({ width: 18, height: 18 });
    tray = new Tray(icon);
  } catch (err) {
    console.warn('System tray is not available', err);
    tray = null;
    return;
  }
  tray.setToolTip('Tracker');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

function trayMenu() {
  const quick = quickPrefs();
  return Menu.buildFromTemplate([
    { label: 'Open Tracker', click: showWindow },
    { label: 'Quick Add…', accelerator: quick.enabled ? quick.shortcut : undefined, registerAccelerator: false, click: openQuickAdd },
    { label: 'Sync Now', click: () => mainWindow?.webContents.send('command', 'sync') },
    { type: 'separator' },
    {
      label: 'Quit Tracker',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createWindow() {
  const { maximized, ...bounds } = restoreBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Tracker',
    icon: path.join(APP_DIR, 'icons', 'icon-512.png'),
    backgroundColor: '#f6f5f1',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Keep the sync timer running while hidden, for notifications.
      backgroundThrottling: false,
    },
  });
  if (maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${APP_ORIGIN}/`)) return;
    event.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (event) => {
    writeJson('window-state.json', { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
    if (quitting || !runInBackground() || !tray) return;
    // Hide instead of quitting so syncing and notifications continue.
    event.preventDefault();
    mainWindow.hide();
    const prefs = readJson('prefs.json', {});
    if (!prefs.toldAboutTray && Notification.isSupported()) {
      new Notification({ title: 'Tracker is still running', body: 'It keeps syncing in the background. Quit it from the tray icon.' }).show();
      writeJson('prefs.json', { ...prefs, toldAboutTray: true });
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Item', accelerator: 'CmdOrCtrl+N', click: () => send('new-item') },
        { label: 'Quick Add…', click: () => openQuickAdd() },
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: () => send('search') },
        { label: 'Sync Now', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('sync') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        isMac
          ? { role: 'close' }
          : {
              label: 'Quit',
              accelerator: 'CmdOrCtrl+Q',
              click: () => {
                quitting = true;
                app.quit();
              },
            },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Commands and Shortcuts', accelerator: 'F1', click: () => send('help') },
        { label: 'Guide', click: () => send('help-guide') },
        { type: 'separator' },
        { label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const filePath = path.normalize(path.join(APP_DIR, relative));
    if (!filePath.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  buildMenu();
  pendingAdds.push(...readJson('quick-adds.json', []));
  registerQuickAdd();
  createWindow();
  updateTray();

  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  quitting = true;
  quickWindow?.destroy();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
