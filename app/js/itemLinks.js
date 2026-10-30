// Links to tracker items: the web app's (…/#/item/<id>, what Claude and notifications give),
// the desktop app's (tracker-app://item/<id>) and an item's bare id. Pure.

export const WEB_APP_URL = 'https://divaor.github.io/tracking_app/';
export const LINK_SCHEME = 'tracker-app';
// newId() in model.js: Date.now() in base 36, a dash, 16 hex digits.
const ID = '[0-9a-z]{6,11}-[0-9a-f]{16}';
const BARE_ID = new RegExp(`^${ID}$`);

/** The item id `text` names: a link with #/item/<id> (any address), a tracker-app:// link, or just an id. */
export function itemIdIn(text) {
  const s = String(text ?? '').trim();
  const link = new RegExp(`(?:#/item/|^${LINK_SCHEME}://item/)([^/?#&\\s]+)`).exec(s);
  if (link) {
    try {
      return decodeURIComponent(link[1]);
    } catch {
      return null;
    }
  }
  return BARE_ID.test(s) ? s : null;
}

/**
 * The one item whose id holds `text`, a part of an id (what Claude sometimes gives: "27e83a7b",
 * "mvtquqbr", "mvtquqbr-27e8…"): 6 or more of its letters and digits, with a digit or the dash in
 * it, or a whole half of the id. Null when no id holds it, or several do.
 */
export function idFromFragment(text, ids) {
  const s = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[`"'([]+|[`"')\].,;:…]+$/g, '');
  if (!/^[0-9a-z-]{6,28}$/.test(s)) return null;
  const found = [];
  for (const id of ids) if (id.includes(s) && found.push(id) > 1) return null;
  const [id] = found;
  if (!id) return null;
  return /[\d-]/.test(s) || id.split('-').includes(s) ? id : null;
}

/** The web app's link to an item (`base`: the app's address, a folder or its page). */
export function webItemLink(id, base = WEB_APP_URL) {
  const url = new URL(base);
  const path = url.pathname.endsWith('/') || /\.[^/]*$/.test(url.pathname) ? url.pathname : `${url.pathname}/`;
  return `${url.origin}${path}#/item/${encodeURIComponent(id)}`;
}

/** The desktop app's link to an item: it opens there (the app registers the scheme). */
export const appItemLink = (id) => `${LINK_SCHEME}://item/${encodeURIComponent(id)}`;

/** `text` split around the item ids in it: strings, and { id } for each id. */
export function splitItemIds(text) {
  const parts = [];
  const re = new RegExp(`\\b${ID}\\b`, 'g');
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ id: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
