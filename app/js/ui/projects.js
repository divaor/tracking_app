import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { AREAS, areaLabel, cleanTags, PROJECT_COLORS, projectKey, tagCounts } from '../model.js';
import { store } from '../store.js';
import { Icon } from './icons.js';

const AREA_ICON = { work: 'briefcase', personal: 'person' };

export function ProjectChip({ project, name, onClick, small = false }) {
  const label = project?.name ?? name;
  if (!label) return null;
  const style = { '--pc': project?.color || 'var(--text-3)' };
  const inner = html`<span class="project-dot" />${label}`;
  return onClick
    ? html`<button type="button" class="project-chip ${small ? 'small' : ''}" style=${style} title=${`Project: ${label}`}
        onClick=${(e) => {
          e.stopPropagation();
          onClick();
        }}>${inner}</button>`
    : html`<span class="project-chip ${small ? 'small' : ''}" style=${style} title=${`Project: ${label}`}>${inner}</span>`;
}

export function scopeLabel(scope, projects) {
  if (!scope.length) return 'All projects';
  return scope
    .map((s) => {
      if (s === 'none') return 'No project';
      if (s.startsWith('area:')) return areaLabel(s.slice(5));
      return projects.find((p) => p.key === s.slice(8))?.name ?? s.slice(8);
    })
    .join(' + ');
}

function ProjectPicker({ projects, scope, onChange, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const toggle = (value) => onChange(scope.includes(value) ? scope.filter((s) => s !== value) : [...scope, value]);
  const groups = [...AREAS.map((a) => ({ id: a.id, label: a.label })), { id: '', label: 'Other projects' }];
  return html`<div class="project-picker" ref=${ref} role="dialog" aria-label="Choose projects">
    <div class="picker-body">
      ${groups.map((g) => {
        const list = projects.filter((p) => p.area === g.id);
        if (!list.length) return null;
        return html`<div class="picker-group" key=${g.id || 'other'}>
          <div class="picker-heading">${g.label}</div>
          ${list.map(
            (p) => html`<label class="picker-row" key=${p.key}>
              <input type="checkbox" checked=${scope.includes(`project:${p.key}`)} onChange=${() => toggle(`project:${p.key}`)} />
              <span class="project-dot" style=${{ '--pc': p.color }} /><span class="picker-name">${p.name}</span><span class="count">${p.open}</span>
            </label>`,
          )}
        </div>`;
      })}
      <div class="picker-group">
        <label class="picker-row">
          <input type="checkbox" checked=${scope.includes('none')} onChange=${() => toggle('none')} />
          <span class="picker-name muted">Items without a project</span>
        </label>
      </div>
      ${!projects.length && html`<p class="muted small picker-empty">No projects yet. Set a project on an item, or add one under Projects.</p>`}
    </div>
    <div class="picker-foot">
      <a href="#/projects" class="btn ghost sm" onClick=${onClose}><${Icon} name="settings" size=${15} />Manage</a>
      <span class="spacer" />
      <button type="button" class="btn sm" disabled=${!scope.length} onClick=${() => onChange([])}>Clear</button>
      <button type="button" class="btn primary sm" onClick=${onClose}>Done</button>
    </div>
  </div>`;
}

/** Project scope: All / Work / Personal / chosen projects. Shared by the main views. */
export function ScopeBar({ scope, projects, onChange }) {
  const [open, setOpen] = useState(false);
  const toggle = (value) => onChange(scope.includes(value) ? scope.filter((s) => s !== value) : [...scope, value]);
  const chosen = scope.filter((s) => s.startsWith('project:') || s === 'none');
  return html`<div class="scope-bar" role="group" aria-label="Project filter">
    <button type="button" class="scope-chip ${!scope.length ? 'active' : ''}" aria-pressed=${!scope.length} onClick=${() => onChange([])}>All</button>
    ${AREAS.map(
      (a) => html`<button type="button" key=${a.id} class="scope-chip ${scope.includes(`area:${a.id}`) ? 'active' : ''}" aria-pressed=${scope.includes(`area:${a.id}`)}
        onClick=${() => toggle(`area:${a.id}`)}><${Icon} name=${AREA_ICON[a.id]} size=${14} />${a.label}</button>`,
    )}
    ${chosen.map((s) => {
      const project = projects.find((p) => `project:${p.key}` === s);
      return html`<span class="scope-chip active chosen" key=${s} style=${{ '--pc': project?.color ?? 'var(--text-3)' }}>
        ${s !== 'none' && html`<span class="project-dot" />`}${s === 'none' ? 'No project' : (project?.name ?? s.slice(8))}
        <button type="button" class="chip-x" aria-label="Remove from filter" onClick=${() => toggle(s)}><${Icon} name="x" size=${12} /></button>
      </span>`;
    })}
    <div class="scope-more">
      <button type="button" class="scope-chip ${open ? 'open' : ''}" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <${Icon} name="folder" size=${14} />Projects<${Icon} name="chevronDown" size=${13} />
      </button>
      ${open && html`<${ProjectPicker} projects=${projects} scope=${scope} onChange=${onChange} onClose=${() => setOpen(false)} />`}
    </div>
  </div>`;
}

/** Tag editor: chips with remove buttons, suggestions from existing tags. */
export function TagInput({ value, onChange, suggestions = [], placeholder = 'Add a tag…' }) {
  const [text, setText] = useState('');
  const commit = (raw = text) => {
    const added = cleanTags(raw);
    if (added.length) onChange(cleanTags([...value, ...added]));
    setText('');
  };
  const listId = useRef(`tags-${Math.random().toString(36).slice(2)}`).current;
  const lower = value.map((t) => t.toLowerCase());
  return html`<div class="tag-input">
    ${value.map(
      (t) => html`<span class="tag tag-chip" key=${t}>#${t}<button type="button" class="chip-x" aria-label=${`Remove ${t}`}
        onClick=${() => onChange(value.filter((x) => x !== t))}><${Icon} name="x" size=${11} /></button></span>`,
    )}
    <input value=${text} list=${listId} placeholder=${value.length ? '' : placeholder} aria-label="Add tag" autocomplete="off" autocapitalize="off"
      onInput=${(e) => {
        const v = e.currentTarget.value;
        if (/[,\n]/.test(v)) commit(v);
        else setText(v);
      }}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Backspace' && !text && value.length) {
          onChange(value.slice(0, -1));
        }
      }}
      onBlur=${() => commit()} />
    <datalist id=${listId}>${suggestions.filter((s) => !lower.includes(s.toLowerCase())).map((s) => html`<option key=${s} value=${s} />`)}</datalist>
  </div>`;
}

function ColorPicker({ value, onChange }) {
  return html`<div class="color-picker" role="group" aria-label="Color">
    ${PROJECT_COLORS.map(
      (c) => html`<button type="button" key=${c} class="swatch ${c === value ? 'active' : ''}" style=${{ '--pc': c }} aria-label=${`Color ${c}`}
        aria-pressed=${c === value} onClick=${() => onChange(c)} />`,
    )}
  </div>`;
}

// Enter saves and the input then loses focus; this keeps it to one save.
function useRename(initial) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(initial);
  const done = useRef(false);
  const start = () => {
    done.current = false;
    setName(initial);
    setRenaming(true);
  };
  const finish = () => {
    if (done.current) return false;
    done.current = true;
    setRenaming(false);
    return true;
  };
  return { renaming, name, setName, start, finish, cancel: () => finish() };
}

function ProjectRow({ project, actions }) {
  const { renaming, name, setName, start, finish, cancel } = useRename(project.name);
  const [colors, setColors] = useState(false);
  const save = () => {
    if (!finish()) return;
    const next = name.trim();
    if (next && next !== project.name) {
      store.renameProject(project.name, next);
      actions.toast(`Renamed to “${next}”`);
    }
  };
  return html`<div class="project-row">
    <button type="button" class="swatch big" style=${{ '--pc': project.color }} aria-label="Change color" onClick=${() => setColors(!colors)} />
    <div class="project-main">
      ${renaming
        ? html`<input class="rename-input" value=${name} onInput=${(e) => setName(e.currentTarget.value)} aria-label="Project name"
            onKeyDown=${(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') cancel();
            }} onBlur=${save} ref=${(el) => el?.focus()} />`
        : html`<button type="button" class="project-name" onClick=${() => actions.showProject(project.key)}>${project.name}</button>`}
      <div class="muted small">${project.open} open · ${project.total} total${project.pinned ? ` · ${project.pinned} pinned` : ''}${project.registered ? '' : ' · from items'}</div>
      ${colors && html`<${ColorPicker} value=${project.color} onChange=${(c) => {
        store.saveProject(project.name, { color: c });
        setColors(false);
      }} />`}
    </div>
    <select class="area-select" value=${project.area} aria-label="Area" onChange=${(e) => store.saveProject(project.name, { area: e.currentTarget.value })}>
      <option value="">No area</option>
      ${AREAS.map((a) => html`<option key=${a.id} value=${a.id}>${a.label}</option>`)}
    </select>
    <div class="row-actions">
      <button type="button" class="icon-btn sm" title="Rename" aria-label="Rename" onClick=${start}><${Icon} name="edit" size=${15} /></button>
      <button type="button" class="icon-btn sm danger" title="Delete" aria-label="Delete project" onClick=${() => {
        if (!confirm(`Delete the project “${project.name}”? Its ${project.total} items stay, without a project.`)) return;
        store.deleteProject(project.name);
        actions.toast(`Deleted project “${project.name}”`);
      }}><${Icon} name="trash" size=${15} /></button>
    </div>
  </div>`;
}

function TagRow({ entry, actions }) {
  const { renaming, name, setName, start, finish, cancel } = useRename(entry.tag);
  const save = () => {
    if (!finish()) return;
    const next = cleanTags(name)[0];
    if (next && next !== entry.tag) {
      store.renameTag(entry.tag, next);
      actions.toast(`Renamed #${entry.tag} to #${next}`);
    }
  };
  return html`<div class="tag-row">
    ${renaming
      ? html`<input class="rename-input" value=${name} onInput=${(e) => setName(e.currentTarget.value)} aria-label="Tag name"
          onKeyDown=${(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
          }} onBlur=${save} ref=${(el) => el?.focus()} />`
      : html`<button type="button" class="tag" onClick=${() => actions.searchTag(entry.tag)}>#${entry.tag}</button>`}
    <span class="muted small">${entry.count} item${entry.count === 1 ? '' : 's'}</span>
    <span class="spacer" />
    <button type="button" class="icon-btn sm" title="Rename or merge" aria-label="Rename tag" onClick=${start}><${Icon} name="edit" size=${15} /></button>
    <button type="button" class="icon-btn sm danger" title="Remove from all items" aria-label="Delete tag" onClick=${() => {
      if (!confirm(`Remove #${entry.tag} from ${entry.count} item${entry.count === 1 ? '' : 's'}?`)) return;
      store.deleteTag(entry.tag);
      actions.toast(`Removed #${entry.tag}`);
    }}><${Icon} name="trash" size=${15} /></button>
  </div>`;
}

export function ProjectsView({ items, projects, actions }) {
  const [name, setName] = useState('');
  const [area, setArea] = useState('work');
  const tags = tagCounts(items);
  const add = (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    if (projects.some((p) => p.key === projectKey(clean) && p.registered)) {
      actions.toast(`“${clean}” already exists`, { kind: 'error' });
      return;
    }
    store.saveProject(clean, { area });
    setName('');
    actions.toast(`Added project “${clean}”`);
  };
  const groups = [...AREAS, { id: '', label: 'No area' }];
  return html`<div class="projects-view">
    <section class="settings-card">
      <h2><${Icon} name="folder" size=${18} />Projects</h2>
      <p class="muted">Each item can belong to one project. Put projects in <strong>Work</strong> or <strong>Personal</strong> to filter them apart, and use tags (for example the repos a proposal touches) for everything else.</p>
      <form class="new-project" onSubmit=${add}>
        <input value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="New project name" aria-label="New project name" />
        <select value=${area} onChange=${(e) => setArea(e.currentTarget.value)} aria-label="Area">
          ${AREAS.map((a) => html`<option key=${a.id} value=${a.id}>${a.label}</option>`)}
          <option value="">No area</option>
        </select>
        <button type="submit" class="btn primary" disabled=${!name.trim()}><${Icon} name="plus" size=${16} />Add</button>
      </form>
      ${groups.map((g) => {
        const list = projects.filter((p) => p.area === g.id);
        if (!list.length) return null;
        return html`<div class="project-group" key=${g.id || 'none'}>
          <h3>${g.id && html`<${Icon} name=${AREA_ICON[g.id]} size=${15} />`}${g.label}<span class="count">${list.length}</span></h3>
          ${list.map((p) => html`<${ProjectRow} key=${`${p.key}:${p.name}`} project=${p} actions=${actions} />`)}
        </div>`;
      })}
      ${!projects.length && html`<p class="muted">No projects yet.</p>`}
    </section>
    <section class="settings-card">
      <h2><${Icon} name="tag" size=${18} />Tags</h2>
      <p class="muted">Tags are created when you use them, on an item, with <code>#tag</code> in quick add, or by Claude. Rename one to merge it into another.</p>
      ${tags.length ? html`<div class="tag-list">${tags.map((t) => html`<${TagRow} key=${t.tag} entry=${t} actions=${actions} />`)}</div>` : html`<p class="muted">No tags yet.</p>`}
    </section>
  </div>`;
}
