// Electron main process: serves the web app from app:// (a secure, standard
// origin so IndexedDB and ES modules work), keeps the GitHub token encrypted
// with the OS keychain, and opens outside links in the default browser.
const { app, BrowserWindow, Menu, ipcMain, net, protocol, safeStorage, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_DIR = path.join(__dirname, '..', 'app');
const APP_ORIGIN = 'app://tracker';
const REPO_URL = 'https://github.com/divaor/tracking_app';
const SECRET_KEYS = new Set(['github-token']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;

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

// ---- Window -------------------------------------------------------------

function isSafeExternal(url) {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol);
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

function send(command) {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send('command', command);
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

  mainWindow.on('close', () => {
    writeJson('window-state.json', { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
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
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: () => send('search') },
        { label: 'Sync Now', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('sync') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
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
      submenu: [{ label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const filePath = path.normalize(path.join(APP_DIR, relative));
    if (!filePath.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
