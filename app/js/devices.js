// The devices file sits next to the data file in the repo. Each phone or
// browser that turned on push notifications registers its push subscription
// and the events it wants; the connector reads it to send notifications.
// Pure functions: shared by the app and the connector.

export const NOTIFY_EVENTS = [
  { id: 'documents', label: 'Documents to review', hint: 'New proposals, artifacts and files, and new versions' },
  { id: 'items', label: 'Tasks and items changed by Claude', hint: 'Added, updated, completed or deleted' },
  { id: 'boards', label: 'Release boards', hint: 'A test failed, a release changed status, a decision or a step waits for you, a comment' },
];
export const DEFAULT_EVENTS = NOTIFY_EVENTS.map((e) => e.id);

export function devicesPathFor(dataPath = 'tracker.json') {
  const dir = String(dataPath).split('/').slice(0, -1).join('/');
  return dir ? `${dir}/devices.json` : 'devices.json';
}

export function emptyDevices() {
  return { app: 'tracker-devices', connectorUrl: '', devices: [] };
}

function cleanSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return null;
  const { p256dh, auth } = sub.keys ?? {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

export function parseDevices(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return emptyDevices();
  }
  const devices = (Array.isArray(data?.devices) ? data.devices : [])
    .filter((d) => d && typeof d.id === 'string' && d.id)
    .map((d) => ({
      id: d.id,
      name: typeof d.name === 'string' ? d.name : '',
      platform: typeof d.platform === 'string' ? d.platform : '',
      subscription: cleanSubscription(d.subscription),
      events: Array.isArray(d.events) ? d.events.filter((e) => DEFAULT_EVENTS.includes(e)) : [...DEFAULT_EVENTS],
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
    }));
  return { app: 'tracker-devices', connectorUrl: typeof data?.connectorUrl === 'string' ? data.connectorUrl : '', devices };
}

export const serializeDevices = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

export function upsertDevice(doc, device) {
  const others = doc.devices.filter((d) => d.id !== device.id);
  return { ...doc, devices: [...others, { ...device, subscription: cleanSubscription(device.subscription) }] };
}

export function removeDevices(doc, ids) {
  const drop = new Set(ids);
  return { ...doc, devices: doc.devices.filter((d) => !drop.has(d.id)) };
}
