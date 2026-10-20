import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { encodeBase64 } from '../github.js';
import { loadFileText } from '../files.js';
import { renderMarkdown } from '../markdown.js';
import { fileKind, formatBytes } from '../model.js';
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

function FileView({ file }) {
  const kind = fileKind(file.name);
  const [state, setState] = useState({ status: 'loading' });
  const [mode, setMode] = useState(kind === 'text' ? 'source' : 'preview');

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadFileText(file).then(
      (text) => !cancelled && setState({ status: 'ready', text }),
      (err) => !cancelled && setState({ status: 'error', error: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [file.path, file.sha]);

  let body;
  if (state.status === 'loading') body = html`<p class="muted file-message">Loading ${file.name}…</p>`;
  else if (state.status === 'error') body = html`<p class="notice error"><${Icon} name="alert" size=${16} />${state.error}</p>`;
  else if (mode === 'source') body = html`<pre class="file-source"><code>${state.text}</code></pre>`;
  else if (kind === 'markdown') body = html`<div class="markdown file-markdown" dangerouslySetInnerHTML=${{ __html: renderMarkdown(state.text) }} />`;
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

export function FilesPanel({ item }) {
  const [open, setOpen] = useState(() => item.files[0]?.path ?? null);
  const current = item.files.find((f) => f.path === open);
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
    ${current && html`<${FileView} key=${`${current.path}@${current.sha}`} file=${current} />`}
  </section>`;
}
