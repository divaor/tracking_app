import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describeChanges, summarizeEvents } from '../app/js/changes.js';
import { devicesPathFor, parseDevices, removeDevices, serializeDevices, upsertDevice } from '../app/js/devices.js';
import { applyPatch, CLAUDE_AUTHOR, createItem, tombstone } from '../app/js/model.js';
import { createServerFromEnv } from '../mcp/server.js';
import { wantedEvents } from '../app/js/notifier.js';
import { createFakeGitHub } from './helpers/fake-github.js';

const SECRET = 'connector-password-0123456789';

// A browser-side push subscription with real keys, so payloads can be decrypted.
function fakeBrowser(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    // RFC 8291 decryption, written against node:crypto independently of mcp/push.js.
    decrypt(body) {
      const buf = Buffer.from(body);
      const salt = buf.subarray(0, 16);
      const idlen = buf[20];
      const serverKey = buf.subarray(21, 21 + idlen);
      const ciphertext = buf.subarray(21 + idlen);
      const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
      const prkKey = hmac(auth, ecdh.computeSecret(serverKey));
      const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
      const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(-16));
      const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
      return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
    },
  };
}

function setup({ pushStatus = 201 } = {}) {
  const github = createFakeGitHub();
  const pushes = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://push.example/')) {
      pushes.push({ url, headers: init.headers, body: init.body });
      return new Response(null, { status: typeof pushStatus === 'function' ? pushStatus(url) : pushStatus });
    }
    return github.fetch(url, init);
  };
  const pending = [];
  const server = createServerFromEnv(
    { GITHUB_TOKEN: 'good-token', TRACKER_REPO: 'me/data', MCP_SECRET: SECRET, TRACKER_APP_URL: 'https://me.github.io/tracking_app/' },
    { fetchImpl, defer: (p) => pending.push(p) },
  );
  let id = 0;
  const call = async (name, args) => {
    const res = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    assert.ok(!res.result.isError, res.result.content[0].text);
    await Promise.all(pending.splice(0));
    return JSON.parse(res.result.content[0].text);
  };
  const register = (devices) => github.write('devices.json', serializeDevices(devices.reduce(upsertDevice, { app: 'tracker-devices', connectorUrl: '', devices: [] })));
  return { github, pushes, server, call, register };
}

test('devices file helpers', () => {
  assert.equal(devicesPathFor('tracker.json'), 'devices.json');
  assert.equal(devicesPathFor('data/tracker.json'), 'data/devices.json');
  const doc = upsertDevice(parseDevices('not json'), { id: 'a', name: 'Phone', subscription: { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'q' } }, events: ['documents'] });
  const parsed = parseDevices(serializeDevices(doc));
  assert.equal(parsed.devices[0].subscription.endpoint, 'https://push.example/a');
  assert.deepEqual(parsed.devices[0].events, ['documents']);
  assert.equal(parseDevices(JSON.stringify({ devices: [{ id: 'x', subscription: { endpoint: 'http://insecure' } }] })).devices[0].subscription, null);
  assert.deepEqual(removeDevices(parsed, ['a']).devices, []);
});

test('describeChanges names what changed and who changed it', () => {
  const t0 = '2026-10-20T10:00:00.000Z';
  const task = createItem({ title: 'Ship it', updatedBy: 'Phone' }, t0);
  const doc = createItem({ title: 'Plan', type: 'doc', kind: 'proposal', updatedBy: CLAUDE_AUTHOR, files: [{ path: 'files/x/p.md', sha: 'a' }] }, t0);
  const before = [task];
  const after = [applyPatch(task, { status: 'done', updatedBy: CLAUDE_AUTHOR }), doc];
  const events = describeChanges(before, after);
  assert.deepEqual(events.map((e) => [e.category, e.title, e.body, e.fromClaude]), [
    ['items', 'Claude marked a task done', 'Ship it', true],
    ['documents', 'New proposal to review', 'Plan', true],
  ]);
  const version = applyPatch(doc, { files: [{ path: 'files/x/p.md', sha: 'b' }], updatedBy: CLAUDE_AUTHOR });
  assert.equal(describeChanges([doc], [version])[0].title, 'New version ready to review');
  assert.equal(describeChanges([task], [tombstone(task, t0, 'Work PC')])[0].title, 'Work PC deleted a task');
  assert.deepEqual(describeChanges([task], [applyPatch(task, { title: 'x', updatedBy: 'Laptop' })], { self: 'Laptop' }), [], 'own changes are skipped');
  assert.equal(summarizeEvents(events).title, 'Claude: 2 changes');
});

test('connector pushes encrypted notifications to registered devices', async () => {
  const s = setup();
  const phone = fakeBrowser('https://push.example/phone');
  const laptop = fakeBrowser('https://push.example/laptop');
  s.register([
    { id: 'phone', name: 'Phone', subscription: phone.subscription, events: ['documents', 'items'] },
    { id: 'laptop', name: 'Laptop', subscription: laptop.subscription, events: ['items'] },
  ]);

  const sent = await s.call('send_document', { title: 'Offline sync', kind: 'proposal', content: '# Plan' });
  assert.equal(s.pushes.length, 1, 'only the device that wants documents');
  const push = s.pushes[0];
  assert.equal(push.url, 'https://push.example/phone');
  assert.equal(push.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(push.headers.TTL, '86400');
  assert.match(push.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  const message = phone.decrypt(push.body);
  assert.equal(message.title, 'New proposal to review');
  assert.equal(message.body, 'Offline sync');
  assert.equal(message.itemId, sent.item.id);
  assert.equal(message.tag, `item-${sent.item.id}`);

  s.pushes.length = 0;
  await s.call('add_items', { items: [{ title: 'A' }, { title: 'B' }] });
  assert.equal(s.pushes.length, 2);
  const summary = laptop.decrypt(s.pushes.find((p) => p.url.endsWith('laptop')).body);
  assert.equal(summary.title, 'Claude: 2 changes');
  assert.equal(summary.body, 'A, B');
});

test('expired subscriptions are removed from the devices file', async () => {
  const s = setup({ pushStatus: (url) => (url.endsWith('gone') ? 410 : 201) });
  const live = fakeBrowser('https://push.example/live');
  const gone = fakeBrowser('https://push.example/gone');
  s.register([
    { id: 'live', subscription: live.subscription },
    { id: 'gone', subscription: gone.subscription },
  ]);
  await s.call('add_items', { items: [{ title: 'Hello' }] });
  assert.deepEqual(parseDevices(s.github.read('devices.json')).devices.map((d) => d.id), ['live']);
});

test('push endpoints: public key for the app, test notification with the GitHub token', async () => {
  const s = setup();
  const phone = fakeBrowser('https://push.example/phone');
  s.register([{ id: 'phone', subscription: phone.subscription }]);
  const config = await (await s.server.http(new Request('https://c.example/push/config'))).json();
  assert.match(config.vapidPublicKey, /^[\w-]{87}$/);
  assert.equal(Buffer.from(config.vapidPublicKey, 'base64url')[0], 4, 'uncompressed P-256 point');

  const post = (token, body) =>
    s.server.http(new Request('https://c.example/push/test', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const ok = await (await post('good-token', { deviceId: 'phone' })).json();
  assert.equal(ok.ok, true);
  assert.equal(phone.decrypt(s.pushes[0].body).title, 'Tracker notifications work');
  assert.equal((await post('bad-token', { deviceId: 'phone' })).status, 403);
  assert.equal((await (await post('good-token', { deviceId: 'nope' })).json()).ok, false);
  const preflight = await s.server.http(new Request('https://c.example/push/test', { method: 'OPTIONS' }));
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('items written by the connector are attributed to Claude', async () => {
  const s = setup();
  await s.call('add_items', { items: [{ title: 'From Claude' }] });
  const data = JSON.parse(s.github.read('tracker.json'));
  assert.equal(data.items[0].updatedBy, CLAUDE_AUTHOR);
});

test('notification preferences filter events', () => {
  const events = [
    { category: 'documents', fromClaude: true },
    { category: 'items', fromClaude: true },
    { category: 'items', fromClaude: false },
    { category: 'documents', fromClaude: false },
  ];
  const pick = (prefs) => wantedEvents(events, { desktop: true, documents: true, items: true, devices: false, ...prefs }).map((e) => `${e.category}:${e.fromClaude}`);
  assert.deepEqual(pick({}), ['documents:true', 'items:true']);
  assert.deepEqual(pick({ devices: true }), ['documents:true', 'items:true', 'items:false', 'documents:false']);
  assert.deepEqual(pick({ items: false }), ['documents:true']);
  assert.deepEqual(pick({ documents: false, devices: true }), ['items:true', 'items:false']);
});

test('pinning and unpinning are named in notifications', async () => {
  const { normalizeItem } = await import('../app/js/model.js');
  const before = [normalizeItem({ id: 'a', title: 'Plan', updatedAt: '2026-10-01T00:00:00.000Z' })];
  const pinned = [normalizeItem({ ...before[0], pinned: true, updatedAt: '2026-10-02T00:00:00.000Z', updatedBy: 'Claude' })];
  assert.equal(describeChanges(before, pinned)[0].title, 'Claude pinned a task');
  const unpinned = [normalizeItem({ ...before[0], updatedAt: '2026-10-03T00:00:00.000Z', updatedBy: 'Claude' })];
  assert.equal(describeChanges(pinned, unpinned)[0].title, 'Claude unpinned a task');
});
