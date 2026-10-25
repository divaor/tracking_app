// Exposes a small, explicit API to the web app. Runs sandboxed with context
// isolation, so the page never gets direct access to Node or Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  secrets: {
    get: (key) => ipcRenderer.invoke('secret:get', key),
    set: (key, value) => ipcRenderer.invoke('secret:set', key, value),
  },
  // The data on this computer in local mode: the folder Tracker Editor shares (localStore.cjs), for localRepo.js.
  data: {
    get: (key) => ipcRenderer.invoke('data:get', key),
    put: (key, value) => ipcRenderer.invoke('data:put', key, value),
    cas: (key, expected, value) => ipcRenderer.invoke('data:cas', key, expected, value),
    del: (key) => ipcRenderer.invoke('data:del', key),
    list: (prefix) => ipcRenderer.invoke('data:list', prefix),
    info: () => ipcRenderer.invoke('data:info'),
    show: () => ipcRenderer.invoke('data:show'),
    onChanged(callback) {
      const listener = () => callback();
      ipcRenderer.on('data:changed', listener);
      ipcRenderer.send('data:watch');
      return () => ipcRenderer.removeListener('data:changed', listener);
    },
  },
  // Model requests go through the main process (no CORS setup on the server).
  llm: {
    request: (id, url, init) => ipcRenderer.invoke('llm:request', id, url, init),
    abort: (id) => ipcRenderer.send('llm:abort', id),
    onChunk(id, callback) {
      const listener = (_event, chunkId, chunk, done, error) => chunkId === id && callback(chunk, done, error);
      ipcRenderer.on('llm:chunk', listener);
      return () => ipcRenderer.removeListener('llm:chunk', listener);
    },
  },
  // Receives a model service's answers by webhook (port and path from Settings).
  webhook: {
    listen: (opts) => ipcRenderer.invoke('webhook:listen', opts),
    close: () => ipcRenderer.invoke('webhook:close'),
    onEvent(callback) {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('webhook:event', listener);
      return () => ipcRenderer.removeListener('webhook:event', listener);
    },
  },
  // Quick add from anywhere (a global shortcut and a small window).
  capture: {
    get: () => ipcRenderer.invoke('quick:get'),
    set: (patch) => ipcRenderer.invoke('quick:set', patch),
    open: () => ipcRenderer.invoke('quick:open'),
    take: () => ipcRenderer.invoke('quick:take'),
  },
  showWindow: () => ipcRenderer.invoke('window:show'),
  getRunInBackground: () => ipcRenderer.invoke('background:get'),
  setRunInBackground: (value) => ipcRenderer.invoke('background:set', Boolean(value)),
  hasEditorApp: () => ipcRenderer.invoke('editor:installed'),
  onCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('command', listener);
    return () => ipcRenderer.removeListener('command', listener);
  },
  // An item to open, from a tracker-app://item/<id> link (or a link to the web app clicked here).
  onOpenItem(callback) {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on('open-item', listener);
    return () => ipcRenderer.removeListener('open-item', listener);
  },
});
