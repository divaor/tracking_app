// A project's release board (#/release-board/<slug>[/<view>[/<arg>]]), from the board kept with the
// data (boards.js, boardStore.js), with the standalone page's views as tabs (boardViews.js: Overview,
// Timeline, Releases, Features, Tests, Decisions, Commands, Log; empty ones hidden) and its search.
// Records open in the drawer (boardDrawer.js). Claude keeps the board current (update_board); here a
// board file can be imported and the board downloaded as its page's data file. #/release-board
// lists the boards.
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { boardTabs, boardUpdated } from '../boards.js';
import { cachedBoard, cachedBoards, exportBoardFile, importBoardFile, onBoards, refreshBoards } from '../boardStore.js';
import { saveToDevice } from '../saveFile.js';
import { Drawer } from './boardDrawer.js';
import { BoardText, boardStamp } from './boardParts.js';
import { CommandsView, DecisionsView, FeaturesView, LogView, Overview, ReleasesView, SearchView, TestsView, TimelineView } from './boardViews.js';
import { Icon } from './icons.js';

export const BOARD_TABS = {
  overview: 'Overview',
  timeline: 'Timeline',
  releases: 'Releases',
  features: 'Features',
  tests: 'Tests',
  decisions: 'Decisions',
  commands: 'Commands',
  log: 'Log',
};

/** The link to a board's view: #/release-board/<slug>[/<view>[/<arg>]] (#/release-board: all of them). */
export function boardHref(slug, tab = '', arg = '') {
  if (!slug) return '#/release-board';
  return `#/release-board/${slug}${tab && tab !== 'overview' ? `/${tab}${arg ? `/${encodeURIComponent(arg)}` : ''}` : ''}`;
}

/** The boards known here, read again when the view opens and after each sync. */
export function useBoards() {
  const [, bump] = useState(0);
  useEffect(() => {
    const off = onBoards(() => bump((n) => n + 1));
    refreshBoards();
    return off;
  }, []);
  return cachedBoards();
}

function useNow(every = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

// Each board's filters and choices (features' filters, decisions shown, the timeline's zoom), kept
// while the app runs so going from view to view keeps them.
const viewStates = new Map();
function useViewState(slug, key) {
  const id = `${slug}:${key}`;
  const [value, setValue] = useState(() => viewStates.get(id));
  useEffect(() => setValue(viewStates.get(id)), [id]);
  return [
    value,
    (next) => {
      viewStates.set(id, next);
      setValue(next);
    },
  ];
}

// ---- Import --------------------------------------------------------------------------------------

function pickText(accept, onText) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) onText(await file.text(), file.name);
  });
  input.click();
}

function ImportCard({ projects, project: fixed, actions, onDone }) {
  const [project, setProject] = useState(fixed ?? '');
  const [busy, setBusy] = useState(false);
  const run = () =>
    pickText('.html,.htm,.js,.json,text/html,application/json,text/javascript', async (text, fileName) => {
      setBusy(true);
      try {
        const { slug, project: name, counts } = await importBoardFile(text, project);
        actions.toast(`Imported ${fileName} into ${name}'s release board: ${counts.releases} releases, ${counts.features} features, ${counts.tests} tests, ${counts.decisions} decisions.`);
        onDone?.(slug);
      } catch (err) {
        actions.toast(err.message, { kind: 'error' });
      } finally {
        setBusy(false);
      }
    });
  return html`<section class="rb-panel rb-pad rb-import">
    <h3>${fixed ? 'Import a newer board file' : 'Import a release board file'}</h3>
    <p class="muted small">The standalone page (.html), its data script (.js) or its JSON. Its releases, features, tests, decisions, sessions and log go into ${fixed ? 'this' : 'the project’s'} board; nothing on the board is deleted. Claude keeps it current from then on (update_board).</p>
    <div class="rb-import-row">
      ${!fixed && html`<label class="field rb-grow"><span>Project</span><input list="rb-projects" value=${project} placeholder="The project it belongs to" onInput=${(e) => setProject(e.currentTarget.value)} />
        <datalist id="rb-projects">${projects.map((p) => html`<option key=${p.key} value=${p.name} />`)}</datalist></label>`}
      <button type="button" class="btn ${fixed ? '' : 'primary'}" disabled=${busy || !project.trim()} onClick=${run}><${Icon} name="upload" size=${16} />${busy ? 'Importing…' : 'Choose the file…'}</button>
    </div>
  </section>`;
}

// ---- The view ----------------------------------------------------------------------------------

function BoardIndex({ slug, list, projects, actions, titles }) {
  return html`<div class="rb rb-index">
    ${slug && html`<div class="rb-panel rb-pad"><p>${list.length ? 'That release board is not here.' : 'Reading the release boards…'}</p></div>`}
    ${list.length > 0 && html`<div class="rb-section-title"><h2>Release boards</h2><span class="sub">one per project; Claude keeps them current</span></div>
      <div class="rb-cards">${list.map((b) => {
        const kept = cachedBoard(b.slug);
        const updated = kept ? boardUpdated(kept) : null;
        return html`<a key=${b.slug} class="rb-panel rb-dcard rb-board-link" href=${boardHref(b.slug)}>
          <div class="rb-top-line"><b>${b.project}</b><${Icon} name="rocket" size=${16} /></div>
          ${kept?.now?.headline && html`<div class="rb-desc"><${BoardText} text=${kept.now.headline} titles=${titles} /></div>`}
          ${updated?.at && html`<div class="small muted">Updated ${boardStamp(updated.at)}${updated.by ? ` by ${updated.by}` : ''}</div>`}
        </a>`;
      })}</div>`}
    <${ImportCard} projects=${projects} actions=${actions} onDone=${(s) => (location.hash = boardHref(s))} />
  </div>`;
}

function BoardSearch({ value, onChange }) {
  return html`<div class="search rb-search ${value ? 'has-query' : ''}">
    <${Icon} name="search" size=${16} />
    <input type="search" value=${value} placeholder="Search the board" aria-label="Search the board" autocomplete="off"
      onInput=${(e) => onChange(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Escape' && value && (e.preventDefault(), e.stopPropagation(), onChange(''))} />
    ${value && html`<button type="button" class="icon-btn sm" aria-label="Clear the search" onClick=${() => onChange('')}><${Icon} name="x" size=${15} /></button>`}
  </div>`;
}

export function ReleaseBoardView({ slug, tab = '', arg = '', items, projects, actions }) {
  const list = useBoards();
  const now = useNow();
  const board = slug ? cachedBoard(slug) : null;
  const titles = useMemo(() => new Map(items.map((i) => [i.id, i.title])), [items]);
  const [stack, setStack] = useState([]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const root = useRef(null);
  const [features, setFeatures] = useViewState(slug, 'features');
  const [decisions, setDecisions] = useViewState(slug, 'decisions');
  const [timeline, setTimeline] = useViewState(slug, 'timeline');
  const view = BOARD_TABS[tab] ? tab : 'overview';
  useEffect(() => {
    setStack([]);
    setQuery('');
    setSearched('');
  }, [slug]);
  // Typing searches a moment later; a view picked clears it.
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setQuery('');
    setSearched('');
    root.current?.closest('.content')?.scrollTo?.({ top: 0 });
  }, [view]);
  // #/release-board/<slug>/features/missing: the features not live yet.
  useEffect(() => {
    if (view === 'features' && arg === 'missing') setFeatures({ ...features, missing: true });
  }, [view, arg]);
  const open = stack.at(-1);
  const onOpen = (target, { replace = false } = {}) => setStack((s) => (replace ? [...s.slice(0, -1), target] : [...s, target]));
  const color = projects.find((p) => p.key === board?.project?.toLowerCase())?.color;

  if (!slug || !board) return html`<${BoardIndex} slug=${slug} list=${list} projects=${projects} actions=${actions} titles=${titles} />`;

  const tabs = boardTabs(board);
  const shownTabs = tabs.includes(view) ? tabs : [...tabs, view];
  const href = (t, a) => boardHref(slug, t, a);
  const updated = boardUpdated(board);
  const download = async () => {
    try {
      const { name, text } = exportBoardFile(slug);
      await saveToDevice(name, new Blob([text], { type: 'text/javascript' }));
    } catch (err) {
      actions.toast(err.message, { kind: 'error' });
    }
  };
  const common = { board, titles, onOpen, now };
  let body;
  if (searched) body = html`<${SearchView} ...${common} query=${searched} />`;
  else if (view === 'timeline') body = html`<${TimelineView} ...${common} state=${timeline} setState=${setTimeline} />`;
  else if (view === 'releases') body = html`<${ReleasesView} ...${common} />`;
  else if (view === 'features') body = html`<${FeaturesView} ...${common} state=${features} setState=${setFeatures} />`;
  else if (view === 'tests') body = html`<${TestsView} ...${common} />`;
  else if (view === 'decisions') body = html`<${DecisionsView} ...${common} state=${decisions} setState=${setDecisions} />`;
  else if (view === 'commands') body = html`<${CommandsView} ...${common} />`;
  else if (view === 'log') body = html`<${LogView} ...${common} slug=${slug} />`;
  else body = html`<${Overview} ...${common} tabs=${tabs} href=${href} />`;
  return html`<div class="rb" ref=${root} style=${color ? `--rb-hero: ${color}` : ''}>
    <div class="rb-head">
      <div class="rb-head-title"><${Icon} name="rocket" size=${18} /><span>${board.project}</span>
        ${updated.at && html`<span class="rb-updated">Updated ${boardStamp(updated.at)}${updated.by ? ` by ${updated.by}` : ''}</span>`}</div>
      <div class="rb-head-tools">
        <${BoardSearch} value=${query} onChange=${setQuery} />
        <button type="button" class="btn sm" title="The board as its standalone page's data file" onClick=${download}><${Icon} name="download" size=${15} />Data file</button>
      </div>
    </div>
    <nav class="rb-tabs" aria-label="Board views">${shownTabs.map((t) => html`<a key=${t} href=${href(t)} class=${!searched && t === view ? 'on' : ''} aria-current=${!searched && t === view ? 'page' : undefined}
      onClick=${() => t === view && (setQuery(''), setSearched(''))}>${BOARD_TABS[t]}</a>`)}</nav>
    ${body}
    ${view === 'overview' && !searched && html`<${ImportCard} projects=${projects} project=${board.project} actions=${actions} />`}
    ${open && html`<${Drawer} key=${`${open.type}:${open.id}`} board=${board} open=${open} onOpen=${onOpen} titles=${titles} canBack=${stack.length > 1}
      onBack=${() => setStack((s) => s.slice(0, -1))} onClose=${() => setStack([])} />`}
  </div>`;
}
