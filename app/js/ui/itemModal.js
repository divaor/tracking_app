import { html, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import {
  areaLabel,
  cleanTags,
  DECISIONS,
  decisionLabel,
  KINDS,
  PRIORITIES,
  projectKey,
  resolveProjectName,
  STATUSES,
  statusLabel,
  titleFromMarkdown,
  titleFromUrl,
  toggleChecklistItem,
  TYPES,
} from '../model.js';
import { formatDateTime, formatDue } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { parseEditorLink } from '../editorLinks.js';
import { getSettings, saveSettings } from '../settings.js';
import { Icon } from './icons.js';
import { DecisionBadge, EditorLink, PriorityMark, ProjectsContext, Segmented, TypeBadge } from './components.js';
import { ProjectChip, TagInput } from './projects.js';
import { FilesPanel } from './fileViewer.js';
import { ItemAssistant } from './assist.js';

const NOTES_PLACEHOLDER = {
  task: 'Details, links, or a checklist:\n- [ ] first step\n- [ ] second step',
  idea: 'Describe the idea, why it matters, what to try first…',
  claude: 'What is Claude working on? Session or PR links, prompts, next steps…',
  doc: 'Paste the document here (Markdown is supported), drop a .md file on the window, or use “Import file”.',
};

function toDraft(source = {}) {
  return {
    type: source.type ?? 'task',
    title: source.title ?? '',
    status: source.status ?? 'pending',
    priority: source.priority ?? 'normal',
    kind: source.kind ?? '',
    project: source.project ?? '',
    tags: [...(source.tags ?? [])],
    url: source.url ?? '',
    due: source.due ?? '',
    notes: source.notes ?? '',
  };
}

function normalizeUrl(url) {
  const value = url.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return /^[\w-]+(\.[\w-]+)+/.test(value) ? `https://${value}` : value;
}

function fromDraft(draft) {
  const fields = { ...draft };
  const url = normalizeUrl(fields.url);
  const title = fields.title.trim() || titleFromMarkdown(fields.notes) || (url ? titleFromUrl(url) : '');
  return { ...fields, title, url, tags: cleanTags(draft.tags) };
}

const sameFields = (a, b) => JSON.stringify(fromDraft(a)) === JSON.stringify(fromDraft(b));

function readTextFile(file) {
  return file.text ? file.text() : new Response(file).text();
}

function ExternalLink({ url, children, className = '' }) {
  return html`<a class=${className} href=${url} target="_blank" rel="noopener noreferrer">${children}</a>`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`.replace(/\/$/, '');
    return u.hostname + (rest.length > 40 ? `${rest.slice(0, 40)}…` : rest);
  } catch {
    return url;
  }
}

const DECISION_ICONS = { approved: 'thumbUp', changes: 'rotate', rejected: 'x' };
const DECISION_VERBS = { approved: 'Approve', changes: 'Request changes', rejected: 'Reject' };

export const isReviewable = (item) => item.type === 'doc' && (item.files.length > 0 || ['proposal', 'artifact'].includes(item.kind) || Boolean(item.decision));

// The user's verdict and feedback; Claude reads both back through the connector.
function ReviewPanel({ item, actions }) {
  const [feedback, setFeedback] = useState(item.feedback);
  useEffect(() => setFeedback(item.feedback), [item.feedback]);
  const decide = (decision) => {
    const next = item.decision === decision ? '' : decision;
    actions.update(item.id, { decision: next, feedback, ...(next ? { status: 'done' } : {}) });
    if (next) actions.toast(`${decisionLabel(next)} — Claude can read your feedback from any session`);
  };
  return html`<section class="review-panel">
    <h3><${Icon} name="checklist" size=${16} />Your review</h3>
    <div class="decision-buttons" role="group" aria-label="Decision">
      ${DECISIONS.map(
        (d) => html`<button type="button" key=${d.id} class="btn decision-${d.id} ${item.decision === d.id ? 'active' : ''}"
          aria-pressed=${item.decision === d.id} onClick=${() => decide(d.id)}>
          <${Icon} name=${DECISION_ICONS[d.id]} size=${16} />${item.decision === d.id ? d.label : DECISION_VERBS[d.id]}
        </button>`,
      )}
    </div>
    <textarea class="feedback-input" rows="4" value=${feedback} onInput=${(e) => setFeedback(e.currentTarget.value)}
      placeholder="Feedback for Claude: what to change, questions, decisions…" aria-label="Feedback" />
    <div class="review-foot">
      <span class="muted small">Ask Claude to “check my tracker for feedback” to act on it.</span>
      <button type="button" class="btn sm" disabled=${feedback === item.feedback} onClick=${() => {
        actions.update(item.id, { feedback });
        actions.toast('Feedback saved');
      }}>Save feedback</button>
    </div>
  </section>`;
}

// What can show under an item's title (the title always shows); per device, settings `itemHead`.
export const ITEM_HEAD = [
  { id: 'status', label: 'Status' },
  { id: 'priority', label: 'Priority' },
  { id: 'project', label: 'Project' },
  { id: 'tags', label: 'Tags' },
];
const headShown = () => ({ status: true, priority: true, project: true, tags: true, ...getSettings().itemHead });

/** The eye in an item's bar: which of status, priority, project and tags show under the title. */
function HeadMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const shown = headShown();
  return html`<div class="head-menu" ref=${ref} onKeyDown=${(e) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    setOpen(false);
  }}>
    <button type="button" class="icon-btn ${open ? 'on' : ''}" title="Show under the title…" aria-label="Show under the title"
      aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name="eye" /></button>
    ${open &&
    html`<div class="head-menu-pop" role="group" aria-label="Show under the title">
      <p>Under the title (it always shows)</p>
      ${ITEM_HEAD.map(
        (part) => html`<label key=${part.id}><input type="checkbox" checked=${shown[part.id]}
          onChange=${(e) => saveSettings({ itemHead: { ...shown, [part.id]: e.currentTarget.checked } })} />${part.label}</label>`,
      )}
    </div>`}
  </div>`;
}

function PriorityPick({ item, actions }) {
  return html`<label class="priority-pick prio-${item.priority}" title="Priority">
    <${Icon} name="flag" size=${14} />
    <select value=${item.priority} aria-label="Priority" onChange=${(e) => actions.update(item.id, { priority: e.currentTarget.value })}>
      ${PRIORITIES.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
    </select>
  </label>`;
}

/** The top of an open item, which stays while its content scrolls: the title, then what `itemHead` shows. */
function ItemHead({ item, actions, titleId }) {
  const shown = headShown();
  const statusOptions = STATUSES.map((s) => ({ id: s, label: statusLabel(s, item.type) }));
  const project = shown.project && item.project;
  const tags = shown.tags ? item.tags : [];
  return html`<div class="item-head">
    <h2 class="item-title" id=${titleId} title=${item.title}>${item.title || 'Untitled'}</h2>
    ${(shown.status || shown.priority) &&
    html`<div class="item-controls">
      ${shown.status && html`<${Segmented} options=${statusOptions} value=${item.status} label="Status" onChange=${(status) => actions.setStatus(item.id, status)} />`}
      ${shown.priority && html`<${PriorityPick} item=${item} actions=${actions} />`}
    </div>`}
    ${(project || tags.length > 0) &&
    html`<div class="item-labels">
      ${project && html`<span class="item-project"><${ProjectLink} name=${item.project} /></span>`}
      ${tags.map((t) => html`<button type="button" class="tag" key=${t} onClick=${() => actions.searchTag(t)}>#${t}</button>`)}
    </div>`}
  </div>`;
}

function ViewBody({ item, actions, today, onEdit, bodyRef, onScroll }) {
  const notesHtml = useMemo(() => renderMarkdown(item.notes), [item.notes]);
  const onNotesClick = (e) => {
    const box = e.target.closest?.('input.md-check');
    if (!box) return;
    e.preventDefault();
    const boxes = [...e.currentTarget.querySelectorAll('input.md-check')];
    actions.update(item.id, { notes: toggleChecklistItem(item.notes, boxes.indexOf(box)) });
  };
  const editorRoute = parseEditorLink(item.url, getSettings().editorUrl);

  return html`<div class="modal-body view" ref=${bodyRef} onScroll=${onScroll}>
    ${(item.due || item.url || item.decision) &&
    html`<dl class="props">
      ${item.due && html`<div><dt>Due</dt><dd>${formatDue(item.due, today)} <span class="muted">(${item.due})</span></dd></div>`}
      ${item.url &&
      html`<div><dt>Link</dt><dd><${ExternalLink} url=${item.url} className="link">${shortUrl(item.url)} <${Icon} name="external" size=${13} /></${ExternalLink}></dd></div>`}
      ${item.decision && html`<div><dt>Review</dt><dd><${DecisionBadge} decision=${item.decision} /></dd></div>`}
    </dl>`}

    ${editorRoute &&
    html`<${EditorLink} route=${editorRoute} className="btn primary open-doc"><${Icon} name="code" />Open in editor</${EditorLink}>`}
    ${item.url &&
    !editorRoute &&
    item.type === 'doc' &&
    !item.files.length &&
    html`<${ExternalLink} url=${item.url} className="btn primary open-doc"><${Icon} name="external" />Open document</${ExternalLink}>`}

    ${item.notes
      ? html`<div class="markdown" onClick=${onNotesClick} dangerouslySetInnerHTML=${{ __html: notesHtml }} />`
      : !item.files.length &&
        html`<p class="muted no-notes">No ${item.type === 'doc' ? 'content' : 'notes'} yet. <button type="button" class="btn link" onClick=${onEdit}>Add some</button></p>`}

    ${item.files.length > 0 && html`<${FilesPanel} item=${item} actions=${actions} />`}
    ${isReviewable(item) && html`<${ReviewPanel} item=${item} actions=${actions} />`}
    <${ItemAssistant} item=${item} actions=${actions} />

    <p class="timestamps">
      Created ${formatDateTime(item.createdAt)} · Updated ${formatDateTime(item.updatedAt)}${item.updatedBy ? ` by ${item.updatedBy}` : ''}
      ${item.completedAt && html` · ${statusLabel('done', item.type)} ${formatDateTime(item.completedAt)}`}
    </p>
  </div>`;
}

function ProjectLink({ name }) {
  const { byKey, showProject } = useContext(ProjectsContext);
  const project = byKey.get(projectKey(name)) ?? { name };
  return html`<${ProjectChip} project=${project} onClick=${() => showProject(projectKey(name))} />${project.area && html` <span class="muted small">${areaLabel(project.area)}</span>`}`;
}

function EditBody({ draft, setDraft, projects, tagSuggestions, onSubmit, titleRef, error, ids, bodyRef, onScroll }) {
  const [tab, setTab] = useState('write');
  const fileRef = useRef(null);
  const set = (key) => (e) => setDraft({ ...draft, [key]: e.currentTarget.value });
  const kinds = KINDS[draft.type];

  const importFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const content = await readTextFile(file);
    setDraft({
      ...draft,
      notes: draft.notes ? `${draft.notes}\n\n${content}` : content,
      title: draft.title || titleFromMarkdown(content, file.name.replace(/\.[^.]+$/, '')),
      kind: draft.kind || (draft.type === 'doc' && /readme/i.test(file.name) ? 'readme' : draft.kind),
    });
  };

  return html`<form class="modal-body edit" id=${ids.form} onSubmit=${onSubmit} novalidate ref=${bodyRef} onScroll=${onScroll}>
    <div class="type-picker" role="group" aria-label="Type">
      ${TYPES.map(
        (t) => html`<button type="button" key=${t.id} class="type-pick type-${t.id} ${draft.type === t.id ? 'active' : ''}"
          aria-pressed=${draft.type === t.id} onClick=${() => setDraft({ ...draft, type: t.id, kind: '' })}>
          <${Icon} name=${t.id} size=${16} /><span>${t.label}</span>
        </button>`,
      )}
    </div>

    <input ref=${titleRef} class="title-input ${error ? 'invalid' : ''}" value=${draft.title} onInput=${set('title')}
      placeholder=${draft.type === 'doc' ? 'Document title' : 'Title'} aria-label="Title" />
    ${error && html`<p class="field-error">${error}</p>`}

    <div class="field-grid">
      <label>
        <span>Status</span>
        <select value=${draft.status} onChange=${set('status')}>
          ${STATUSES.map((s) => html`<option key=${s} value=${s}>${statusLabel(s, draft.type)}</option>`)}
        </select>
      </label>
      <label>
        <span>Priority</span>
        <select value=${draft.priority} onChange=${set('priority')}>
          ${PRIORITIES.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
        </select>
      </label>
      <label>
        <span>Due date</span>
        <input type="date" value=${draft.due} onInput=${set('due')} />
      </label>
      ${kinds &&
      html`<label>
        <span>Kind</span>
        <select value=${draft.kind} onChange=${set('kind')}>
          <option value="">—</option>
          ${kinds.map((k) => html`<option key=${k.id} value=${k.id}>${k.label}</option>`)}
        </select>
      </label>`}
      <label class=${kinds ? '' : 'span-2'}>
        <span>Project</span>
        <input value=${draft.project} onInput=${set('project')} list=${ids.projects} placeholder="Optional" />
        <datalist id=${ids.projects}>${projects.map((p) => html`<option key=${p} value=${p} />`)}</datalist>
      </label>
      <label class="span-2">
        <span>Link</span>
        <input value=${draft.url} onInput=${set('url')} inputmode="url" autocomplete="off"
          placeholder=${draft.type === 'claude' ? 'https://claude.ai/code/… or a PR link' : 'https://…'} />
      </label>
      <div class="tags-field span-2">
        <span>Tags</span>
        <${TagInput} value=${draft.tags} onChange=${(tags) => setDraft({ ...draft, tags })} suggestions=${tagSuggestions}
          placeholder="Type a tag and press Enter, e.g. a repo name" />
      </div>
    </div>

    <div class="notes-head">
      <${Segmented} small label="Notes editor" value=${tab} onChange=${setTab}
        options=${[{ id: 'write', label: 'Write', icon: 'edit' }, { id: 'preview', label: 'Preview', icon: 'eye' }]} />
      <button type="button" class="btn ghost sm" onClick=${() => fileRef.current?.click()}><${Icon} name="upload" size=${15} />Import file</button>
      <input ref=${fileRef} type="file" hidden accept=".md,.markdown,.mdx,.txt,text/markdown,text/plain" onChange=${importFile} />
    </div>
    ${tab === 'write'
      ? html`<textarea class="notes-input" value=${draft.notes} onInput=${set('notes')} rows="12"
          placeholder=${NOTES_PLACEHOLDER[draft.type]} aria-label=${draft.type === 'doc' ? 'Content' : 'Notes'} />`
      : html`<div class="markdown preview" dangerouslySetInnerHTML=${{ __html: renderMarkdown(draft.notes) || '<p class="muted">Nothing to preview.</p>' }} />`}
  </form>`;
}

let panelSeq = 0;
const isField = (el) => /INPUT|TEXTAREA|SELECT/.test(el?.tagName);
const plainKey = (e, key) => e.key === key && !e.metaKey && !e.ctrlKey && !e.altKey && !isField(e.target);

/**
 * An open item: its bar, the top that stays (title, status, priority, project, tags) and the
 * content that scrolls under it; or the form while editing. `frame` 'modal' is the dialog
 * over the app (its keys are the document's), 'window' an item window (`ItemWindow`: keys
 * only while it has the focus; `tools` and `onHead*` come from it).
 */
export function ItemPanel({
  item, initial, actions, projects, tagSuggestions = [], today, onClose, frame = 'modal', rootRef, rootProps = {},
  tools, onHeadPointerDown, onHeadDoubleClick, onPopOut, initialScroll = 0, closeRef, children,
}) {
  const isNew = !item;
  const [mode, setMode] = useState(isNew ? 'edit' : 'view');
  const [draft, setDraft] = useState(() => toDraft(item ?? initial));
  const [baseline, setBaseline] = useState(() => toDraft(item ?? initial));
  const [error, setError] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const titleRef = useRef(null);
  const ownRef = useRef(null);
  const dialogRef = rootRef ?? ownRef;
  const bodyRef = useRef(null);
  const editing = mode === 'edit';
  // The dialog keeps the ids it always had; each window gets its own.
  const ids = useMemo(() => {
    const n = frame === 'modal' ? '' : `-${++panelSeq}`;
    return { title: `modal-title${n}`, form: `item-form${n}`, projects: `project-options${n}` };
  }, []);

  const startEdit = () => {
    const d = toDraft(item);
    setDraft(d);
    setBaseline(d);
    setError('');
    setMode('edit');
  };

  const requestClose = () => {
    if (editing && !sameFields(draft, baseline) && !confirm('Discard your changes?')) return;
    if (editing && !isNew) {
      setMode('view');
      return;
    }
    onClose();
  };
  if (closeRef) closeRef.current = requestClose;

  const save = (e) => {
    e?.preventDefault();
    const fields = fromDraft(draft);
    fields.project = resolveProjectName(fields.project, projects);
    if (!fields.title) {
      setError('Give it a title (or a link or some notes).');
      titleRef.current?.focus();
      return;
    }
    if (isNew) {
      actions.create(fields);
      onClose();
      return;
    }
    // Only what was changed here, so edits made meanwhile elsewhere (another window of this
    // item, the board, Claude) are kept.
    const before = fromDraft(baseline);
    const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
    if (Object.keys(patch).length) actions.update(item.id, patch);
    setMode('view');
  };

  const popOut = () => onPopOut?.({ scroll: bodyRef.current?.scrollTop ?? 0 });

  useEffect(() => {
    if (editing) titleRef.current?.focus();
    else dialogRef.current?.focus({ preventScroll: true });
  }, [editing]);

  // A window popped out of the dialog opens where the dialog was scrolled to.
  useLayoutEffect(() => {
    if (initialScroll && bodyRef.current) bodyRef.current.scrollTop = initialScroll;
  }, []);

  /** The item's keys; true when one was used. */
  const onKey = (e) => {
    if (e.key === 'Escape') requestClose();
    else if (editing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    else if (!editing && plainKey(e, 'e')) startEdit();
    else if (!editing && plainKey(e, 'p')) actions.togglePin(item);
    else if (!editing && onPopOut && plainKey(e, 'w')) popOut();
    else return false;
    e.preventDefault();
    return true;
  };
  useEffect(() => {
    if (frame !== 'modal') return undefined;
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const type = editing ? draft.type : item.type;
  const Root = frame === 'window' ? 'section' : 'div';
  const frameClass = frame === 'window' ? 'item-window' : 'modal';
  return html`<${Root} ...${rootProps}
    class="${frameClass} type-${type} ${editing ? 'editing' : 'viewing'} ${type === 'doc' && !editing ? 'reader' : ''} ${rootProps.class ?? ''}"
    role="dialog" aria-modal=${frame === 'modal' ? 'true' : undefined} aria-labelledby=${ids.title} tabindex="-1" ref=${dialogRef}
    onKeyDown=${frame === 'window' ? (e) => onKey(e) && e.stopPropagation() : undefined}>
    <div class="item-top ${scrolled ? 'scrolled' : ''}">
      <header class="modal-head" onPointerDown=${onHeadPointerDown} onDblClick=${onHeadDoubleClick}>
        ${editing
          ? html`<h2 class="modal-heading" id=${ids.title}>${isNew ? 'New item' : 'Edit item'}</h2>`
          : html`<${TypeBadge} type=${item.type} kind=${item.kind} />`}
        <span class="spacer" />
        ${!editing &&
        html`<${HeadMenu} />
          <button type="button" class="icon-btn pin-toggle ${item.pinned ? 'on' : ''}" title=${item.pinned ? 'Unpin (P)' : 'Pin to the top of its project (P)'}
            aria-label=${item.pinned ? 'Unpin' : 'Pin'} aria-pressed=${Boolean(item.pinned)} onClick=${() => actions.togglePin(item)}><${Icon} name="pin" /></button>
          <button type="button" class="icon-btn" title="Edit (E)" aria-label="Edit" onClick=${startEdit}><${Icon} name="edit" /></button>
          <button type="button" class="icon-btn danger" title="Delete" aria-label="Delete" onClick=${() => {
            actions.remove(item.id);
            onClose();
          }}><${Icon} name="trash" /></button>`}
        ${!editing &&
        onPopOut &&
        html`<button type="button" class="icon-btn pop-out" title="Open in a window (W): keep it aside, compare it with others" aria-label="Open in a window"
          onClick=${popOut}><${Icon} name="popout" /></button>`}
        ${tools}
        <button type="button" class="icon-btn" title="Close (Esc)" aria-label="Close" onClick=${requestClose}><${Icon} name="x" /></button>
      </header>
      ${!editing && html`<${ItemHead} item=${item} actions=${actions} titleId=${ids.title} />`}
    </div>
    ${editing
      ? html`<${EditBody} draft=${draft} setDraft=${(d) => {
          setDraft(d);
          if (error) setError('');
        }} projects=${projects} tagSuggestions=${tagSuggestions} onSubmit=${save} titleRef=${titleRef} error=${error}
          ids=${ids} bodyRef=${bodyRef} onScroll=${(e) => setScrolled(e.currentTarget.scrollTop > 4)} />`
      : html`<${ViewBody} item=${item} actions=${actions} today=${today} onEdit=${startEdit}
          bodyRef=${bodyRef} onScroll=${(e) => setScrolled(e.currentTarget.scrollTop > 4)} />`}
    ${editing &&
    html`<footer class="modal-foot">
      ${!isNew &&
      html`<button type="button" class="btn ghost danger" onClick=${() => {
        actions.remove(item.id);
        onClose();
      }}><${Icon} name="trash" size=${16} />Delete</button>`}
      <span class="spacer" />
      <button type="button" class="btn" onClick=${requestClose}>Cancel</button>
      <button type="submit" form=${ids.form} class="btn primary" title="Save (Ctrl+Enter)">${isNew ? 'Add' : 'Save'}</button>
    </footer>`}
    ${children}
  </${Root}>`;
}

/** The item dialog: one item over the app (the default way an item opens). */
export function ItemModal(props) {
  const closeRef = useRef(null);
  return html`<div class="modal-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && closeRef.current?.()}>
    <${ItemPanel} ...${props} frame="modal" closeRef=${closeRef} />
  </div>`;
}
