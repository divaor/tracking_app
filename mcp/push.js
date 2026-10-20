// Web Push sender: VAPID authentication (RFC 8292) and aes128gcm payload
// encryption (RFC 8291). WebCrypto only, so it runs on Workers and Node.

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export function toBase64Url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function concat(...parts) {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmac(key, data) {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data));
}

// PKCS#8 wrapper for a bare P-256 private scalar (the public point is left
// out; the crypto library derives it on import).
const P256_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
  0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
]);

/**
 * VAPID keys derived from the connector secret, so there is nothing extra to
 * generate or store. Rotating the secret rotates these keys (devices then
 * need to turn notifications on again).
 */
export async function deriveVapidKeys(secret) {
  const d = await hmac(enc.encode(String(secret)), enc.encode('tracker-vapid-key-v1'));
  const signing = await subtle().importKey('pkcs8', concat(P256_PKCS8_PREFIX, d), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await subtle().exportKey('jwk', signing);
  const publicKey = concat([4], fromBase64Url(jwk.x), fromBase64Url(jwk.y));
  return { privateKey: signing, publicKey: toBase64Url(publicKey) };
}

export async function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const header = toBase64Url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}

/**
 * Encrypts `plaintext` for a push subscription (RFC 8291 / RFC 8188, one
 * record). `salt` and `localKeys` are only passed by tests.
 */
export async function encryptPayload(plaintext, keys, { salt = crypto.getRandomValues(new Uint8Array(16)), localKeys } = {}) {
  const uaPublic = fromBase64Url(keys.p256dh);
  const authSecret = fromBase64Url(keys.auth);
  const local = localKeys ?? (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await subtle().exportKey('raw', local.publicKey));
  const uaKey = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);

  const aesKey = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(enc.encode(plaintext), [2]); // 0x02: last (and only) record, no padding
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));
  const recordSize = 4096;
  const header = concat(salt, [(recordSize >>> 24) & 255, (recordSize >>> 16) & 255, (recordSize >>> 8) & 255, recordSize & 255], [asPublic.length], asPublic);
  return concat(header, ciphertext);
}

// Push services accept 4 KB; keep the JSON well under that.
export const MAX_PAYLOAD_BYTES = 3000;

/** Sends one notification. Resolves to the push service's HTTP status. */
export async function sendPush(subscription, message, { vapid, subject, fetchImpl = globalThis.fetch.bind(globalThis), ttl = 86400, urgency = 'normal' }) {
  let json = JSON.stringify(message);
  if (enc.encode(json).length > MAX_PAYLOAD_BYTES) json = JSON.stringify({ ...message, body: String(message.body ?? '').slice(0, 600) });
  const body = await encryptPayload(json, subscription.keys);
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return res.status;
}
