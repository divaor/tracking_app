// Links into Tracker Editor, the companion text editor that keeps its files in
// the same data repository. It opens "#/file/<id>" (one of its files) and
// "#/repo/<path>" (any text file in the repo, such as an item's attachment);
// its desktop app registers the same routes as tracker-editor://.
// Pure, so the Node tests can import it.

export const DEFAULT_EDITOR_URL = 'https://divaor.github.io/tracker-editor/';
export const EDITOR_SCHEME = 'tracker-editor';

const withSlash = (url) => url.trim().replace(/[?#].*$/, '').replace(/\/?$/, '/');
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

function parseRoute(route) {
  const match = /^(file|repo)\/(.+)$/.exec(route);
  if (!match) return null;
  try {
    if (match[1] === 'file') return { kind: 'file', id: decodeURIComponent(match[2]) };
    return { kind: 'repo', path: match[2].split('/').map(decodeURIComponent).join('/') };
  } catch {
    return null;
  }
}

/**
 * The editor route a link points to, or null when it is not an editor link.
 * Accepts the configured editor address, the default one and tracker-editor://.
 */
export function parseEditorLink(url, editorUrl = '') {
  let link;
  try {
    link = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (link.protocol === `${EDITOR_SCHEME}:`) return parseRoute(`${link.host}${link.pathname}`.replace(/^\/+/, ''));
  const page = withSlash(`${link.origin}${link.pathname}`);
  const known = [editorUrl, DEFAULT_EDITOR_URL].filter(Boolean).map(withSlash);
  if (!known.includes(page)) return null;
  return parseRoute(link.hash.replace(/^#\/?/, ''));
}

/** The link that opens a route in the editor: its web address, or tracker-editor:// for the desktop app. */
export function editorLink(route, { editorUrl = '', desktop = false } = {}) {
  const path = route.kind === 'file' ? `file/${encodeURIComponent(route.id)}` : `repo/${encodePath(route.path)}`;
  return desktop ? `${EDITOR_SCHEME}://${path}` : `${withSlash(editorUrl || DEFAULT_EDITOR_URL)}#/${path}`;
}
