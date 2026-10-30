// Files shared with the Android app (Share → Tracker): a new item with them, or on an item
// already there (found by search, the most recently changed first). Text shared opens as a new
// item to review instead (sharedItems.js sharedDraft, in app.js).
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { formatBytes, matchesQuery, sortItems } from '../model.js';
import { sharedFilesTitle } from '../sharedItems.js';
import { attachTo } from './fileViewer.js';
import { Icon } from './icons.js';

export function SharedFilesDialog({ files, items, actions, onClose }) {
  const [title, setTitle] = useState(() => sharedFilesTitle(files));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef(null);
  const pictures = useMemo(() => files.map((f) => (/^image\//.test(f.type) ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => pictures.forEach((url) => url && URL.revokeObjectURL(url)), [pictures]);
  // Escape (and Back, which sends it) closes it.
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const found = useMemo(() => {
    const live = items.filter((i) => !i.deleted);
    const q = query.trim();
    return (q ? sortItems(live.filter((i) => matchesQuery(i, q)), 'updated') : sortItems(live, 'updated')).slice(0, 8);
  }, [items, query]);
  const finish = async (item) => {
    setBusy(true);
    await attachTo(item, files, actions);
    onClose();
    actions.open(item);
  };
  const asNew = () => finish(actions.create({ type: 'task', title: title.trim() || sharedFilesTitle(files) || 'Shared files' }));
  const many = files.length > 1;
  return html`<div class="modal-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal shared-dialog" role="dialog" aria-modal="true" aria-labelledby="shared-title" tabindex="-1" ref=${dialog}>
      <header class="modal-head">
        <h2 class="modal-heading" id="shared-title">${many ? `${files.length} files shared` : 'A file shared'}</h2>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Close (Esc)" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
      </header>
      <div class="modal-body">
        <ul class="shared-files">
          ${files.map(
            (f, i) => html`<li key=${i}>
              ${pictures[i] ? html`<img src=${pictures[i]} alt="" />` : html`<span class="shared-file-icon"><${Icon} name="paperclip" size=${18} /></span>`}
              <span class="shared-file-name">${f.name}</span><small class="muted">${formatBytes(f.size)}</small>
            </li>`,
          )}
        </ul>
        <section class="shared-new">
          <h3>A new item</h3>
          <div class="input-row">
            <input value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} aria-label="Title of the new item" placeholder="Title" />
            <button type="button" class="btn primary" disabled=${busy} onClick=${asNew}><${Icon} name="plus" size=${16} />Add</button>
          </div>
        </section>
        <section class="shared-existing">
          <h3>Or on an item</h3>
          <input type="search" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Find an item" aria-label="Find an item" />
          <div class="shared-items" role="list">
            ${found.map(
              (item) => html`<button type="button" role="listitem" key=${item.id} class="shared-item" disabled=${busy} onClick=${() => finish(item)}>
                <span class="shared-item-title">${item.title}</span>${item.project && html`<small class="muted">${item.project}</small>`}
              </button>`,
            )}
            ${!found.length && html`<p class="muted small">${query.trim() ? 'No item matches.' : 'No items yet.'}</p>`}
          </div>
        </section>
      </div>
    </div>
  </div>`;
}
