import { createContext, html, useContext, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { checklistProgress, decisionLabel, isOverdue, kindLabel, nextStatus, projectKey, statusLabel, TYPES, typeInfo } from '../model.js';
import { formatDue, timeAgo } from '../format.js';
import { editorLink, parseEditorLink } from '../editorLinks.js';
import { getSettings, isLocal } from '../settings.js';
import { Icon, StatusIcon } from './icons.js';
import { ProjectChip } from './projects.js';
import { MicButton } from './dictation.js';
import { modelReady } from '../assistant.js';

// Project colors and the "show this project" action, provided by the app.
export const ProjectsContext = createContext({ byKey: new Map(), showProject: () => {} });

export function TypeBadge({ type, kind }) {
  return html`<span class="badge type-${type}"><${Icon} name=${type} size=${13} />${kindLabel(type, kind) || typeInfo(type).label}</span>`;
}

export function StatusButton({ item, onStatus, size = 20 }) {
  const next = nextStatus(item.status);
  const label = `${statusLabel(item.status, item.type)} — mark as ${statusLabel(next, item.type)}`;
  return html`<button type="button" class="status-btn status-${item.status}" title=${label} aria-label=${label}
    onClick=${(e) => {
      e.stopPropagation();
      onStatus(item, next);
    }}><${StatusIcon} status=${item.status} size=${size} /></button>`;
}

export function PriorityMark({ priority }) {
  if (priority !== 'high' && priority !== 'urgent') return null;
  return html`<span class="priority priority-${priority}"><${Icon} name="flag" size=${12} />${priority === 'urgent' ? 'Urgent' : 'High'}</span>`;
}

const DECISION_ICON = { approved: 'thumbUp', changes: 'rotate', rejected: 'x' };

export function DecisionBadge({ decision }) {
  if (!decision) return null;
  return html`<span class="decision decision-${decision}"><${Icon} name=${DECISION_ICON[decision]} size=${12} />${decisionLabel(decision)}</span>`;
}

export function ItemMeta({ item, today, maxTags = 6 }) {
  const { byKey, showProject } = useContext(ProjectsContext);
  const progress = checklistProgress(item.notes);
  const parts = [];
  if (item.project) {
    const project = byKey.get(projectKey(item.project)) ?? { name: item.project };
    parts.push(html`<${ProjectChip} project=${project} small onClick=${() => showProject(projectKey(item.project))} />`);
  }
  if (item.due) {
    parts.push(html`<span class="meta due ${isOverdue(item, today) ? 'overdue' : ''}"><${Icon} name="calendar" size=${13} />${formatDue(item.due, today)}</span>`);
  }
  if (progress.total) {
    parts.push(html`<span class="meta ${progress.done === progress.total ? 'complete' : ''}"><${Icon} name="checklist" size=${13} />${progress.done}/${progress.total}</span>`);
  }
  if (item.files.length) {
    parts.push(html`<span class="meta" title=${item.files.map((f) => f.name).join(', ')}><${Icon} name="paperclip" size=${13} />${item.files.length}</span>`);
  }
  if (item.url) {
    const inEditor = parseEditorLink(item.url, getSettings().editorUrl);
    parts.push(html`<span class="meta" title=${inEditor ? 'Opens in Tracker Editor' : item.url}><${Icon} name=${inEditor ? 'code' : 'link'} size=${13} /></span>`);
  }
  for (const tag of item.tags.slice(0, maxTags)) parts.push(html`<span class="tag">#${tag}</span>`);
  if (item.tags.length > maxTags) parts.push(html`<span class="tag">+${item.tags.length - maxTags}</span>`);
  return parts.length ? html`<div class="item-meta">${parts}</div>` : null;
}

// Whether Tracker Editor's desktop app is installed (asked once, desktop app only).
let editorApp = null;
const hasEditorApp = () => (editorApp ??= window.desktop?.hasEditorApp ? window.desktop.hasEditorApp().catch(() => false) : Promise.resolve(false));

/** Opens a route in Tracker Editor: its desktop app when installed here, otherwise the web version. */
export function EditorLink({ route, className = '', title, children }) {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    let current = true;
    hasEditorApp().then((installed) => current && setDesktop(installed));
    return () => {
      current = false;
    };
  }, []);
  return html`<a class=${className} href=${editorLink(route, { editorUrl: getSettings().editorUrl, desktop })} target="_blank" rel="noopener noreferrer" title=${title}>${children}</a>`;
}

const openOnEnter = (fn) => (e) => {
  if (e.key === 'Enter' && e.target === e.currentTarget) fn();
};

export function ItemCard({ item, onOpen, onStatus, today, draggable = false, showType = true }) {
  return html`<article class="card type-${item.type} status-${item.status}" tabindex="0" draggable=${draggable}
    onClick=${() => onOpen(item)} onKeyDown=${openOnEnter(() => onOpen(item))}
    onDragStart=${draggable
      ? (e) => {
          e.dataTransfer.setData('text/x-tracker-id', item.id);
          e.dataTransfer.effectAllowed = 'move';
          e.currentTarget.classList.add('dragging');
        }
      : undefined}
    onDragEnd=${draggable ? (e) => e.currentTarget.classList.remove('dragging') : undefined}>
    <div class="card-head">
      <${StatusButton} item=${item} onStatus=${onStatus} />
      <div class="card-title">${item.title || 'Untitled'}</div>
    </div>
    <div class="card-foot">
      ${showType && html`<${TypeBadge} type=${item.type} kind=${item.kind} />`}
      <${DecisionBadge} decision=${item.decision} />
      <${PriorityMark} priority=${item.priority} />
      <${ItemMeta} item=${item} today=${today} maxTags=${4} />
    </div>
  </article>`;
}

export function ItemRow({ item, onOpen, onStatus, today }) {
  return html`<div class="row type-${item.type} status-${item.status}" role="button" tabindex="0"
    onClick=${() => onOpen(item)} onKeyDown=${openOnEnter(() => onOpen(item))}>
    <${StatusButton} item=${item} onStatus=${onStatus} />
    <span class="row-type" title=${typeInfo(item.type).label}><${Icon} name=${item.type} size=${16} /></span>
    <div class="row-main">
      <div class="row-title">${item.title || 'Untitled'}</div>
      <${ItemMeta} item=${item} today=${today} />
    </div>
    ${(item.decision || item.priority === 'high' || item.priority === 'urgent') &&
    html`<span class="row-badges"><${DecisionBadge} decision=${item.decision} /><${PriorityMark} priority=${item.priority} /></span>`}
  </div>`;
}

export function Segmented({ options, value, onChange, label, small = false }) {
  return html`<div class="segmented ${small ? 'small' : ''}" role="group" aria-label=${label}>
    ${options.map(
      (o) => html`<button type="button" key=${o.id} class=${o.id === value ? 'active' : ''} aria-pressed=${o.id === value}
        onClick=${() => onChange(o.id)}>
        ${o.icon && html`<${Icon} name=${o.icon} size=${15} />`}<span class="seg-label">${o.label}</span>
        ${o.count != null && html`<span class="count">${o.count}</span>`}
      </button>`,
    )}
  </div>`;
}

export function TypeFilter({ value, onChange, counts }) {
  const options = [
    { id: 'all', label: 'All', count: counts?.all },
    ...TYPES.map((t) => ({ id: t.id, label: t.plural, icon: t.id, count: counts?.[t.id] })),
  ];
  return html`<${Segmented} options=${options} value=${value} onChange=${onChange} label="Category" />`;
}

export function EmptyState({ icon = 'check', title, children }) {
  return html`<div class="empty">
    <div class="empty-icon"><${Icon} name=${icon} size=${28} /></div>
    <h3>${title}</h3>
    ${children}
  </div>`;
}

export function QuickAdd({ type, onAdd, placeholder, showTypes = false, onTypeChange }) {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState('');
  // Dictated text goes after what was typed before the microphone started.
  const typed = useRef('');
  const submit = (e) => {
    e.preventDefault();
    if (!value.trim()) return;
    onAdd(value.trim());
    setValue('');
  };
  const smart = modelReady() && getSettings().smartAdd;
  return html`<form class="quick-add" onSubmit=${submit}>
    ${showTypes &&
    html`<div class="quick-types" role="group" aria-label="Type of item">
      ${TYPES.map(
        (t) => html`<button type="button" key=${t.id} class="type-pick type-${t.id} ${t.id === type ? 'active' : ''}"
          aria-pressed=${t.id === type} onClick=${() => onTypeChange(t.id)}>
          <${Icon} name=${t.id} size=${16} /><span>${t.label}</span>
        </button>`,
      )}
    </div>`}
    <div class="quick-input">
      <${Icon} name="plus" size=${18} />
      <input value=${value} onInput=${(e) => ((typed.current = e.currentTarget.value), setValue(e.currentTarget.value))} placeholder=${placeholder}
        aria-label="Quick add" enterkeyhint="done" autocomplete="off" />
      <${MicButton} onError=${setProblem} onText=${(text) => {
        setProblem('');
        setValue([typed.current.trim(), text].filter(Boolean).join(' '));
      }} />
      <button class="btn primary sm" type="submit" disabled=${!value.trim()}>Add</button>
    </div>
    ${problem && html`<div class="quick-hint error-text" role="alert">${problem}</div>`}
    <div class="quick-hint">${smart
      ? html`<${Icon} name="sparkle" size=${13} /> Plain language works: <em>call Ana tomorrow about the invoice, urgent</em>. Or <code>+project</code> <code>#tag</code> <code>!high</code> <code>@tomorrow</code>`
      : html`Shortcuts: <code>+project</code> <code>#tag</code> <code>!high</code> <code>@tomorrow</code> or paste a link`}</div>
  </form>`;
}

export function syncDescription(sync) {
  switch (sync.phase) {
    case 'disabled':
      return { icon: 'cloudOff', label: 'Local only', cls: 'muted' };
    case 'syncing':
      return { icon: 'sync', label: 'Syncing…', cls: 'busy' };
    case 'offline':
      return { icon: 'cloudOff', label: sync.dirty ? 'Offline · saved here' : 'Offline', cls: 'warn' };
    case 'error':
      return { icon: 'alert', label: 'Sync error', cls: 'error' };
    default:
      return sync.dirty
        ? { icon: 'cloud', label: 'Changes pending', cls: 'pending' }
        : { icon: 'cloud', label: `Synced ${timeAgo(sync.lastSyncAt)}`, cls: 'ok' };
  }
}

export function SyncBadge({ sync, onClick, compact = false }) {
  // Local mode: the data stays here, nothing to show.
  if (isLocal()) return null;
  const { icon, label, cls } = syncDescription(sync);
  return html`<button type="button" class="sync-badge ${cls} ${compact ? 'compact' : ''}" title=${sync.error || label}
    aria-label=${label} onClick=${onClick}>
    <${Icon} name=${icon} size=${16} /><span class="label">${label}</span>
  </button>`;
}

export function Toasts({ toasts, onDismiss }) {
  return html`<div class="toasts" aria-live="polite">
    ${toasts.map(
      (t) => html`<div class="toast ${t.kind ?? ''}" key=${t.id}>
        <span class="toast-msg">${t.message}</span>
        ${t.action &&
        html`<button type="button" class="btn link" onClick=${() => {
          t.action.run();
          onDismiss(t.id);
        }}>${t.action.label}</button>`}
        <button type="button" class="icon-btn sm" aria-label="Dismiss" onClick=${() => onDismiss(t.id)}><${Icon} name="x" size=${15} /></button>
      </div>`,
    )}
  </div>`;
}
