import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { encodeBase64 } from '../github.js';
import {
  attachFiles, blobOf, detachFile, downloadFile, loadFileBytes, loadFileText, MAX_FILE_BYTES, onPendingFiles, openFileOutside, saveFileText, thumbnailOf,
} from '../files.js';
import { renderMarkdown } from '../markdown.js';
import { attachmentKind, fileKind, formatBytes, isTextAttachment, toggleChecklistItem } from '../model.js';
import { store } from '../store.js';
import { Icon } from './icons.js';
import { ListenButton, sourceOf } from './listen.js';
import { EditorLink, Segmented } from './components.js';

const MIME = { markdown: 'text/markdown', html: 'text/html', svg: 'image/svg+xml', text: 'text/plain' };

function download(name, text, kind) {
  const url = URL.createObjectURL(new Blob([text], { type: `${MIME[kind]};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const byteLength = (text) => new TextEncoder().encode(text).length;

function saveError(file, err) {
  if (err?.status === 409 || err?.status === 422) return `“${file.name}” was changed elsewhere (by Claude or another device). Sync, then tick it again.`;
  return `Couldn’t save “${file.name}”: ${err?.message || 'no connection'}`;
}

function FileView({ file, onSaved, onError, onRemove }) {
  const kind = fileKind(file.name);
  const [state, setState] = useState({ status: 'loading' });
  const [mode, setMode] = useState(kind === 'text' ? 'source' : 'preview');
  // Ticked checklists are written back to the file: `saved` is the text and
  // sha last stored in the repo, `wanted` what the reader shows. One save at a
  // time, always of the latest text, so quick ticks coalesce.
  const sync = useRef({ sha: '', saved: null, wanted: null, busy: false });
  const viewRef = useRef(null);

  useEffect(() => {
    const s = sync.current;
    if (file.sha && file.sha === s.sha) return; // our own save; the text is already shown
    let cancelled = false;
    setState({ status: 'loading' });
    loadFileText(file).then(
      (text) => {
        if (cancelled) return;
        Object.assign(s, { sha: file.sha, saved: text, wanted: text });
        setState({ status: 'ready', text });
      },
      (err) => !cancelled && setState({ status: 'error', error: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [file.path, file.sha]);

  const save = async () => {
    const s = sync.current;
    if (s.busy) return;
    s.busy = true;
    try {
      while (s.wanted !== s.saved) {
        const text = s.wanted;
        const sha = await saveFileText({ ...file, sha: s.sha }, text);
        Object.assign(s, { sha, saved: text });
        onSaved(sha, byteLength(text));
      }
    } catch (err) {
      s.wanted = s.saved;
      setState({ status: 'ready', text: s.saved });
      onError(saveError(file, err));
    } finally {
      s.busy = false;
    }
  };

  const onMarkdownClick = (e) => {
    const box = e.target.closest?.('input.md-check');
    if (!box) return;
    e.preventDefault();
    const s = sync.current;
    const text = toggleChecklistItem(s.wanted, [...e.currentTarget.querySelectorAll('input.md-check')].indexOf(box));
    if (text === s.wanted) return;
    s.wanted = text;
    setState({ status: 'ready', text });
    save();
  };

  let body;
  if (state.status === 'loading') body = html`<p class="muted file-message">Loading ${file.name}…</p>`;
  else if (state.status === 'error') body = html`<p class="notice error"><${Icon} name="alert" size=${16} />${state.error}</p>`;
  else if (mode === 'source') body = html`<pre class="file-source"><code>${state.text}</code></pre>`;
  else if (kind === 'markdown') body = html`<div class="markdown file-markdown" onClick=${onMarkdownClick} dangerouslySetInnerHTML=${{ __html: renderMarkdown(state.text) }} />`;
  else if (kind === 'svg') body = html`<div class="file-image"><img alt=${file.name} src=${`data:image/svg+xml;base64,${encodeBase64(state.text)}`} /></div>`;
  // Sandboxed with no permissions: the artifact's scripts, forms and links stay inert.
  else body = html`<iframe class="file-frame" sandbox="" srcdoc=${state.text} title=${file.name} referrerpolicy="no-referrer" />`;

  // Listen: the document as shown (Markdown, or a text file as it is), from where it is scrolled to.
  const readable = state.status === 'ready' && ((mode === 'preview' && kind === 'markdown') || (mode === 'source' && kind === 'text'));
  return html`<div class="file-view" ref=${viewRef}>
    <div class="file-toolbar">
      ${kind !== 'text' &&
      html`<${Segmented} small label="View" value=${mode} onChange=${setMode}
        options=${[{ id: 'preview', label: 'Preview', icon: 'eye' }, { id: 'source', label: 'Source', icon: 'doc' }]} />`}
      ${kind === 'html' && mode === 'preview' && html`<span class="muted small">Scripts are disabled in the preview.</span>`}
      <span class="spacer" />
      ${readable && html`<${ListenButton} readKey=${`file:${file.path}`} name=${file.name} title="Listen to this document, the sentence marked as it goes"
        source=${() => sourceOf(viewRef.current?.querySelector('.file-markdown, .file-source'))} />`}
      <${EditorLink} route=${{ kind: 'repo', path: file.path }} className="btn ghost sm" title="Edit this file in Tracker Editor; your changes come back here">
        <${Icon} name="code" size=${15} />Edit in editor
      </${EditorLink}>
      <button type="button" class="btn ghost sm" disabled=${state.status !== 'ready'} onClick=${() => download(file.name, state.text, kind)}>
        <${Icon} name="download" size=${15} />Download
      </button>
      ${onRemove && html`<button type="button" class="icon-btn sm danger" title="Remove from this item" aria-label=${`Remove ${file.name}`} onClick=${onRemove}><${Icon} name="trash" size=${15} /></button>`}
    </div>
    ${body}
  </div>`;
}

const KIND_ICONS = { image: 'image', pdf: 'pdf', document: 'doc', media: 'media', archive: 'archive', binary: 'doc', text: 'doc' };
const iconOf = (file) => (/\.(xlsx?|ods|csv)$/i.test(file.name) ? 'sheet' : KIND_ICONS[attachmentKind(file)]);
// Opened as they look by Tracker Editor (0.34 and later).
const editorShows = (file) => ['pdf', 'document'].includes(attachmentKind(file));
const touchScreen = () => matchMedia('(pointer: coarse)').matches;

/** The files waiting to upload from this device (a Set of paths), kept current. */
function usePendingFiles() {
  const [paths, setPaths] = useState(() => new Set());
  useEffect(() => onPendingFiles(setPaths), []);
  return paths;
}

/** Attaches files to an item and says how it went (too large, photos made smaller with Keep full size). */
export async function attachTo(item, files, actions) {
  const list = [...files];
  if (!list.length) return;
  let result;
  try {
    result = await attachFiles(item.id, list);
  } catch (err) {
    actions.toast(`Could not attach: ${err?.message ?? err}`, { kind: 'error' });
    return;
  }
  const { added, skipped, shrunk } = result;
  for (const s of skipped) actions.toast(`${s.name} was not attached: ${s.reason} (the most is ${MAX_FILE_BYTES / 1024 / 1024} MB).`, { kind: 'error', timeout: 8000 });
  if (shrunk.length) {
    const sizes = shrunk.length === 1 ? ` (${formatBytes(shrunk[0].from)} → ${formatBytes(shrunk[0].to)})` : '';
    actions.toast(`${shrunk.length === 1 ? 'A photo was' : `${shrunk.length} photos were`} made smaller to save space${sizes}.`, {
      timeout: 10000,
      action: {
        label: 'Keep full size',
        run: async () => {
          for (const s of shrunk) detachFile(item.id, s.path);
          await attachFiles(item.id, shrunk.map((s) => s.file), { fullSize: true });
        },
      },
    });
  } else if (added.length) actions.toast(added.length === 1 ? `Attached ${added[0].name}` : `Attached ${added.length} files`);
}

/** A picture's small version, drawn when it comes near the screen. */
function Thumb({ file, pending, onOpen }) {
  const ref = useRef(null);
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    let made = null;
    const load = () =>
      thumbnailOf(file).then(
        (blob) => {
          if (!alive || !blob) return;
          made = URL.createObjectURL(blob);
          setUrl(made);
        },
        () => {},
      );
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (seen.disconnect(), load()), { rootMargin: '200px' });
    seen.observe(ref.current);
    return () => {
      alive = false;
      seen.disconnect();
      if (made) URL.revokeObjectURL(made);
    };
  }, [file.path, file.sha]);
  return html`<button type="button" ref=${ref} class="file-thumb ${url ? 'ready' : ''}" title=${`${file.name} · ${formatBytes(file.size)}`} onClick=${onOpen}>
    ${url ? html`<img src=${url} alt=${file.name} />` : html`<span class="file-thumb-icon"><${Icon} name="image" size=${22} /></span>`}
    ${pending && html`<span class="file-pending" title="Waiting to upload from this device"><${Icon} name="upload" size=${12} /></span>`}
  </button>`;
}

/** Pictures one at a time over the window: ← → between them, a click to see it at full size, Esc to close. */
function PictureViewer({ files, index, onIndex, onClose, item, actions }) {
  const file = files[index];
  const [state, setState] = useState({ status: 'loading' });
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!file) return undefined;
    let alive = true;
    let made = null;
    setState({ status: 'loading' });
    setZoom(false);
    loadFileBytes(file).then(
      (bytes) => {
        if (!alive) return;
        made = URL.createObjectURL(blobOf(file, bytes));
        setState({ status: 'ready', url: made });
      },
      (err) => alive && setState({ status: 'error', error: err.message }),
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file?.path, file?.sha]);
  const go = (step) => onIndex((index + step + files.length) % files.length);
  // Its keys before the item's (Esc closes the picture, not the item).
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && files.length > 1) go(-1);
      else if (e.key === 'ArrowRight' && files.length > 1) go(1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  if (!file) return null;
  const remove = () => {
    const undo = detachFile(item.id, file.path);
    actions.toast(`Removed ${file.name}`, { action: undo && { label: 'Undo', run: undo } });
    if (files.length === 1) onClose();
    else onIndex(Math.min(index, files.length - 2));
  };
  const fail = (err) => actions.toast(`Could not open ${file.name}: ${err?.message ?? err}`, { kind: 'error' });
  return html`<div class="picture-viewer" role="dialog" aria-modal="true" aria-label=${file.name} onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="picture-bar">
      <span class="picture-name" title=${file.path}>${file.name}</span>
      <span class="muted small">${formatBytes(file.size)}${files.length > 1 ? ` · ${index + 1} of ${files.length}` : ''}</span>
      <span class="spacer" />
      <button type="button" class="icon-btn ${zoom ? 'on' : ''}" title=${zoom ? 'Fit to the window' : 'Full size'} aria-label="Zoom" aria-pressed=${zoom} onClick=${() => setZoom(!zoom)}><${Icon} name="zoom" /></button>
      <button type="button" class="icon-btn" title="Download" aria-label="Download" onClick=${() => downloadFile(file).catch(fail)}><${Icon} name="download" /></button>
      ${window.desktop?.openFile && html`<button type="button" class="icon-btn" title="Open with its program" aria-label="Open with its program" onClick=${() => openFileOutside(file).catch(fail)}><${Icon} name="external" /></button>`}
      <button type="button" class="icon-btn danger" title="Remove from this item" aria-label="Remove" onClick=${remove}><${Icon} name="trash" /></button>
      <button type="button" class="icon-btn" title="Close (Esc)" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
    </div>
    <div class="picture-stage ${zoom ? 'zoomed' : ''}" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
      ${state.status === 'ready' && html`<img src=${state.url} alt=${file.name} onClick=${() => setZoom(!zoom)} />`}
      ${state.status === 'loading' && html`<p class="muted">Loading ${file.name}…</p>`}
      ${state.status === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${16} /><span>${state.error}</span></p>`}
    </div>
    ${files.length > 1 &&
    html`<button type="button" class="picture-nav prev" aria-label="Previous picture" onClick=${() => go(-1)}><${Icon} name="chevronLeft" size=${26} /></button>
      <button type="button" class="picture-nav next" aria-label="Next picture" onClick=${() => go(1)}><${Icon} name="chevronRight" size=${26} /></button>`}
  </div>`;
}

/**
 * An item's files: pictures as small versions (a click shows them large), other files as chips
 * (text reads here, documents open with their program or in the editor), 📎 to attach more.
 */
export function FilesPanel({ item, actions }) {
  const pending = usePendingFiles();
  const pictures = item.files.filter((f) => attachmentKind(f) === 'image');
  const others = item.files.filter((f) => attachmentKind(f) !== 'image');
  const [open, setOpen] = useState(() => others.find(isTextAttachment)?.path ?? null);
  const [viewing, setViewing] = useState(null);
  const pickRef = useRef(null);
  const cameraRef = useRef(null);
  const current = others.find((f) => f.path === open);
  // Records a file's new version on the item, so other devices load it too.
  const onSaved = (path, sha, size) => {
    const latest = store.get(item.id);
    if (latest) store.update(item.id, { files: latest.files.map((f) => (f.path === path ? { ...f, sha, size } : f)) });
  };
  const fail = (file) => (err) => actions.toast(`Could not open ${file.name}: ${err?.message ?? err}`, { kind: 'error' });
  const remove = (file) => {
    const undo = detachFile(item.id, file.path);
    if (open === file.path) setOpen(null);
    actions.toast(`Removed ${file.name}`, { action: undo && { label: 'Undo', run: undo } });
  };
  const outside = (file) =>
    openFileOutside(file).then((how) => how === 'downloaded' && actions.toast(`${file.name} was downloaded: open it from your downloads.`), fail(file));
  const onPicked = (e) => {
    attachTo(item, e.currentTarget.files, actions);
    e.currentTarget.value = '';
  };
  return html`<section class="files-panel ${item.files.length ? '' : 'empty'}">
    <div class="files-head">
      <h3><${Icon} name="paperclip" size=${16} />Files${item.files.length > 0 && html` <span class="muted small">${item.files.length}</span>`}</h3>
      ${!item.files.length && html`<span class="muted small files-hint">Drop files here or paste a picture</span>`}
      <span class="spacer" />
      ${touchScreen() &&
      html`<button type="button" class="btn ghost sm" onClick=${() => cameraRef.current?.click()}><${Icon} name="camera" size=${15} />Photo</button>
        <input ref=${cameraRef} type="file" hidden accept="image/*" capture="environment" onChange=${onPicked} />`}
      <button type="button" class="btn ghost sm" title="Attach files: pictures, PDFs, documents… (or drop them on the item, or paste a picture)" onClick=${() => pickRef.current?.click()}>
        <${Icon} name="paperclip" size=${15} />Attach
      </button>
      <input ref=${pickRef} type="file" hidden multiple onChange=${onPicked} />
    </div>
    ${pictures.length > 0 &&
    html`<div class="file-pictures">
      ${pictures.map((f, i) => html`<${Thumb} key=${f.path} file=${f} pending=${pending.has(f.path)} onOpen=${() => setViewing(i)} />`)}
    </div>`}
    ${others.length > 0 &&
    html`<div class="file-list" role="list">
      ${others.map((f) => {
        const text = isTextAttachment(f);
        return html`<div role="listitem" key=${f.path} class="file-chip ${f.path === open ? 'active' : ''} kind-${attachmentKind(f)}">
          <button type="button" class="file-chip-main" title=${text ? `${f.name}: read it here` : `${f.name}: open it with its program`}
            aria-expanded=${text ? f.path === open : undefined} onClick=${() => (text ? setOpen(f.path === open ? null : f.path) : outside(f))}>
            <${Icon} name=${iconOf(f)} size=${15} /><span>${f.name}</span><small>${formatBytes(f.size)}</small>
            ${pending.has(f.path) && html`<span class="file-pending" title="Waiting to upload from this device"><${Icon} name="upload" size=${12} /></span>`}
          </button>
          ${!text &&
          html`${editorShows(f) &&
            html`<${EditorLink} route=${{ kind: 'repo', path: f.path }} className="icon-btn sm" title="Open in Tracker Editor (as it looks)"><${Icon} name="code" size=${14} /></${EditorLink}>`}
            <button type="button" class="icon-btn sm" title="Download" aria-label=${`Download ${f.name}`} onClick=${() => downloadFile(f).catch(fail(f))}><${Icon} name="download" size=${14} /></button>
            <button type="button" class="icon-btn sm danger" title="Remove from this item" aria-label=${`Remove ${f.name}`} onClick=${() => remove(f)}><${Icon} name="trash" size=${14} /></button>`}
        </div>`;
      })}
    </div>`}
    ${current &&
    html`<${FileView} key=${current.path} file=${current} onRemove=${() => remove(current)}
      onSaved=${(sha, size) => onSaved(current.path, sha, size)} onError=${(message) => actions.toast(message, { kind: 'error' })} />`}
    ${viewing !== null &&
    html`<${PictureViewer} files=${pictures} index=${Math.min(viewing, pictures.length - 1)} onIndex=${setViewing} onClose=${() => setViewing(null)} item=${item} actions=${actions} />`}
  </section>`;
}

const hasFiles = (dt) => [...(dt?.types ?? [])].includes('Files');

/**
 * Drop and paste for an item: files dropped on it, and pictures pasted (not text into a field), are
 * attached. Spread the returned props on the item's root; `dropping` says whether files are over it.
 */
export function useFileDrop(item, actions) {
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);
  if (!item) return { dropping: false, props: {} };
  return {
    dropping,
    props: {
      onDragEnter: (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        depth.current++;
        setDropping(true);
      },
      onDragOver: (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        if (--depth.current <= 0) {
          depth.current = 0;
          setDropping(false);
        }
      },
      onDrop: (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        depth.current = 0;
        setDropping(false);
        attachTo(item, e.dataTransfer.files, actions);
      },
      onPaste: (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length) return;
        // Text pasted into a field stays text; a picture (or a file) is attached.
        const field = e.target.closest?.('input, textarea, [contenteditable="true"]');
        if (field && e.clipboardData.types.includes('text/plain')) return;
        e.preventDefault();
        attachTo(item, files, actions);
      },
    },
  };
}
