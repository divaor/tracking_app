// Tells the user about changes that arrive through sync: native
// notifications in the desktop app, a toast in the web app while it is open.
// (Phones get push notifications from the connector instead; see push.js.)
import { summarizeEvents } from './changes.js';
import { getSettings } from './settings.js';

export const DEFAULT_NOTIFY = { desktop: true, documents: true, items: true, devices: false };

let showToast = null;
let openItem = (id) => {
  location.hash = `#/item/${encodeURIComponent(id)}`;
};

export function setNotificationHandlers({ toast, open }) {
  showToast = toast;
  if (open) openItem = open;
}

export function wantedEvents(events, prefs = DEFAULT_NOTIFY) {
  return events.filter((e) => {
    if (!e.fromClaude && !prefs.devices) return false;
    return e.category === 'documents' ? prefs.documents : prefs.items;
  });
}

function systemNotification({ title, body, itemId }) {
  const n = new Notification(title, { body, tag: itemId ? `item-${itemId}` : 'tracker', icon: 'icons/icon-192.png' });
  n.onclick = () => {
    window.desktop?.showWindow?.();
    window.focus();
    if (itemId) openItem(itemId);
  };
}

export function notifyChanges(events) {
  const settings = getSettings();
  const prefs = { ...DEFAULT_NOTIFY, ...settings.notify };
  const wanted = wantedEvents(events, prefs);
  if (!wanted.length) return;
  // Up to three separate notifications, otherwise one summary.
  const groups = wanted.length <= 3 ? wanted.map((e) => [e]) : [wanted];

  if (window.desktop) {
    if (prefs.desktop) for (const group of groups) systemNotification(summarizeEvents(group));
    return;
  }
  // With push on, the connector already notified this device.
  if (settings.push || document.visibilityState !== 'visible' || !showToast) return;
  for (const group of groups) {
    const { title, body, itemId } = summarizeEvents(group);
    showToast(`${title}: ${body}`, itemId ? { action: { label: 'Open', run: () => openItem(itemId) } } : {});
  }
}

export function testDesktopNotification() {
  systemNotification({ title: 'Tracker notifications work', body: 'You will see changes from Claude here.' });
}
