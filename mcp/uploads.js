// Links the connector hands Claude for what is too big to pass through a tool call, each good for
// UPLOAD_MINUTES: a PUT that attaches one file to one item (attach_file), a PUT that imports a
// release board file into one project (import_board), and a GET that gives one project's board as
// its page's data file (export_board). Nothing is stored: the link carries what it may do, for what,
// and when it ends, HMAC-signed with a key derived from MCP_SECRET. With the optional key-value store
// (OAUTH_KV) an upload link works once; a download link works until it ends.
import { fromBase64Url, toBase64Url } from './push.js';

export const UPLOAD_MINUTES = 15;
export const UPLOAD_PATH = '/upload/';
export const DOWNLOAD_PATH = '/download/';
// What a link may do, and where it is served.
const OPS = { attach: UPLOAD_PATH, 'board-import': UPLOAD_PATH, 'board-export': DOWNLOAD_PATH };
const ASK_AGAIN = { attach: 'attach_file', 'board-import': 'import_board', 'board-export': 'export_board' };

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
    /**
     * { url, expiresAt } of a link: `op` 'attach' (the default; `item`, `name`), 'board-import'
     * (`project`) or 'board-export' (`project`, `name` = the script's variable).
     */
    async link(baseUrl, { op = 'attach', item, name, project }) {
      if (!OPS[op]) throw new Error(`Unknown link: ${op}`);
      const exp = now() + UPLOAD_MINUTES * 60_000;
      const claims = { o: op, i: item, n: name, p: project, e: exp, r: toBase64Url(crypto.getRandomValues(new Uint8Array(9))) };
      const body = toBase64Url(enc.encode(JSON.stringify(claims)));
      const sig = toBase64Url(await crypto.subtle.sign('HMAC', await key(), enc.encode(body)));
      return { url: `${baseUrl.replace(/\/+$/, '')}${OPS[op]}${body}.${sig}`, expiresAt: new Date(exp).toISOString() };
    },

    /**
     * { op, item, name, project, spend } of a link's token, when it is one of `ops`; throws an
     * UploadError (401 not ours or not for this, 410 ended or used). `spend()` marks an upload link
     * used, once what it brought is in (a failed upload can be sent again).
     */
    async open(token, ops = ['attach']) {
      const [body, sig, extra] = String(token ?? '').split('.');
      let ok = false;
      if (body && sig && extra === undefined) {
        try {
          ok = await crypto.subtle.verify('HMAC', await key(), fromBase64Url(sig), enc.encode(body));
        } catch {
          ok = false;
        }
      }
      const claims = ok ? JSON.parse(dec.decode(fromBase64Url(body))) : null;
      const op = claims?.o ?? 'attach';
      if (!claims || !ops.includes(op)) throw new UploadError('This link is not valid here. Ask Claude for a new one.', 401);
      const again = `Ask ${ASK_AGAIN[op]} for a new one.`;
      if (!(claims.e > now())) throw new UploadError(`This link has ended (they work for ${UPLOAD_MINUTES} minutes). ${again}`, 410);
      const used = `upload:${sig.slice(0, 32)}`;
      if (store && OPS[op] === UPLOAD_PATH && (await store.get(used))) throw new UploadError(`This upload link was used already. ${again}`, 410);
      return { op, item: claims.i, name: claims.n, project: claims.p, spend: async () => store?.put(used, '1', UPLOAD_MINUTES * 60) };
    },
  };
}
