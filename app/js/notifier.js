// Tells the user about changes that arrive through sync: native
// notifications in the desktop app, a toast in the web app and the Android app
// while they are open. (Phones get push notifications from the connector instead,
// push.js; the Android app looks for changes itself while it is closed, Changes.java.)
import { summarizeEvents } from './changes.js';
import { isDesktopApp } from './platform.js';
import { getSettings } from './settings.js';

// `background`: the Android app's checks while it is closed.
export const DEFAULT_NOTIFY = { desktop: true, documents: true, items: true, boards: true, devices: false, background: true };

let showToast = null;
let openItem = (id) => {
  location.hash = `#/item/${encodeURIComponent(id)}`;
};
// A board's notification opens the board (only links into the app).
const openHref = (href) => /^#\/release-board\//.test(href ?? '') && (location.hash = href);

export function setNotificationHandlers({ toast, open }) {
  showToast = toast;
  if (open) openItem = open;
}

export function wantedEvents(events, prefs = DEFAULT_NOTIFY) {
  return events.filter((e) => {
    if (!e.fromClaude && !prefs.devices) return false;
    return e.category === 'documents' ? prefs.documents : e.category === 'boards' ? prefs.boards !== false : prefs.items;
  });
}

function systemNotification({ title, body, itemId, href }) {
  const n = new Notification(title, { body, tag: itemId ? `item-${itemId}` : href ? `board-${href}` : 'tracker', icon: 'icons/icon-192.png' });
  n.onclick = () => {
    window.desktop?.showWindow?.();
    window.focus();
    if (itemId) openItem(itemId);
    else openHref(href);
  };
}

export function notifyChanges(events) {
  const settings = getSettings();
  const prefs = { ...DEFAULT_NOTIFY, ...settings.notify };
  const wanted = wantedEvents(events, prefs);
  if (!wanted.length) return;
  // Up to three separate notifications, otherwise one summary.
  const groups = wanted.length <= 3 ? wanted.map((e) => [e]) : [wanted];

  if (isDesktopApp()) {
    if (prefs.desktop) for (const group of groups) systemNotification(summarizeEvents(group));
    return;
  }
  // With push on, the connector already notified this device.
  if (settings.push || document.visibilityState !== 'visible' || !showToast) return;
  for (const group of groups) {
    const { title, body, itemId, href } = summarizeEvents(group);
    const open = itemId ? () => openItem(itemId) : href ? () => openHref(href) : null;
    showToast(`${title}: ${body}`, open ? { action: { label: 'Open', run: open } } : {});
  }
}

/** A reminder (a step waiting on the person, due soon): a notification in the desktop app, else a toast while open. */
export function remind({ title, body, href }) {
  const prefs = { ...DEFAULT_NOTIFY, ...getSettings().notify };
  if (prefs.boards === false) return;
  if (isDesktopApp()) {
    if (prefs.desktop) systemNotification({ title, body, href });
    return;
  }
  if (document.visibilityState === 'visible' && showToast) showToast(`${title}: ${body}`, { duration: 15000, action: { label: 'Open', run: () => openHref(href) } });
}

export function testDesktopNotification() {
  systemNotification({ title: 'Tracker notifications work', body: 'You will see changes from Claude here.' });
}
