// Upload links for attach_file: an address, good for UPLOAD_MINUTES, that takes one file's bytes
// in a PUT (curl -T) and attaches them to one item under one name. Nothing is stored: the link
// carries the item, the name and when it ends, HMAC-signed with a key derived from MCP_SECRET.
// With the optional key-value store (OAUTH_KV) a link works once.
import { fromBase64Url, toBase64Url } from './push.js';

export const UPLOAD_MINUTES = 15;
export const UPLOAD_PATH = '/upload/';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class UploadError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createUploads({ secret, store = null, now = Date.now }) {
  let keyPromise = null;
  const key = () =>
    (keyPromise ??= (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const derived = await crypto.subtle.sign('HMAC', base, enc.encode('tracker-upload-v1'));
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })());

  return {
    /** { url, expiresAt } of a link that attaches a file named `name` to the item `item` (its id). */
    async link(baseUrl, { item, name }) {
      const exp = now() + UPLOAD_MINUTES * 60_000;
      const body = toBase64Url(enc.encode(JSON.stringify({ i: item, n: name, e: exp, r: toBase64Url(crypto.getRandomValues(new Uint8Array(9))) })));
      const sig = toBase64Url(await crypto.subtle.sign('HMAC', await key(), enc.encode(body)));
      return { url: `${baseUrl.replace(/\/+$/, '')}${UPLOAD_PATH}${body}.${sig}`, expiresAt: new Date(exp).toISOString() };
    },

    /**
     * { item, name, spend } of a link's token; throws an UploadError (401 not ours, 410 ended or used).
     * `spend()` marks it used, once the file is attached (a failed upload can be sent again).
     */
    async open(token) {
      const [body, sig, extra] = String(token ?? '').split('.');
      let ok = false;
      if (body && sig && extra === undefined) {
        try {
          ok = await crypto.subtle.verify('HMAC', await key(), fromBase64Url(sig), enc.encode(body));
        } catch {
          ok = false;
        }
      }
      if (!ok) throw new UploadError('This upload link is not valid. Ask attach_file for a new one.', 401);
      const claims = JSON.parse(dec.decode(fromBase64Url(body)));
      if (!(claims.e > now())) throw new UploadError(`This upload link has ended (they work for ${UPLOAD_MINUTES} minutes). Ask attach_file for a new one.`, 410);
      const used = `upload:${sig.slice(0, 32)}`;
      if (store && (await store.get(used))) throw new UploadError('This upload link was used already. Ask attach_file for a new one.', 410);
      return { item: claims.i, name: claims.n, spend: async () => store?.put(used, '1', UPLOAD_MINUTES * 60) };
    },
  };
}
