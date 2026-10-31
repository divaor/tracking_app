// A project's release board (#/release-board/<slug>[/<view>[/<arg>]]), from the board kept with the
// data (boards.js, boardStore.js), with the standalone page's views as tabs (boardViews.js: Overview,
// Timeline, Releases, Features, Tests, Decisions, Commands, Log; empty ones hidden) and its search.
// Records open in the drawer (boardDrawer.js). Claude keeps the board current (update_board); here a
// board file can be imported and the board downloaded as its page's data file. #/release-board
// lists the boards.
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { applyBoardChanges, boardQuietFor, boardTabs, boardTick, boardUpdated, changedSince, decideBoard, recordTitle } from '../boards.js';
import { boardSeenAt, cachedBoard, cachedBoards, changeBoard, exportBoardFile, importBoardFile, markBoardSeen, onBoards, refreshBoards } from '../boardStore.js';
import { saveToDevice } from '../saveFile.js';
import { getSettings } from '../settings.js';
import { Drawer } from './boardDrawer.js';
import { BoardEdit, BoardText, boardStamp, NewSince, untilText } from './boardParts.js';
import { ListenButton, sourceOf } from './listen.js';
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

/** Records that open in the drawer from a link (#/release-board/<slug>/<type>/<id>). */
export const DRAWER_TYPES = new Set(['release', 'feature', 'test', 'decision', 'event']);

/** The link to a board's view: #/release-board/<slug>[/<view>[/<arg>]] (#/release-board: all of them). */
export function boardHref(slug, tab = '', arg = '') {
  if (!slug) return '#/release-board';
  return `#/release-board/${slug}${tab && tab !== 'overview' ? `/${tab}${arg ? `/${encodeURIComponent(arg)}` : ''}` : ''}`;
}

const clip = (text, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * What the person changes on a board (ticks, decisions, comments), written at once (boardStore
 * changeBoard), each with a toast and Undo where it can be undone. Each returns whether it worked.
 */
export function boardEditor(slug, actions) {
  const fail = (err) => {
    actions.toast(err.message, { kind: 'error' });
    return false;
  };
  const edit = {
    device: getSettings().device || 'this device',
    async tick(target, done, label) {
      try {
        await changeBoard(slug, (b, who) => boardTick(b, target, done, who), `${done ? 'done' : 'not done'}: ${clip(label)}`);
        actions.toast(`${done ? 'Done' : 'Not done'}: ${clip(label, 80)}`, { action: { label: 'Undo', run: () => edit.tick(target, !done, label) } });
        return true;
      } catch (err) {
        return fail(err);
      }
    },
    async decide(id, choice, label) {
      try {
        await changeBoard(slug, (b, who) => decideBoard(b, id, choice, who), choice == null ? `${clip(label)} open again` : `decided ${clip(label)}`);
        actions.toast(choice == null ? `${label} is open again` : `Decided ${label}: ${clip(String(choice), 80)}`, choice == null ? {} : { action: { label: 'Undo', run: () => edit.decide(id, null, label) } });
        return true;
      } catch (err) {
        return fail(err);
      }
    },
    async comment(part, id, text, command = '') {
      try {
        await changeBoard(slug, (b, who) => applyBoardChanges(b, [{ part, id, comment: text, command }], who).board, `comment on ${id}`);
        actions.toast('Comment added: Claude sees it on its next look at the board');
        return true;
      } catch (err) {
        return fail(err);
      }
    },
    async uncomment(part, id, commentId) {
      try {
        await changeBoard(slug, (b, who) => applyBoardChanges(b, [{ part, id, uncomment: commentId }], who).board, `comment deleted on ${id}`);
        actions.toast('Comment deleted');
        return true;
      } catch (err) {
        return fail(err);
      }
    },
  };
  return edit;
}

const PART_WORD = { releases: 'Release', features: 'Feature', tests: 'Test', decisions: 'Decision', events: 'Event', actions: 'Waiting on you', sessions: 'Session', repos: 'Repo', briefs: 'Workstream', log: 'Log' };
const DRAWER_OF = { releases: 'release', features: 'feature', tests: 'test', decisions: 'decision', events: 'event' };

// What changed on the board since this device last looked (by others), newest first; a click opens it.
function SinceYouLooked({ changes, since, onOpen, onSeen }) {
  const shown = changes.slice(0, 6);
  return html`<section class="rb-panel rb-pad rb-since" aria-label="Changed since you last looked">
    <div class="rb-top-line"><b>${changes.length} change${changes.length === 1 ? '' : 's'} since you last looked</b><span class="muted small">${boardStamp(since)}</span></div>
    <ul class="rb-list">${shown.map(({ part, id, record }) => {
      const type = DRAWER_OF[part];
      const title = recordTitle(part, record) || id;
      return html`<li key=${`${part}:${id}`}><span class="rb-tag">${PART_WORD[part] ?? part}</span>
        ${type && !record.deleted ? html`<button type="button" class="link-btn" onClick=${() => onOpen({ type, id })}>${clip(title, 90)}</button>` : html`<span>${clip(title, 90)}${record.deleted ? ' (removed)' : ''}</span>`}
        <span class="muted small"> · ${record.updatedBy || 'someone'}</span></li>`;
    })}</ul>
    ${changes.length > shown.length && html`<div class="muted small">and ${changes.length - shown.length} more, marked on the board</div>`}
    <div class="rb-since-tools"><button type="button" class="btn sm" onClick=${onSeen}>Got it</button></div>
  </section>`;
}

// What a board's view does not read aloud: its head, tabs, the timeline, buttons and fields.
const BOARD_NOT_READ = '.rb-head, .rb-tabs, .rb-since, .rb-import, .rb-tl-wrap, .rb-tl-legend, .rb-filters, .rb-controls, .rb-comment-new, .rb-code, button, input, textarea, select, label';

/** The boards known here, read again when the view opens (unless `refresh` is false) and after each sync. */
export function useBoards(refresh = true) {
  const [, bump] = useState(0);
  useEffect(() => {
    const off = onBoards(() => bump((n) => n + 1));
    if (refresh) refreshBoards();
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
  const edit = useMemo(() => boardEditor(slug, actions), [slug]);
  // Since when this device had not looked (kept for this visit; leaving marks the board seen).
  const [since, setSince] = useState(() => boardSeenAt(slug));
  useEffect(() => {
    setSince(boardSeenAt(slug));
    return () => slug && markBoardSeen(slug);
  }, [slug]);
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
  // #/release-board/<slug>/<release|feature|test|decision|event>/<id> opens it in the drawer
  // (notifications, an item's links to the board).
  useEffect(() => {
    if (DRAWER_TYPES.has(tab) && arg) setStack([{ type: tab, id: arg }]);
  }, [slug, tab, arg]);
  // #/release-board/<slug>/features/missing: the features not live yet.
  useEffect(() => {
    if (view === 'features' && arg === 'missing') setFeatures({ ...features, missing: true });
  }, [view, arg]);
  const open = stack.at(-1);
  const onOpen = (target, { replace = false } = {}) => setStack((s) => (replace ? [...s.slice(0, -1), target] : [...s, target]));
  const color = projects.find((p) => p.key === board?.project?.toLowerCase())?.color;

  if (!slug || !board) return html`<${BoardIndex} slug=${slug} list=${list} projects=${projects} actions=${actions} titles=${titles} />`;

  const tabs = boardTabs(board);
  const device = getSettings().device || '';
  const changes = since ? changedSince(board, since).filter(({ record }) => record.updatedBy !== device) : [];
  const isNew = (record) => Boolean(since) && String(record?.updatedAt ?? '') > since && record?.updatedBy !== device;
  const quietHours = Number(getSettings().boardQuietHours ?? 48);
  const quiet = boardQuietFor(board, now);
  const seenNow = () => {
    markBoardSeen(slug);
    setSince(boardSeenAt(slug));
  };
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
  return html`<${BoardEdit.Provider} value=${edit}><${NewSince.Provider} value=${isNew}><div class="rb" ref=${root} style=${color ? `--rb-hero: ${color}` : ''}>
    <div class="rb-head">
      <div class="rb-head-title"><${Icon} name="rocket" size=${18} /><span>${board.project}</span>
        ${updated.at && html`<span class="rb-updated">Updated ${boardStamp(updated.at)}${updated.by ? ` by ${updated.by}` : ''}</span>`}
        ${quietHours > 0 && quiet != null && quiet > quietHours * 3600000 && html`<span class="rb-quiet" title="Settings → Appearance says when a board is quiet">No word for ${untilText(now - quiet, now).replace(/ ago$/, '')}</span>`}</div>
      <div class="rb-head-tools">
        <${BoardSearch} value=${query} onChange=${setQuery} />
        <${ListenButton} readKey=${`board:${slug}:${searched ? 'search' : view}`} name=${`${board.project}: ${searched ? 'search' : BOARD_TABS[view]}`} label=${false} className="icon-btn"
          source=${() => sourceOf(root.current, { scroller: root.current?.closest('.content') ?? undefined, notRead: BOARD_NOT_READ })} />
        <button type="button" class="btn sm" title="The board as its standalone page's data file" onClick=${download}><${Icon} name="download" size=${15} />Data file</button>
      </div>
    </div>
    <nav class="rb-tabs" aria-label="Board views">${shownTabs.map((t) => html`<a key=${t} href=${href(t)} class=${!searched && t === view ? 'on' : ''} aria-current=${!searched && t === view ? 'page' : undefined}
      onClick=${() => t === view && (setQuery(''), setSearched(''))}>${BOARD_TABS[t]}</a>`)}</nav>
    ${changes.length > 0 && !searched && html`<${SinceYouLooked} changes=${changes} since=${since} onOpen=${onOpen} onSeen=${seenNow} />`}
    ${body}
    ${view === 'overview' && !searched && html`<${ImportCard} projects=${projects} project=${board.project} actions=${actions} />`}
    ${open && html`<${Drawer} key=${`${open.type}:${open.id}`} board=${board} open=${open} onOpen=${onOpen} titles=${titles} canBack=${stack.length > 1}
      onBack=${() => setStack((s) => s.slice(0, -1))} onClose=${() => setStack([])} />`}
  </div></${NewSince.Provider}></${BoardEdit.Provider}>`;
}
