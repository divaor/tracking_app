import { html, render } from '../vendor/preact-htm.js';
import { App } from './app.js';
import { requestPersistence } from './kv.js';
import { applyTheme, onSettings } from './settings.js';
import { store } from './store.js';
import { startSync } from './syncManager.js';

const root = document.getElementById('root');

try {
  applyTheme();
  onSettings((s) => applyTheme(s.theme));
  await store.load();
  render(html`<${App} />`, root);
  startSync();
  requestPersistence();
} catch (err) {
  console.error(err);
  root.textContent = `Tracker could not start: ${err?.message ?? err}`;
  root.className = 'fatal';
}

// Not in the Android app: it carries the files itself (and its https://localhost would get one).
const canUseServiceWorker = (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)) && window.desktop?.platform !== 'android';
if ('serviceWorker' in navigator && canUseServiceWorker) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
}
