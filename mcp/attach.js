// Getting a file's bytes for attach_file: downloaded from a public https address, or given
// as base64. (Upload links, for a shell's curl, are in uploads.js.)
import { base64ToBytes } from '../app/js/github.js';
import { mimeOf } from '../app/js/model.js';

// Smaller than the app's 25 MB (files.js MAX_FILE_BYTES): GitHub takes the file as base64 in JSON,
// so a Worker (128 MB of memory) holds it about five times over while it writes it.
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const DOWNLOAD_MS = 30_000;

export class AttachError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const tooBig = (size) => new AttachError(`The file is ${size ? `${(size / 1024 / 1024).toFixed(1)} MB` : 'over the limit'}; the limit is ${MAX_ATTACH_BYTES / 1024 / 1024} MB.`, 413);

// This computer, private networks, link-local addresses (cloud metadata) and any IPv6 literal.
// URL parsing has already turned other ways of writing an IPv4 address (2130706433, 0x7f.1) into dotted form.
const PRIVATE_HOST =
  /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.home\.arpa|0\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[.*\])$/i;

/** The address to download, if it is one the connector may fetch: https, a public host, no credentials. */
export function checkDownloadUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new AttachError('source_url is not a valid address.');
  }
  if (url.protocol !== 'https:') throw new AttachError('source_url must be an https address.');
  if (url.username || url.password) throw new AttachError('source_url must not carry a user name or password.');
  if (PRIVATE_HOST.test(url.hostname) || !url.hostname.includes('.')) throw new AttachError('source_url must be a public address (not this computer or a private network).');
  return url;
}

/** The body's bytes, refusing more than `max`. */
async function readCapped(response, max) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw tooBig(bytes.length);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw tooBig(0);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

// "report.pdf" from Content-Disposition (filename*= first), else the address's last part.
function nameFrom(response, url) {
  const disposition = response.headers.get('content-disposition') ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition)?.[1];
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  for (const raw of [star, plain, last]) {
    if (!raw) continue;
    try {
      const name = decodeURIComponent(raw.trim());
      if (name) return name;
    } catch {
      // a malformed escape: try the next one
    }
  }
  return '';
}

/**
 * Downloads `source` (redirects followed, each checked like the first): { bytes, type, name }.
 * No credentials are ever sent with it.
 */
export async function download(source, fetchImpl) {
  let url = checkDownloadUrl(source);
  for (let hop = 0; ; hop++) {
    let response;
    try {
      response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(DOWNLOAD_MS), headers: { Accept: '*/*', 'User-Agent': 'tracker-mcp' } });
    } catch (err) {
      throw new AttachError(`Could not download ${url.host}: ${err?.name === 'TimeoutError' ? 'it took too long' : (err?.message ?? err)}.`, 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop >= MAX_REDIRECTS) throw new AttachError('source_url redirects too many times.', 502);
      url = checkDownloadUrl(new URL(response.headers.get('location') ?? '', url).href);
      continue;
    }
    if (!response.ok) throw new AttachError(`Downloading source_url failed: HTTP ${response.status}${response.status === 404 ? ' (not found, or not public)' : ''}.`, 502);
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_ATTACH_BYTES) throw tooBig(length);
    const bytes = await readCapped(response, MAX_ATTACH_BYTES);
    return { bytes, type: cleanType(response.headers.get('content-type')), name: nameFrom(response, url) };
  }
}

const cleanType = (value) => {
  const type = String(value ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : '';
};

/** Bytes from base64 (standard or URL-safe; a data: URL's prefix gives the type): { bytes, type }. */
export function decodeBase64(value) {
  const text = String(value ?? '');
  const data = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(text);
  const clean = text.slice(data ? data[0].length : 0).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new AttachError('content_base64 is not base64.');
  if ((clean.length * 3) / 4 > MAX_ATTACH_BYTES + 3) throw tooBig(Math.floor((clean.length * 3) / 4));
  return { bytes: base64ToBytes(clean.padEnd(Math.ceil(clean.length / 4) * 4, '=')), type: cleanType(data?.[1]) };
}

const EXTENSION_OF_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html', 'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
};

/** `name` with an extension: its own, else one for `type` (a picture downloaded as "photo" becomes photo.jpg). */
export function withExtension(name, type) {
  const base = String(name ?? '').trim();
  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base;
  const ext = EXTENSION_OF_TYPE[type];
  return base && ext ? `${base}.${ext}` : base;
}

/** The MIME type to record: by the name's extension when known, else the one the bytes came with. */
export function typeFor(name, given = '') {
  const byName = mimeOf({ name });
  return byName === 'application/octet-stream' && cleanType(given) ? cleanType(given) : byName;
}

/** Whether bytes read as UTF-8 text (a name that says text but bytes that are not get `binary`). */
export function looksLikeText(bytes) {
  const head = bytes.subarray(0, 65536);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}
