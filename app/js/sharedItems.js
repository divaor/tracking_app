// What is shared with the Android app (Share → Tracker, "Add to Tracker" on selected text), as
// an item to review before it is added. Pure, so the Node tests can import it.

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/i;
const MAX_TITLE = 120;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

// A link's address, shortened for a title: its host and path, without "www." or a last "/".
function linkTitle(url) {
  try {
    const u = new URL(url);
    return clip(`${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`, MAX_TITLE);
  } catch {
    return clip(url, MAX_TITLE);
  }
}

/**
 * A new item's fields from shared text ({ title, text }: the app's subject, if any, and the
 * text): the title from the subject or the first line, the first link as its link, and the
 * rest as notes (a lone link leaves no notes).
 */
export function sharedDraft({ title = '', text = '' } = {}) {
  const body = String(text ?? '').trim();
  const subject = String(title ?? '').trim();
  const url = URL_RE.exec(body)?.[0] ?? '';
  const onlyLink = Boolean(url) && body === url;
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  let name = subject;
  if (!name) name = onlyLink || first === url ? linkTitle(url) : clip(first.replace(URL_RE, '').replace(/\s+/g, ' ').trim() || first, MAX_TITLE);
  // The notes: what the title does not already say (all of it when the first line was cut).
  let notes = '';
  if (!onlyLink) {
    const rest = subject ? body : first.length > MAX_TITLE ? body : lines.slice(1).join('\n');
    notes = rest.trim() === url ? '' : rest.trim();
  }
  return { title: name, url, notes };
}

/** A title for a new item made from shared files: the file's name (no extension), or how many there are. */
export function sharedFilesTitle(files) {
  if (!files.length) return '';
  const pictures = files.every((f) => /^image\//.test(f.type ?? ''));
  if (files.length > 1) return `${files.length} ${pictures ? 'pictures' : 'files'}`;
  const name = String(files[0].name ?? '').replace(/\.[^.]+$/, '');
  // Camera names (IMG_20261030_140512, PXL_…, Screenshot_…) say nothing: "Photo" / "Screenshot".
  if (/^(img|pxl|dsc|photo)[-_ ]?\d/i.test(name)) return 'Photo';
  if (/^screenshot/i.test(name)) return 'Screenshot';
  return clip(name || 'Shared file', MAX_TITLE);
}
