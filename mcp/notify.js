// Sends push notifications about the connector's changes to the devices
// registered in the data repo's devices file.
import { summarizeEvents } from '../app/js/changes.js';
import { devicesPathFor, emptyDevices, parseDevices, removeDevices, serializeDevices } from '../app/js/devices.js';
import { deriveVapidKeys, sendPush } from './push.js';

const isConflict = (err) => err?.status === 409 || err?.status === 422;

export function createNotifier({ client, path = 'tracker.json', branch = '', secret, subject, fetchImpl, log = (...args) => console.warn(...args) }) {
  const ref = branch || undefined;
  const devicesPath = devicesPathFor(path);
  let vapid = null;
  const keys = () => (vapid ??= deriveVapidKeys(secret));

  async function loadDevices() {
    const file = await client.getFile(devicesPath, ref);
    return { sha: file?.sha, doc: file ? parseDevices(file.text) : emptyDevices() };
  }

  async function forget(ids) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { sha, doc } = await loadDevices();
      if (!sha) return;
      try {
        await client.putFile(devicesPath, {
          text: serializeDevices(removeDevices(doc, ids)),
          sha,
          branch: ref,
          message: 'Tracker: remove expired notification subscriptions',
        });
        return;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
  }

  async function deliver(device, message) {
    const status = await sendPush(device.subscription, message, { vapid: await keys(), subject, fetchImpl });
    if (status >= 400) log(`Push to ${device.name || device.id} failed with HTTP ${status}`);
    return status;
  }

  return {
    enabled: Boolean(secret),
    publicKey: async () => (await keys()).publicKey,

    /** Sends one notification per device covering the events it subscribed to. */
    async notify(events) {
      if (!secret || !events?.length) return { sent: 0 };
      const { doc } = await loadDevices();
      const gone = [];
      let sent = 0;
      await Promise.all(
        doc.devices
          .filter((d) => d.subscription)
          .map(async (device) => {
            const wanted = events.filter((e) => device.events.includes(e.category));
            if (!wanted.length) return;
            const summary = summarizeEvents(wanted);
            const message = { ...summary, category: wanted[0].category, tag: summary.itemId ? `item-${summary.itemId}` : 'tracker' };
            const status = await deliver(device, message).catch((err) => {
              log(`Push to ${device.name || device.id} failed: ${err.message}`);
              return 0;
            });
            if (status === 404 || status === 410) gone.push(device.id);
            else if (status >= 200 && status < 300) sent++;
          }),
      );
      if (gone.length) await forget(gone).catch((err) => log(`Could not clean up subscriptions: ${err.message}`));
      return { sent, removed: gone.length };
    },

    async test(deviceId) {
      const { doc } = await loadDevices();
      const device = doc.devices.find((d) => d.id === deviceId && d.subscription);
      if (!device) return { ok: false, error: 'This device is not registered for notifications yet.' };
      try {
        const status = await deliver(device, { title: 'Tracker notifications work', body: 'You will be notified when Claude sends documents or changes items.', tag: 'test' });
        return status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: `The push service answered ${status}.` };
      } catch (err) {
        return { ok: false, error: `Could not reach the push service: ${err.message}` };
      }
    },
  };
}
