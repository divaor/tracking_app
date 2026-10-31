// Web Push on phones and browsers: subscribes this device and registers it
// in the data repo's devices file, where the Claude connector looks up whom
// to notify. (The desktop app uses native notifications instead.)
import { createGitHubClient } from './github.js';
import { DEFAULT_EVENTS, devicesPathFor, emptyDevices, parseDevices, removeDevices, serializeDevices, upsertDevice } from './devices.js';
import { newId } from './model.js';
import { getSettings, getToken, isSyncConfigured, saveSettings } from './settings.js';

const DEVICE_KEY = 'tracker.deviceId';

export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'this-device';
  }
}

export function pushSupport() {
  if (window.desktop) return { supported: false, reason: 'desktop' };
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return { supported: false, reason: 'insecure' };
  if (!('PushManager' in window) || !('Notification' in window)) return { supported: false, reason: ios && !standalone ? 'ios-install' : 'unsupported' };
  return { supported: true };
}

export const normalizeConnectorUrl = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\/+(mcp(\/.*)?)?$/, '');

export async function fetchVapidKey(connectorUrl) {
  const base = normalizeConnectorUrl(connectorUrl);
  if (!/^https:\/\//.test(base)) throw new Error('Enter the connector address, starting with https://');
  let res;
  try {
    res = await fetch(`${base}/push/config`, { cache: 'no-store' });
  } catch {
    throw new Error('Could not reach the connector. Check the address.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.vapidPublicKey) throw new Error(data.error || `The connector answered ${res.status}. Is it deployed with the latest version?`);
  return data.vapidPublicKey;
}

async function repo() {
  const settings = getSettings();
  const token = await getToken();
  if (!isSyncConfigured(settings) || !token) throw new Error('Set up GitHub sync first.');
  return {
    settings,
    token,
    client: createGitHubClient({ token, owner: settings.owner, repo: settings.repo }),
    path: devicesPathFor(settings.path),
    ref: settings.branch || undefined,
  };
}

export async function readDevices() {
  const { client, path, ref } = await repo();
  const file = await client.getFile(path, ref);
  return file ? parseDevices(file.text) : emptyDevices();
}

async function updateDevices(change, message) {
  const { client, path, ref } = await repo();
  for (let attempt = 1; ; attempt++) {
    const file = await client.getFile(path, ref);
    const doc = change(file ? parseDevices(file.text) : emptyDevices());
    try {
      await client.putFile(path, { text: serializeDevices(doc), sha: file?.sha, branch: ref, message });
      return doc;
    } catch (err) {
      if ((err.status !== 409 && err.status !== 422) || attempt >= 4) throw err;
    }
  }
}

const sameKey = (subscription, key) => {
  const current = subscription?.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((b, i) => b === key[i]);
};

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/**
 * Call straight from a click handler: iOS only shows the permission prompt
 * inside a user gesture, so the VAPID key is fetched beforehand.
 */
export async function enablePush({ connectorUrl, vapidKey, events = DEFAULT_EVENTS }) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this app. Allow them in your browser or phone settings, then try again.');
  const registration = await navigator.serviceWorker.ready;
  const key = keyBytes(vapidKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const settings = getSettings();
  const base = normalizeConnectorUrl(connectorUrl);
  await updateDevices(
    (doc) =>
      upsertDevice(
        { ...doc, connectorUrl: base || doc.connectorUrl },
        { id: deviceId(), name: settings.device, platform: 'web', subscription: subscription.toJSON(), events, updatedAt: new Date().toISOString() },
      ),
    `Tracker: turn on notifications for ${settings.device}`,
  );
  saveSettings({ connectorUrl: base, push: true, notify: { ...settings.notify, ...Object.fromEntries(DEFAULT_EVENTS.map((id) => [id, events.includes(id)])) } });
}

export async function disablePush() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
  const id = deviceId();
  await updateDevices((doc) => removeDevices(doc, [id]), `Tracker: turn off notifications for ${getSettings().device}`);
  saveSettings({ push: false });
}

export async function updatePushEvents(events) {
  const id = deviceId();
  await updateDevices(
    (doc) => {
      const device = doc.devices.find((d) => d.id === id);
      return device ? upsertDevice(doc, { ...device, events, updatedAt: new Date().toISOString() }) : doc;
    },
    `Tracker: notification settings for ${getSettings().device}`,
  );
}

export async function isPushActive() {
  if (!pushSupport().supported || !getSettings().push) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(await registration?.pushManager.getSubscription());
}

export async function sendTestPush(connectorUrl) {
  const token = await getToken();
  const res = await fetch(`${normalizeConnectorUrl(connectorUrl)}/push/test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `The connector answered ${res.status}.`);
}
