// The quick add window's bridge: only what that small page needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickAdd', {
  platform: process.platform,
  submit: (entry) => ipcRenderer.invoke('quick:submit', entry),
  close: () => ipcRenderer.invoke('quick:close'),
  // The window lost the focus (another app was clicked).
  onBlur(callback) {
    ipcRenderer.on('quick:blur', () => callback());
  },
});
