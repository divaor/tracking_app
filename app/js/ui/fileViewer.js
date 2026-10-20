import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { encodeBase64 } from '../github.js';
import { loadFileText, saveFileText } from '../files.js';
import { renderMarkdown } from '../markdown.js';
import { fileKind, formatBytes, toggleChecklistItem } from '../model.js';
import { store } from '../store.js';
import { Icon } from './icons.js';
import { Segmented } from './components.js';

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

function FileView({ file, onSaved, onError }) {
  const kind = fileKind(file.name);
  const [state, setState] = useState({ status: 'loading' });
  const [mode, setMode] = useState(kind === 'text' ? 'source' : 'preview');
  // Ticked checklists are written back to the file: `saved` is the text and
  // sha last stored in the repo, `wanted` what the reader shows. One save at a
  // time, always of the latest text, so quick ticks coalesce.
  const sync = useRef({ sha: '', saved: null, wanted: null, busy: false });

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

  return html`<div class="file-view">
    <div class="file-toolbar">
      ${kind !== 'text' &&
      html`<${Segmented} small label="View" value=${mode} onChange=${setMode}
        options=${[{ id: 'preview', label: 'Preview', icon: 'eye' }, { id: 'source', label: 'Source', icon: 'doc' }]} />`}
      ${kind === 'html' && mode === 'preview' && html`<span class="muted small">Scripts are disabled in the preview.</span>`}
      <span class="spacer" />
      <button type="button" class="btn ghost sm" disabled=${state.status !== 'ready'} onClick=${() => download(file.name, state.text, kind)}>
        <${Icon} name="download" size=${15} />Download
      </button>
    </div>
    ${body}
  </div>`;
}

export function FilesPanel({ item, actions }) {
  const [open, setOpen] = useState(() => item.files[0]?.path ?? null);
  const current = item.files.find((f) => f.path === open);
  // Records a file's new version on the item, so other devices load it too.
  const onSaved = (path, sha, size) => {
    const latest = store.get(item.id);
    if (latest) store.update(item.id, { files: latest.files.map((f) => (f.path === path ? { ...f, sha, size } : f)) });
  };
  return html`<section class="files-panel">
    <h3><${Icon} name="paperclip" size=${16} />Files</h3>
    <div class="file-list" role="tablist">
      ${item.files.map(
        (f) => html`<button type="button" role="tab" key=${f.path} aria-selected=${f.path === open} class="file-chip ${f.path === open ? 'active' : ''}"
          title=${f.path} onClick=${() => setOpen(f.path === open ? null : f.path)}>
          <${Icon} name="doc" size=${15} /><span>${f.name}</span><small>${formatBytes(f.size)}</small>
        </button>`,
      )}
    </div>
    ${current && html`<${FileView} key=${current.path} file=${current}
      onSaved=${(sha, size) => onSaved(current.path, sha, size)} onError=${(message) => actions.toast(message, { kind: 'error' })} />`}
  </section>`;
}
