import { isLocal } from '../settings.js';
import { html, useState } from '../../vendor/preact-htm.js';
import { addDays, pinnedFirst, SORTS, sortItems, STATUSES, statusLabel, TYPES } from '../model.js';
import { formatLongToday, greeting } from '../format.js';
import { Icon, StatusIcon } from './icons.js';
import { EmptyState, ItemCard, ItemRow, QuickAdd, Segmented, TypeFilter } from './components.js';
import { PlanCard } from './assist.js';

const DONE_LIMIT = 25;

function Section({ title, icon, count, action, children }) {
  return html`<section class="section">
    <header class="section-head">
      <h2>${icon && html`<${Icon} name=${icon} size=${17} />`}${title}${count != null && html`<span class="count">${count}</span>`}</h2>
      ${action}
    </header>
    ${children}
  </section>`;
}

function CardGrid({ items, actions, today }) {
  return html`<div class="card-grid">
    ${items.map((item) => html`<${ItemCard} key=${item.id} item=${item} onOpen=${actions.open} onStatus=${actions.cycleStatus} today=${today} />`)}
  </div>`;
}

const SeeAll = ({ href, label = 'See all' }) => html`<a class="see-all" href=${href}>${label}<${Icon} name="arrowRight" size=${14} /></a>`;

function Welcome({ actions }) {
  return html`<div class="welcome-card">
    <h2>Welcome to Tracker</h2>
    <p>
      Keep tasks, ideas, the Claude work you have going and the documents you need to read in one place, each moving from
      <strong> Pending</strong> to <strong>In progress</strong> to <strong>Done</strong>.
    </p>
    <p>
      Everything is saved on this device straight away${isLocal() ? ', and Tracker Editor on this computer works with it.' : '. Connect a private GitHub repository in Settings to keep your phone and other computers in sync.'}
    </p>
    <div class="welcome-actions">
      <button class="btn primary" onClick=${() => actions.newItem({ type: 'task' })}><${Icon} name="task" />Add a task</button>
      <button class="btn" onClick=${() => actions.newItem({ type: 'claude' })}><${Icon} name="claude" />Track Claude work</button>
      <button class="btn" onClick=${() => actions.newItem({ type: 'doc', kind: 'claude' })}><${Icon} name="doc" />Add a document</button>
      <a class="btn ghost" href="#/settings"><${Icon} name="cloud" />Set up sync</a>
    </div>
  </div>`;
}

export function HomeView({ items, today, actions, hrefFor }) {
  const [captureType, setCaptureType] = useState('task');
  const open = items.filter((i) => i.status !== 'done');
  const inProgressCount = items.filter((i) => i.status === 'in_progress').length;
  // Pinned items come first, by project; the sections below show the others.
  const pinned = pinnedFirst(sortItems(items.filter((i) => i.pinned)));
  const rest = items.filter((i) => !i.pinned);
  const inProgress = sortItems(rest.filter((i) => i.status === 'in_progress'));
  const dueSoon = sortItems(rest.filter((i) => i.status !== 'done' && i.due && i.due <= addDays(today, 7)), 'due');
  const dueIds = new Set(dueSoon.map((i) => i.id));
  const upNext = sortItems(rest.filter((i) => i.status === 'pending' && i.type !== 'doc' && !dueIds.has(i.id)));
  const reading = sortItems(rest.filter((i) => i.type === 'doc' && i.status !== 'done'));
  const recentDone = sortItems(rest.filter((i) => i.status === 'done'));

  return html`<div class="home">
    <div class="hero">
      <h1>${greeting()}</h1>
      <p>${formatLongToday()} · ${inProgressCount} in progress · ${open.length - inProgressCount} pending</p>
    </div>

    <${QuickAdd} type=${captureType} onTypeChange=${setCaptureType} showTypes
      placeholder=${{ task: 'Add a task…', idea: 'Capture an idea…', claude: 'What is Claude working on?', doc: 'Document title or link to read…' }[captureType]}
      onAdd=${(value) => actions.quickAdd(value, { type: captureType })} />

    ${items.length === 0 && html`<${Welcome} actions=${actions} />`}
    <${PlanCard} items=${items} today=${today} />

    <div class="stat-grid">
      ${TYPES.map((t) => {
        const ofType = items.filter((i) => i.type === t.id);
        const count = (s) => ofType.filter((i) => i.status === s).length;
        return html`<a class="stat-card type-${t.id}" href=${hrefFor({ view: 'list', type: t.id })} key=${t.id}>
          <div class="stat-top"><span class="stat-icon"><${Icon} name=${t.id} size=${18} /></span>${t.plural}</div>
          <div class="stat-num">${count('pending') + count('in_progress')}<span>open</span></div>
          <div class="stat-break">
            ${STATUSES.map((s) => html`<span key=${s}><${StatusIcon} status=${s} size=${12} />${count(s)} ${statusLabel(s, t.id).toLowerCase()}</span>`)}
          </div>
        </a>`;
      })}
    </div>

    ${pinned.length > 0 &&
    html`<${Section} title="Pinned" icon="pin" count=${pinned.length}>
      <${CardGrid} items=${pinned} actions=${actions} today=${today} />
    </${Section}>`}

    ${dueSoon.length > 0 &&
    html`<${Section} title="Due soon" icon="calendar" count=${dueSoon.length}>
      <${CardGrid} items=${dueSoon.slice(0, 6)} actions=${actions} today=${today} />
    </${Section}>`}

    ${inProgress.length > 0 &&
    html`<${Section} title="In progress" icon="arrowRight" count=${inProgress.length}
      action=${inProgress.length > 8 && html`<${SeeAll} href=${hrefFor({ view: 'list', status: 'in_progress' })} />`}>
      <${CardGrid} items=${inProgress.slice(0, 8)} actions=${actions} today=${today} />
    </${Section}>`}

    ${upNext.length > 0 &&
    html`<${Section} title="Up next" icon="list" count=${upNext.length}
      action=${upNext.length > 6 && html`<${SeeAll} href=${hrefFor({ view: 'list', status: 'pending' })} />`}>
      <${CardGrid} items=${upNext.slice(0, 6)} actions=${actions} today=${today} />
    </${Section}>`}

    ${reading.length > 0 &&
    html`<${Section} title="Reading list" icon="doc" count=${reading.length}
      action=${reading.length > 6 && html`<${SeeAll} href=${hrefFor({ view: 'list', type: 'doc' })} />`}>
      <${CardGrid} items=${reading.slice(0, 6)} actions=${actions} today=${today} />
    </${Section}>`}

    ${recentDone.length > 0 &&
    html`<${Section} title="Recently completed" icon="check"
      action=${html`<${SeeAll} href=${hrefFor({ view: 'list', status: 'done' })} />`}>
      <div class="rows">
        ${recentDone.slice(0, 5).map((item) => html`<${ItemRow} key=${item.id} item=${item} onOpen=${actions.open} onStatus=${actions.cycleStatus} today=${today} />`)}
      </div>
    </${Section}>`}
  </div>`;
}

function typeCounts(items) {
  const open = items.filter((i) => i.status !== 'done');
  const counts = { all: open.length };
  for (const t of TYPES) counts[t.id] = open.filter((i) => i.type === t.id).length;
  return counts;
}

const addPlaceholder = (type) =>
  ({ task: 'Add a task…', idea: 'Capture an idea…', claude: 'Add Claude work…', doc: 'Add a document to read…' })[type];

export function BoardView({ items, type, onType, actions, today }) {
  const [dropTarget, setDropTarget] = useState(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const newType = type === 'all' ? 'task' : type;
  const ofType = type === 'all' ? items : items.filter((i) => i.type === type);

  return html`<div class="board-view">
    <div class="toolbar">
      <${TypeFilter} value=${type} onChange=${onType} counts=${typeCounts(items)} />
    </div>
    <${QuickAdd} type=${newType} placeholder=${addPlaceholder(newType)} onAdd=${(value) => actions.quickAdd(value, { type: newType })} />
    <div class="board">
      ${STATUSES.map((status) => {
        const all = pinnedFirst(sortItems(ofType.filter((i) => i.status === status)));
        const shown = status === 'done' && !showAllDone ? all.slice(0, DONE_LIMIT) : all;
        return html`<section key=${status} class="column status-${status} ${dropTarget === status ? 'drop' : ''}"
          onDragOver=${(e) => {
            if (!e.dataTransfer.types.includes('text/x-tracker-id')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dropTarget !== status) setDropTarget(status);
          }}
          onDragLeave=${(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null);
          }}
          onDrop=${(e) => {
            const id = e.dataTransfer.getData('text/x-tracker-id');
            setDropTarget(null);
            if (!id) return;
            e.preventDefault();
            actions.setStatus(id, status);
          }}>
          <header class="column-head">
            <${StatusIcon} status=${status} size=${16} />
            <h2>${statusLabel(status, type)}</h2>
            <span class="count">${all.length}</span>
            <button type="button" class="icon-btn sm" title="Add here" aria-label=${`Add to ${statusLabel(status, type)}`}
              onClick=${() => actions.newItem({ type: newType, status })}><${Icon} name="plus" size=${16} /></button>
          </header>
          <div class="column-body">
            ${shown.map((item) => html`<${ItemCard} key=${item.id} item=${item} draggable onOpen=${actions.open}
              onStatus=${actions.cycleStatus} today=${today} showType=${type === 'all'} />`)}
            ${all.length === 0 && html`<div class="column-empty">${status === 'done' ? 'Finished items land here' : 'Nothing here'}</div>`}
            ${all.length > shown.length &&
            html`<button type="button" class="btn ghost sm show-more" onClick=${() => setShowAllDone(true)}>Show all ${all.length}</button>`}
          </div>
        </section>`;
      })}
    </div>
  </div>`;
}

export function ListView({ items, type, status, onType, onStatus, sort, onSort, actions, today, query }) {
  const ofType = type === 'all' ? items : items.filter((i) => i.type === type);
  // Pinned items that match come first, by project.
  const shown = pinnedFirst(sortItems(status === 'all' ? ofType : ofType.filter((i) => i.status === status), sort));
  const statusOptions = [
    { id: 'all', label: 'All', count: ofType.length },
    ...STATUSES.map((s) => ({ id: s, label: statusLabel(s, type), count: ofType.filter((i) => i.status === s).length })),
  ];
  const newType = type === 'all' ? 'task' : type;

  return html`<div class="list-view">
    <div class="toolbar">
      <${TypeFilter} value=${type} onChange=${onType} counts=${typeCounts(items)} />
    </div>
    <div class="toolbar">
      <${Segmented} options=${statusOptions} value=${status} onChange=${onStatus} label="Status" small />
      <label class="sort">
        <span>Sort</span>
        <select value=${sort} onChange=${(e) => onSort(e.currentTarget.value)}>
          ${SORTS.map((s) => html`<option key=${s.id} value=${s.id}>${s.label}</option>`)}
        </select>
      </label>
    </div>
    <${QuickAdd} type=${newType} placeholder=${addPlaceholder(newType)}
      onAdd=${(value) => actions.quickAdd(value, { type: newType, status: status === 'all' ? 'pending' : status })} />
    ${shown.length
      ? html`<div class="rows">
          ${shown.map((item) => html`<${ItemRow} key=${item.id} item=${item} onOpen=${actions.open} onStatus=${actions.cycleStatus} today=${today} />`)}
        </div>`
      : query
        ? html`<${EmptyState} icon="search" title="No matches"><p>Nothing matches “${query}” here.</p></${EmptyState}>`
        : html`<${EmptyState} icon=${type === 'all' ? 'list' : type} title="Nothing here yet">
            <p>Add one with the box above, or press <kbd>N</kbd>.</p>
          </${EmptyState}>`}
  </div>`;
}
