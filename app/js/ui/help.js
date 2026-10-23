import { isLocal } from '../settings.js';
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { findCommands, groupsOf, keysFor } from '../commands.js';
import { renderMarkdown } from '../markdown.js';
import { Segmented } from './components.js';
import { Icon } from './icons.js';

const TABS = [
  { id: 'commands', label: 'Commands and shortcuts' },
  { id: 'guide', label: 'Guide' },
];
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

/** A shortcut as keys: "Ctrl+Shift+S · F1" → <kbd>Ctrl</kbd>+<kbd>Shift</kbd>… */
const Keys = ({ keys }) =>
  keys &&
  html`<span class="help-keys">${keys.split(' · ').map(
    (combo, i) => html`${i > 0 && html`<span class="muted"> or </span>`}${combo.split('+').map((k, j) => html`${j > 0 && '+'}<kbd>${k}</kbd>`)}`,
  )}</span>`;

/** What to press, type or do for a command. */
const How = ({ command, mac, desktop }) => {
  const keys = keysFor(command, { mac, desktop });
  if (keys) return html`<${Keys} keys=${keys} />`;
  if (command.code) return html`<span class="help-keys">${command.code.split(' · ').map((c, i) => html`${i > 0 && ' '}<code>${c}</code>`)}</span>`;
  if (command.how) return html`<span class="help-keys muted">${command.how}</span>`;
  return null;
};

function SearchField({ value, onInput, placeholder, inputRef, onKeyDown }) {
  return html`<div class="help-search">
    <${Icon} name="search" size=${16} />
    <input ref=${inputRef} type="search" value=${value} onInput=${(e) => onInput(e.currentTarget.value)} placeholder=${placeholder} aria-label=${placeholder}
      autocomplete="off" onKeyDown=${onKeyDown} />
    ${value &&
    html`<button type="button" class="icon-btn sm" aria-label="Clear the search" onClick=${(e) => {
      onInput('');
      e.currentTarget.parentElement.querySelector('input')?.focus();
    }}><${Icon} name="x" size=${15} /></button>`}
  </div>`;
}

/** The cheat sheet: every command and what runs it, searchable; a click runs the command. */
function CommandsTab({ query, setQuery, onRun }) {
  const mac = isMac();
  const desktop = Boolean(window.desktop);
  const input = useRef(null);
  const list = useRef(null);
  useLayoutEffect(() => input.current?.focus(), []);
  const found = findCommands(query, { desktop, mac, local: isLocal() });
  const runnable = onRun ? found.filter((c) => c.run !== false) : [];
  const move = (e, step) => {
    const buttons = [...(list.current?.querySelectorAll('button.help-command') ?? [])];
    const at = buttons.indexOf(document.activeElement);
    const next = buttons[at + step] ?? (step > 0 && at < 0 ? buttons[0] : null);
    if (next) e.preventDefault(), next.focus();
    else if (step < 0) e.preventDefault(), input.current?.focus();
  };
  return html`<div class="help-commands">
    <div class="help-tools">
      <${SearchField} inputRef=${input} value=${query} onInput=${setQuery} placeholder="Find a command or a key"
        onKeyDown=${(e) => {
          if (e.key === 'ArrowDown') move(e, 1);
          if (e.key === 'Enter' && runnable[0]) e.preventDefault(), onRun(runnable[0]);
        }} />
      <button type="button" class="btn sm" title="Print the cheat sheet, or save it as a PDF" onClick=${() => {
        document.body.classList.add('printing-help');
        setTimeout(() => (window.print(), document.body.classList.remove('printing-help')), 50);
      }}><${Icon} name="download" size=${15} />Print</button>
    </div>
    ${!onRun && html`<p class="muted small help-note">Close the item to run commands from here.</p>`}
    <div class="help-list" ref=${list} onKeyDown=${(e) => (e.key === 'ArrowDown' ? move(e, 1) : e.key === 'ArrowUp' ? move(e, -1) : null)}>
      ${groupsOf(found, Boolean(query.trim())).map((group) => {
        const rows = found.filter((c) => c.group === group);
        if (!rows.length) return null;
        return html`<section class="help-group" key=${group}>
          <h3>${group}</h3>
          ${rows.map((c) =>
            c.run === false || !onRun
              ? html`<div class="help-command static" key=${c.id} title=${c.hint}><span class="help-label">${c.label}</span><${How} command=${c} mac=${mac} desktop=${desktop} /></div>`
              : html`<button type="button" class="help-command" key=${c.id} title=${c.hint ?? 'Run it'} onClick=${() => onRun(c)}>
                  <span class="help-label">${c.label}</span><${How} command=${c} mac=${mac} desktop=${desktop} />
                </button>`,
          )}
        </section>`;
      })}
      ${!found.length && html`<p class="muted">No command matches. Try other words, or the Guide.</p>`}
    </div>
  </div>`;
}

/** The guide (help/guide.md, the same text as the guide on the tracker), by section, searchable. */
function GuideTab() {
  const [text, setText] = useState(null);
  const [query, setQuery] = useState('');
  const body = useRef(null);
  useEffect(() => {
    fetch('help/guide.md')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      .then(setText, () => setText(''));
  }, []);
  const sections = useMemo(() => (text ?? '').split(/\n(?=## )/), [text]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? sections.filter((s, i) => i > 0 && words.every((w) => s.toLowerCase().includes(w))) : sections;
  const titles = sections.slice(1).map((s) => /^## (.+)/.exec(s)?.[1] ?? '');
  const content = useMemo(() => (shown.length ? renderMarkdown(shown.join('\n')) : ''), [text, query]);
  if (text === null) return html`<p class="muted">Loading the guide…</p>`;
  if (!text) return html`<p class="muted">The guide could not be loaded. It is also in the app's repository, in app/help/guide.md.</p>`;
  return html`<div class="help-guide">
    <nav class="help-toc" aria-label="Sections">
      <${SearchField} value=${query} onInput=${setQuery} placeholder="Find in the guide" />
      ${titles.map(
        (t) => html`<button type="button" class="help-toc-item" key=${t}
          onClick=${() => {
            setQuery('');
            setTimeout(() => [...(body.current?.querySelectorAll('h2') ?? [])].find((h) => h.textContent.trim() === t.trim())?.scrollIntoView({ block: 'start' }), 0);
          }}>${t}</button>`,
      )}
    </nav>
    <div class="help-guide-body markdown" ref=${body}>
      ${content ? html`<div dangerouslySetInnerHTML=${{ __html: content }} />` : html`<p class="muted">Nothing in the guide matches.</p>`}
    </div>
  </div>`;
}

/**
 * Help (F1 or ?): the cheat sheet of commands and shortcuts, and the guide. `onRun` is
 * left out while an item is open (its edits are not the help's to drop). Keys pressed
 * in here stay here, so the item behind it does not react to them, and Esc is Help's
 * from the moment it opens (a layout effect: it wins against a quick F1 then Esc).
 */
export function HelpDialog({ tab, query: initialQuery = '', onTab, onRun, onClose }) {
  const [query, setQuery] = useState(initialQuery);
  const dialog = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  useLayoutEffect(() => {
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, [tab]);
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return html`<div class="modal-backdrop help-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" tabindex="-1" ref=${dialog}
      onKeyDown=${(e) => e.stopPropagation()}>
      <header class="modal-head">
        <h2 class="modal-heading" id="help-title">Help</h2>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="Close (Esc)" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
      </header>
      <div class="modal-body help-body">
        <${Segmented} options=${TABS} value=${tab} onChange=${onTab} label="Help" />
        ${tab === 'guide' ? html`<${GuideTab} />` : html`<${CommandsTab} query=${query} setQuery=${setQuery} onRun=${onRun} />`}
      </div>
    </div>
  </div>`;
}
