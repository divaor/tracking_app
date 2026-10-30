import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import {
  addCommentPatch,
  deleteCommentPatch,
  editCommentPatch,
  filterItems,
  localDate,
  matchesScope,
  parseQuickAdd,
  projectList,
  restoreCommentPatch,
  searchWordsOf,
  statusLabel,
  STATUSES,
  tagCounts,
  titleFromMarkdown,
  TYPE_IDS,
  TYPES,
  typeInfo,
} from './model.js';
import { store } from './store.js';
import { getSettings, isLocal, isSyncConfigured, onSettings, saveSettings } from './settings.js';
import { appendToNotes, refinement } from './assist.js';
import { modelReady, readQuickAdd } from './assistant.js';
import { getSyncState, movedTo, onSyncState, syncNow } from './syncManager.js';
import { setNotificationHandlers } from './notifier.js';
import { Icon } from './ui/icons.js';
import { ProjectsContext, SearchContext, SyncBadge, Toasts } from './ui/components.js';
import { ProjectsView, ScopeBar } from './ui/projects.js';
import { BoardView, HomeView, ListView } from './ui/views.js';
import { ItemModal } from './ui/itemModal.js';
import { ItemWindow, WindowDock } from './ui/itemWindows.js';
import { clampRect, fullRect, nextRect, tileRects } from './windowLayout.js';
import { appItemLink, idFromFragment, itemIdIn, WEB_APP_URL } from './itemLinks.js';
import { HelpDialog } from './ui/help.js';
import { makePlan, usePlanAuto } from './ui/plans.js';
import { DaysView } from './ui/days.js';
import { ListenBar, setListenNotice } from './ui/listen.js';
import { stopReading, toggleReading } from './reader.js';
import { cachedPlans } from './planStore.js';
import { SettingsView } from './ui/settingsView.js';

const VIEWS = ['home', 'board', 'list', 'days', 'projects', 'settings'];

function parseHash() {
  const [view, type, status] = location.hash.replace(/^#\/?/, '').split('/');
  return {
    view: VIEWS.includes(view) ? view : 'home',
    type: TYPE_IDS.includes(type) ? type : 'all',
    status: STATUSES.includes(status) ? status : 'all',
    // Days: #/days/2026-10-28 (none: today).
    day: view === 'days' && /^\d{4}-\d{2}-\d{2}$/.test(type ?? '') ? type : '',
  };
}

export function hrefFor({ view, type = 'all', status = 'all', day = '' }) {
  if (view === 'days') return day ? `#/days/${day}` : '#/days';
  const parts = [view];
  if (type !== 'all' || status !== 'all') parts.push(type);
  if (status !== 'all') parts.push(status);
  return `#/${parts.join('/')}`;
}

function viewTitle(route) {
  const typeName = route.type === 'all' ? '' : typeInfo(route.type).plural;
  switch (route.view) {
    case 'board':
      return typeName ? `Board · ${typeName}` : 'Board';
    case 'list': {
      const base = typeName || 'All items';
      return route.status === 'all' ? base : `${base} · ${statusLabel(route.status, route.type)}`;
    }
    case 'settings':
      return 'Settings';
    case 'projects':
      return 'Projects & tags';
    case 'days':
      return 'Days';
    default:
      return 'Overview';
  }
}

// Links like #/item/<id> (used in the connector's replies) open that item.
function takeItemLink() {
  const match = /^#\/item\/([^/?#]+)/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, '', '#/');
  return decodeURIComponent(match[1]);
}

const isTyping = (el) => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
const TEXT_FILE = /\.(md|markdown|mdx|txt)$/i;

/** Asks for files (the same kinds as a drop on the window) and hands them to `onFiles`. */
function pickFiles(onFiles) {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.md,.markdown,.mdx,.txt,text/*' });
  input.addEventListener('change', () => input.files.length && onFiles([...input.files]));
  input.click();
}

/** Scrolls to the element with this id once the view that has it is shown (up to a second). */
function scrollToWhenShown(id, tries = 60) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  else if (tries > 0) requestAnimationFrame(() => scrollToWhenShown(id, tries - 1));
}

// The sidebar's projects and tags: the first ones, or all of them (setting `sidebarAll`).
const SIDEBAR_FIRST = 12;
function MoreToggle({ list, part }) {
  const all = getSettings().sidebarAll ?? {};
  if (list.length <= SIDEBAR_FIRST) return null;
  return html`<button type="button" class="nav-more" aria-expanded=${Boolean(all[part])} onClick=${() => saveSettings({ sidebarAll: { ...all, [part]: !all[part] } })}>
    ${all[part] ? 'Fewer' : `${list.length - SIDEBAR_FIRST} more`}</button>`;
}
const firstOf = (list, part) => (getSettings().sidebarAll?.[part] ? list : list.slice(0, SIDEBAR_FIRST));

function Sidebar({ route, items, projects, scope, query, onProject, onTag, sync, onSyncClick, onNew, onHelp }) {
  const open = items.filter((i) => i.status !== 'done');
  const allTags = tagCounts(items);
  const tags = firstOf(allTags, 'tags');
  const tagOn = (tag) => query.toLowerCase().split(/\s+/).includes(`#${tag.toLowerCase()}`);
  const link = (target, label, icon, count, extraClass = '') => {
    const active = route.view === target.view && (target.type ?? 'all') === route.type;
    return html`<a href=${hrefFor(target)} class="nav-link ${active ? 'active' : ''} ${extraClass}" aria-current=${active ? 'page' : undefined}>
      <${Icon} name=${icon} size=${18} /><span>${label}</span>${count != null && html`<span class="count">${count}</span>`}
    </a>`;
  };
  const categoryView = route.view === 'board' ? 'board' : 'list';
  return html`<aside class="sidebar" aria-label="Navigation">
    <div class="brand"><img src="icons/icon.svg" alt="" width="28" height="28" /><span>Tracker</span></div>
    <button type="button" class="btn primary new-btn" onClick=${onNew}><${Icon} name="plus" />New item</button>
    <nav>
      ${link({ view: 'home' }, 'Overview', 'home')}
      ${link({ view: 'board' }, 'Board', 'board')}
      ${link({ view: 'list' }, 'All items', 'list', open.length)}
      ${link({ view: 'days' }, 'Days', 'calendar')}
      <div class="nav-section">Categories</div>
      ${TYPES.map((t) => link({ view: categoryView, type: t.id }, t.plural, t.id, open.filter((i) => i.type === t.id).length, `type-${t.id}`))}
      <div class="nav-section nav-section-row">Projects<a href="#/projects" class="nav-manage" title="Manage projects and tags">Manage</a></div>
      ${firstOf(projects, 'projects').map((p) => {
        const active = scope.length === 1 && scope[0] === `project:${p.key}`;
        return html`<button type="button" key=${p.key} class="nav-link nav-project ${active ? 'active' : ''}" style=${{ '--pc': p.color }}
          onClick=${() => onProject(p.key)}><span class="project-dot" /><span class="nav-label">${p.name}</span><span class="count">${p.open}</span></button>`;
      })}
      <${MoreToggle} list=${projects} part="projects" />
      ${!projects.length && html`<a href="#/projects" class="nav-link muted-link"><${Icon} name="plus" size=${16} /><span>Add a project</span></a>`}
      ${tags.length > 0 &&
      html`<div class="nav-section">Tags</div>
        <div class="nav-tags">
          ${tags.map((t) => html`<button type="button" class="tag ${tagOn(t.tag) ? 'on' : ''}" key=${t.tag} aria-pressed=${tagOn(t.tag)} onClick=${() => onTag(t.tag)}>#${t.tag}<span>${t.count}</span></button>`)}
          <${MoreToggle} list=${allTags} part="tags" />
        </div>`}
      <div class="nav-section"></div>
      ${link({ view: 'settings' }, 'Settings', 'settings')}
      <button type="button" class="nav-link" title="Commands, shortcuts and the guide (F1)" onClick=${onHelp}><${Icon} name="help" size=${18} /><span>Help</span><kbd class="nav-key">F1</kbd></button>
    </nav>
    <div class="sidebar-foot"><${SyncBadge} sync=${sync} onClick=${onSyncClick} /></div>
  </aside>`;
}

function BottomNav({ route, onNew }) {
  const tab = (view, label, icon) =>
    html`<a href=${hrefFor({ view, type: view === 'board' || view === 'list' ? route.type : 'all' })}
      class=${route.view === view ? 'active' : ''} aria-current=${route.view === view ? 'page' : undefined}>
      <${Icon} name=${icon} size=${22} /><span>${label}</span>
    </a>`;
  return html`<nav class="bottom-nav" aria-label="Main">
    ${tab('home', 'Home', 'home')}
    ${tab('board', 'Board', 'board')}
    <button type="button" class="fab" aria-label="New item" onClick=${onNew}><${Icon} name="plus" size=${26} /></button>
    ${tab('list', 'Items', 'list')}
    ${tab('settings', 'Settings', 'settings')}
  </nav>`;
}

let toastSeq = 0;
let windowSeq = 0;
let stackSeq = 0;

// Item windows share the space under the top bar, less the bar of windows at the bottom.
const DOCK_SPACE = 56;
function windowArea() {
  const box = document.querySelector('.content')?.getBoundingClientRect();
  const area = box ? { x: box.left, y: box.top, w: box.width, h: box.height } : { x: 0, y: 0, w: innerWidth, h: innerHeight };
  return { ...area, h: Math.max(240, area.h - DOCK_SPACE) };
}
// On a phone (and in a narrow window) items open as before, one at a time.
const narrowScreen = () => matchMedia('(max-width: 860px)').matches;
// A browser on a computer, where the desktop app can take item links (tracker-app://).
const desktopBrowser = () => !window.desktop && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
/** The item a link in the page points to, when it points into this app: '#/item/<id>' here, the web app's address, or tracker-app://. */
function linkedItemOf(href) {
  const id = itemIdIn(href);
  if (!id) return null;
  try {
    const url = new URL(href, location.href);
    const ours = url.protocol === 'tracker-app:' || url.origin === location.origin || url.href.startsWith(WEB_APP_URL);
    return ours ? id : null;
  } catch {
    return null;
  }
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  const [items, setItems] = useState(store.visible());
  const [projectRecords, setProjectRecords] = useState(store.projects());
  const [sync, setSync] = useState(getSyncState());
  const [settings, setSettingsState] = useState(getSettings());
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [drawer, setDrawer] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [, setTick] = useState(0);
  const [linkedItem, setLinkedItem] = useState(takeItemLink);
  const [help, setHelp] = useState(null); // { tab, query }
  // Item windows: [{ wid, id, x, y, w, h, z, min, max, restore, scroll }], in the order they were
  // opened (the page keeps that order, so their previews do not reload); `z` stacks them.
  const [windows, setWindows] = useState([]);
  const windowsRef = useRef(windows);
  const searchRef = useRef(null);
  const modalRef = useRef(null);
  const helpRef = useRef(null);
  // The modal and Help each get a history entry, so the phone's back button closes
  // the one on top; `layers` is the order they were opened in.
  const layers = useRef([]);
  const contentRef = useRef(null);
  const today = localDate();

  useEffect(
    () =>
      store.subscribe(() => {
        setItems(store.visible());
        setProjectRecords(store.projects());
      }),
    [],
  );
  useEffect(() => onSyncState(() => setSync(getSyncState())), []);
  useEffect(() => onSettings((s) => setSettingsState(s)), []);
  useEffect(() => {
    const onHash = () => {
      const linked = takeItemLink();
      if (linked) setLinkedItem(linked);
      setRoute(parseHash());
      setDrawer(false);
      contentRef.current?.scrollTo?.(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const openModal = (next) => {
    if (!modalRef.current) history.pushState({ trackerModal: true }, ''), layers.current.push('modal');
    modalRef.current = next;
    setModal(next);
  };
  /** Steps back past the history entry of what just closed; `then` runs once that is done, so navigating in it is not undone by the step back. */
  const stepBack = (isOurs, then) => {
    if (!isOurs) return then?.();
    if (then) {
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        window.removeEventListener('popstate', go);
        then();
      };
      window.addEventListener('popstate', go);
      setTimeout(go, 500);
    }
    history.back();
  };
  const closeModal = (then) => {
    if (!modalRef.current) return then?.();
    modalRef.current = null;
    setModal(null);
    layers.current = layers.current.filter((l) => l !== 'modal');
    stepBack(history.state?.trackerModal, then);
  };
  const openHelp = (tab = 'commands', query = '') => {
    if (!helpRef.current) history.pushState({ trackerHelp: true }, ''), layers.current.push('help');
    helpRef.current = { tab, query };
    setHelp(helpRef.current);
  };
  const closeHelp = (then) => {
    if (!helpRef.current) return then?.();
    helpRef.current = null;
    setHelp(null);
    layers.current = layers.current.filter((l) => l !== 'help');
    stepBack(history.state?.trackerHelp, then);
  };
  useEffect(() => {
    const layerOf = (state) => (state?.trackerHelp ? 'help' : state?.trackerModal ? 'modal' : null);
    const onPop = () => {
      // Whatever was opened after the entry we are back on closes.
      const keep = layers.current.lastIndexOf(layerOf(history.state)) + 1;
      for (const layer of layers.current.splice(keep)) {
        if (layer === 'help') (helpRef.current = null), setHelp(null);
        else (modalRef.current = null), setModal(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!linkedItem) return undefined;
    if (store.get(linkedItem)) {
      setLinkedItem(null);
      if (!modalRef.current) openModal({ id: linkedItem });
      return undefined;
    }
    // Not here yet (e.g. Claude just added it): sync, then give up quietly.
    let cancelled = false;
    syncNow().then(() => {
      if (cancelled || store.get(linkedItem)) return;
      setLinkedItem(null);
      // A browser that does not sync (most likely not where the data is): the desktop app may have it.
      if (desktopBrowser() && isLocal()) offerDesktopApp(linkedItem);
      else toast(isLocal() ? 'That item is not on this device.' : 'That item is not on this device. Check that GitHub sync is set up.', { kind: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [items, linkedItem]);

  // Notifications: toasts for changes that arrive while the app is open, and
  // messages from the service worker when a push arrives or is tapped.
  useEffect(() => {
    setNotificationHandlers({ toast: (message, opts) => toastRef.current(message, opts), open: (id) => setLinkedItem(id) });
    const onMessage = (e) => {
      if (e.data?.type === 'tracker:changed') syncNow();
      if (e.data?.type === 'tracker:open') {
        const hash = new URL(e.data.url).hash;
        if (hash) location.hash = hash;
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []);

  /**
   * A link to an item this browser does not have (Claude's links open in the browser): the desktop
   * app on this computer can open it (tracker-app://). Once that was chosen, it goes there at once.
   */
  const offerDesktopApp = (id) => {
    const inApp = () => (location.href = appItemLink(id));
    if (getSettings().openItemsInApp) {
      inApp();
      toast('Opened in the Tracker app: that item is not in this browser.', { duration: 15000, action: { label: 'Open again', run: inApp } });
      return;
    }
    toast('That item is not in this browser. Open it in the Tracker app on this computer?', {
      duration: 30000,
      action: {
        label: 'Open in the app',
        run: () => {
          saveSettings({ openItemsInApp: true });
          inApp();
        },
      },
    });
  };

  const dismissToast = (id) => setToasts((list) => list.filter((t) => t.id !== id));
  const toast = (message, opts = {}) => {
    const id = ++toastSeq;
    setToasts((list) => [...list.slice(-2), { id, message, ...opts }]);
    setTimeout(() => dismissToast(id), opts.duration ?? 4500);
  };
  const toastRef = useRef(toast);
  toastRef.current = toast;
  setListenNotice((message) => toastRef.current(message, { kind: 'error' }));
  // Local mode, and Tracker Editor moved the data on this device to GitHub: offer to follow it.
  useEffect(() => {
    movedTo().then(
      (to) =>
        to &&
        toastRef.current(`Your data moved to GitHub (${to.owner}/${to.repo}). Connect here too, with the same token, to keep working on it.`, {
          duration: 30000,
          action: {
            label: 'Connect',
            run: () => {
              saveSettings({ owner: to.owner, repo: to.repo, branch: to.branch ?? '', path: to.path || 'tracker.json' });
              location.hash = '#/settings';
            },
          },
        }),
    );
  }, []);

  const navigate = (patch) => {
    location.hash = hrefFor({ ...route, ...patch });
  };
  const defaultType = route.type === 'all' ? 'task' : route.type;

  // Projects: the scope filter (per device) and the project list with colors.
  const scope = settings.projectScope ?? [];
  const setScope = (next) => saveSettings({ projectScope: next });
  const projects = useMemo(() => projectList(items, projectRecords), [items, projectRecords]);
  const byKey = useMemo(() => new Map(projects.map((p) => [p.key, p])), [projects]);
  const scopedItems = useMemo(() => items.filter((i) => matchesScope(i, scope, byKey)), [items, scope, byKey]);
  // Today's plan made and updated by itself (setting `planAuto`).
  usePlanAuto({ items: scopedItems, today, on: Boolean(settings.planAuto) });
  // Viewing a single project: new items go into it.
  const defaultProject = scope.length === 1 && scope[0].startsWith('project:') ? (byKey.get(scope[0].slice(8))?.name ?? '') : '';

  const updateWindows = (fn) => {
    windowsRef.current = fn(windowsRef.current);
    setWindows(windowsRef.current);
  };
  const patchWindow = (wid, patch) => updateWindows((list) => list.map((w) => (w.wid === wid ? { ...w, ...patch } : w)));
  const frontWindow = (list = windowsRef.current) => list.filter((w) => !w.min).reduce((top, w) => (!top || w.z > top.z ? w : top), null);
  const windowActions = {
    /** Opens an item in a window of its own (again for an item already open: another view of it). */
    open(item, { scroll = 0, find = '' } = {}) {
      if (narrowScreen()) return openModal({ id: item.id, find });
      const size = { w: item.type === 'doc' ? 760 : 580, h: 700 };
      const place = nextRect(windowsRef.current, windowArea(), size);
      updateWindows((list) => [...list, { wid: ++windowSeq, id: item.id, ...place, z: ++stackSeq, min: false, max: false, restore: null, scroll, find }]);
    },
    focus(wid) {
      const win = windowsRef.current.find((w) => w.wid === wid);
      if (win && (win.min || frontWindow() !== win)) patchWindow(wid, { z: ++stackSeq, min: false });
    },
    close: (wid) => updateWindows((list) => list.filter((w) => w.wid !== wid)),
    minimize: (wid) => patchWindow(wid, { min: true }),
    toggleMax(wid) {
      const win = windowsRef.current.find((w) => w.wid === wid);
      if (!win) return;
      if (win.max) patchWindow(wid, { ...(win.restore ?? {}), max: false, restore: null });
      else patchWindow(wid, { ...fullRect(windowArea()), max: true, restore: { x: win.x, y: win.y, w: win.w, h: win.h }, z: ++stackSeq });
    },
    /** The dock's button: a minimized window comes back, the front one is minimized, another comes to the front. */
    pick(win) {
      if (!win.min && frontWindow() === win) windowActions.minimize(win.wid);
      else windowActions.focus(win.wid);
    },
    /** The windows shown, side by side in the order they are on screen from left to right. */
    tile() {
      const shown = windowsRef.current.filter((w) => !w.min).sort((a, b) => a.x - b.x || a.y - b.y);
      const rects = tileRects(shown.length, windowArea());
      const placed = new Map(shown.map((w, i) => [w.wid, rects[i]]));
      updateWindows((list) => list.map((w) => (placed.has(w.wid) ? { ...w, ...placed.get(w.wid), max: false, restore: null } : w)));
    },
    minimizeAll: () => updateWindows((list) => list.map((w) => ({ ...w, min: true }))),
    closeAll: () => updateWindows(() => []),
  };

  const actions = {
    toast,
    /** Opens the item with this id (from a link or a pasted id); not here: syncs first, then says so. */
    openById(id, opts = {}) {
      const item = store.get(id);
      if (item) actions.open(item, opts);
      else setLinkedItem(id);
    },
    /**
     * Opens an item: in the dialog, or `{ window: true }` (Ctrl+click, middle-click) in a window of its own.
     * While searching, the item opens finding the words searched for.
     */
    open: (item, { window: inWindow = false } = {}) => {
      const find = searchWordsOf(query);
      return inWindow ? windowActions.open(item, { find }) : openModal({ id: item.id, find });
    },
    /** The dialog's item moves to a window at the side (the list stays free to open others), scrolled as it was. */
    popOut(item, { scroll = 0 } = {}) {
      if (narrowScreen()) return;
      closeModal();
      windowActions.open(item, { scroll });
    },
    newItem: (draft = {}) => openModal({ draft: { type: defaultType, project: defaultProject, ...draft } }),
    create(fields) {
      const item = store.add(fields);
      toast(`Added ${typeInfo(item.type).label.toLowerCase()} “${item.title}”`, {
        action: { label: 'Open', run: () => openModal({ id: item.id }) },
      });
      return item;
    },
    update: (id, patch) => store.update(id, patch),
    /** Pins an item (it comes first wherever it shows, by project), or unpins it. */
    togglePin(item) {
      const current = store.get(item.id);
      if (!current) return;
      const pinned = !current.pinned;
      store.update(item.id, { pinned });
      toast(pinned ? `Pinned “${current.title}”${current.project ? ` to the top of ${current.project}` : ' to the top'}` : `Unpinned “${current.title}”`, {
        action: { label: 'Undo', run: () => store.update(item.id, { pinned: !pinned }) },
      });
    },
    setStatus(id, status) {
      const prev = store.get(id);
      if (!prev || prev.status === status) return;
      store.update(id, { status });
      if (status === 'done') {
        toast(`“${prev.title}” marked as ${statusLabel('done', prev.type).toLowerCase()}`, {
          action: { label: 'Undo', run: () => store.update(id, { status: prev.status }) },
        });
      }
    },
    cycleStatus: (item, next) => actions.setStatus(item.id, next),
    remove(id) {
      const prev = store.remove(id);
      if (prev) toast(`Deleted “${prev.title}”`, { action: { label: 'Undo', run: () => store.restore(prev) } });
    },
    quickAdd(text, defaults = {}) {
      const fields = parseQuickAdd(text, today, projects.map((p) => p.name));
      if (!fields.title) return;
      const explicit = { project: defaultProject, ...defaults, ...fields };
      const item = actions.create(explicit);
      // With the model on, it reads the line too and fills in what was said in words.
      if (modelReady() && getSettings().smartAdd) actions.refineQuickAdd(item, text, explicit);
    },
    async refineQuickAdd(item, text, explicit) {
      const tags = tagCounts(items).map((t) => t.tag);
      let smart;
      try {
        smart = await readQuickAdd(text, { today, type: item.type, projects: projects.map((p) => p.name), tags });
      } catch (err) {
        toast(`The model could not read “${item.title}”: ${err.message}`, { kind: 'error' });
        return;
      }
      // Left alone when it was edited or deleted meanwhile.
      const now = store.get(item.id);
      if (!now || now.updatedAt !== item.updatedAt) return;
      const patch = refinement(explicit, smart);
      if (!Object.keys(patch).length) return;
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, now[k]]));
      store.update(item.id, patch);
      const said = [
        patch.title && `“${patch.title}”`,
        patch.due && `due ${patch.due}`,
        patch.priority,
        patch.project,
        patch.tags?.map((t) => `#${t}`).join(' '),
        patch.notes && 'notes',
      ].filter(Boolean);
      toast(`Filled in by the model: ${said.join(' · ')}`, { duration: 9000, action: { label: 'Undo', run: () => store.update(item.id, before) } });
    },
    /** Lines typed in the quick add window (desktop), waiting in the main process. */
    async takeQuickAdds() {
      const taken = (await window.desktop?.capture?.take?.().catch(() => [])) ?? [];
      for (const q of taken) actions.quickAdd(q.text, { type: q.type });
    },
    /** An answer from the model added at the end of an item's notes. */
    addToNotes(item, answer) {
      const prev = store.get(item.id)?.notes ?? '';
      store.update(item.id, { notes: appendToNotes(prev, answer) });
      toast('Added to the notes', { action: { label: 'Undo', run: () => store.update(item.id, { notes: prev }) } });
    },
    /** A drafted review as the document's feedback (still yours to edit and save). */
    useFeedback(item, text) {
      const prev = store.get(item.id)?.feedback ?? '';
      store.update(item.id, { feedback: text.trim() });
      toast('Saved as your feedback: edit it under Your review', { action: { label: 'Undo', run: () => store.update(item.id, { feedback: prev }) } });
    },
    /** A comment on an item, by this device: for Claude (it reads them through the connector), or a note to self. */
    addComment(item, body) {
      const current = store.get(item.id);
      if (!current || !body.trim()) return false;
      store.update(item.id, addCommentPatch(current, body, getSettings().device || 'You'));
      return true;
    },
    editComment(item, id, body) {
      const current = store.get(item.id);
      if (!current || !body.trim()) return false;
      store.update(item.id, editCommentPatch(current, id, body));
      return true;
    },
    deleteComment(item, id) {
      const current = store.get(item.id);
      const comment = current?.comments?.find((c) => c.id === id && !c.deleted);
      if (!comment) return;
      store.update(item.id, deleteCommentPatch(current, id));
      toast('Comment deleted', {
        action: { label: 'Undo', run: () => store.get(item.id) && store.update(item.id, restoreCommentPatch(store.get(item.id), comment)) },
      });
    },
    showProject(key) {
      setScope([`project:${key}`]);
      closeModal(() => (location.hash = hrefFor({ view: 'list' })));
    },
    searchTag(tag) {
      setQuery(`#${tag}`);
      closeModal(() => (location.hash = hrefFor({ view: 'list' })));
    },
  };
  // What Help (commands.js) and the desktop menu can run.
  const go = (target) => (location.hash = hrefFor(target));
  const commands = {
    'new-item': () => actions.newItem(),
    'new-task': () => actions.newItem({ type: 'task' }),
    'new-idea': () => actions.newItem({ type: 'idea' }),
    'new-claude': () => actions.newItem({ type: 'claude' }),
    'new-doc': () => actions.newItem({ type: 'doc' }),
    'import-docs': () => pickFiles(importFiles),
    'quick-add-window': () => window.desktop?.capture?.open?.(),
    'quick-adds': () => actions.takeQuickAdds(),
    sync: () => syncNow(),
    'go-home': () => go({ view: 'home' }),
    'go-board': () => go({ view: 'board' }),
    'go-list': () => go({ view: 'list' }),
    'go-tasks': () => go({ view: 'list', type: 'task' }),
    'go-ideas': () => go({ view: 'list', type: 'idea' }),
    'go-claude': () => go({ view: 'list', type: 'claude' }),
    'go-docs': () => go({ view: 'list', type: 'doc' }),
    'go-projects': () => go({ view: 'projects' }),
    'go-days': () => go({ view: 'days' }),
    'item-listen': () => (modalRef.current || document.activeElement?.closest?.('.item-window') ? window.dispatchEvent(new Event('item:listen')) : toast('Open an item, then Listen (L) reads it to you.')),
    'listen-pause': () => toggleReading(),
    'listen-stop': () => stopReading(),
    'listen-settings': () => (go({ view: 'settings' }), scrollToWhenShown('read-aloud')),
    settings: () => go({ view: 'settings' }),
    search: () => searchRef.current?.focus(),
    'clear-search': () => setQuery(''),
    'scope-all': () => setScope([]),
    'scope-work': () => setScope(['area:work']),
    'scope-personal': () => setScope(['area:personal']),
    'plan-day': () => actions.plan('day'),
    'plan-week': () => actions.plan('week'),
    'model-settings': () => (go({ view: 'settings' }), scrollToWhenShown('model')),
    'pinned-past-filters': () => {
      const on = !getSettings().pinnedPastFilters;
      saveSettings({ pinnedPastFilters: on });
      toast(on ? 'Pinned items now show whatever the filters' : 'The filters now apply to pinned items too');
    },
    'windows-tile': () => windowActions.tile(),
    'windows-minimize': () => windowActions.minimizeAll(),
    'windows-close': () => windowActions.closeAll(),
    help: () => openHelp('commands'),
    'help-guide': () => openHelp('guide'),
    theme: () => {
      const next = { system: 'light', light: 'dark', dark: 'system' }[getSettings().theme] ?? 'system';
      saveSettings({ theme: next });
      toast(`Theme: ${next === 'system' ? 'as the system' : next}`);
    },
  };
  actions.command = (id) => commands[id]?.();
  actions.help = openHelp;
  actions.plan = (kind) => {
    if (!modelReady()) {
      toast('Connect a model first: Settings → Model', { action: { label: 'Settings', run: () => commands['model-settings']() } });
      return;
    }
    if (!scopedItems.length) return toast('Nothing to plan yet: add some items first');
    go({ view: 'home' });
    makePlan(kind, { items: scopedItems, today, update: Boolean(cachedPlans(today)?.[kind]) });
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const onSyncClick = () => {
    if (sync.phase === 'disabled' || sync.phase === 'error') location.hash = '#/settings';
    else syncNow();
  };

  const importFiles = async (files) => {
    const textFiles = files.filter((f) => TEXT_FILE.test(f.name) || f.type.startsWith('text/'));
    if (!textFiles.length) {
      toast('Only Markdown or text files can be added', { kind: 'error' });
      return;
    }
    const docs = await Promise.all(
      textFiles.map(async (file) => {
        const content = await file.text();
        return {
          type: 'doc',
          kind: /readme/i.test(file.name) ? 'readme' : '',
          title: titleFromMarkdown(content, file.name.replace(/\.[^.]+$/, '')),
          notes: content,
        };
      }),
    );
    if (docs.length === 1 && !modalRef.current) {
      openModal({ draft: docs[0] });
    } else {
      for (const doc of docs) store.add(doc);
      toast(`Added ${docs.length} documents to your reading list`);
    }
  };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setFileDrag(true);
    };
    // Over an open item, files attach to it (ItemPanel's own drop): this overlay stands back.
    const overItem = (e) => Boolean(e.target?.closest?.('.modal:not(.new-item), .item-window'));
    const over = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setFileDrag(!overItem(e));
    };
    const leave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setFileDrag(false);
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      depth = 0;
      setFileDrag(false);
      // An item took them (attached).
      if (e.defaultPrevented) return;
      e.preventDefault();
      importFiles([...e.dataTransfer.files]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        actionsRef.current.help();
        return;
      }
      if (modalRef.current || helpRef.current) return;
      if (e.key === 'Escape' && e.target === searchRef.current) {
        setQuery('');
        e.target.blur();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        actionsRef.current.newItem();
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === '?') {
        e.preventDefault();
        actionsRef.current.help();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Links to items anywhere in the page (notes, documents, the model's answers, ids made links) open them here;
  // Ctrl/Cmd+click or a middle click in a window.
  useEffect(() => {
    const onLink = (e) => {
      if (e.defaultPrevented || e.button > 1 || (e.type === 'click' && e.button !== 0) || (e.type === 'auxclick' && e.button !== 1)) return;
      const link = e.target.closest?.('a[href]');
      const id = link && linkedItemOf(link.getAttribute('href'));
      if (!id) return;
      e.preventDefault();
      actionsRef.current.openById(id, { window: e.ctrlKey || e.metaKey || e.button === 1 });
    };
    document.addEventListener('click', onLink, true);
    document.addEventListener('auxclick', onLink, true);
    return () => {
      document.removeEventListener('click', onLink, true);
      document.removeEventListener('auxclick', onLink, true);
    };
  }, []);
  // The desktop app opened from a tracker-app:// link (or one the main process kept for us).
  useEffect(() => window.desktop?.onOpenItem?.((id) => actionsRef.current.openById(id)), []);

  useEffect(
    () =>
      window.desktop?.onCommand?.((command) => {
        // The menu's Search (Ctrl+F) over an open item finds in it; New Item and Search do nothing over Help.
        if (command === 'search' && !helpRef.current && (modalRef.current || document.activeElement?.closest?.('.item-window'))) {
          window.dispatchEvent(new Event('item:find'));
          return;
        }
        if ((modalRef.current || helpRef.current) && ['new-item', 'search'].includes(command)) return;
        actionsRef.current.command(command);
      }),
    [],
  );
  // Lines typed in the quick add window while this one was closed or loading.
  useEffect(() => {
    actionsRef.current.takeQuickAdds();
  }, []);

  // Part of an id, pasted or followed by Enter: the one item whose id holds it (while typing, the list shows the matches).
  const fragmentItem = (value) => idFromFragment(value, items.map((i) => i.id));
  const onSearch = (value, { pasted = false } = {}) => {
    // A link to an item (Claude's, the desktop app's) or its id, pasted or typed: open that item.
    const linked = itemIdIn(value) ?? (pasted ? fragmentItem(value) : null);
    if (linked) {
      setQuery('');
      searchRef.current?.blur();
      actions.openById(linked);
      return;
    }
    setQuery(value);
    if (value && (route.view === 'home' || route.view === 'settings')) location.hash = hrefFor({ view: 'list' });
  };

  // With the setting on, pinned items stay in view past the type, status and #tag filters.
  const keepPinned = Boolean(settings.pinnedPastFilters);
  const filtered = useMemo(() => filterItems(scopedItems, { query, keepPinned }), [scopedItems, query, keepPinned]);
  const tagNames = useMemo(() => tagCounts(items).map((t) => t.tag), [items]);

  const modalItem = modal?.id ? items.find((i) => i.id === modal.id) : null;
  useEffect(() => {
    if (modal?.id && !modalItem) closeModal();
  }, [modal, modalItem]);
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Windows of items deleted (here or elsewhere) close.
  useEffect(() => {
    if (windows.some((w) => !itemsById.has(w.id))) updateWindows((list) => list.filter((w) => itemsById.has(w.id)));
  }, [itemsById]);
  // A smaller app window keeps every item window reachable.
  useEffect(() => {
    const onResize = () => {
      if (!windowsRef.current.length) return;
      const screen = { x: 0, y: 0, w: innerWidth, h: innerHeight };
      updateWindows((list) => list.map((w) => ({ ...w, ...clampRect(w, screen) })));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const front = frontWindow(windows);
  const stackOrder = [...windows].sort((a, b) => a.z - b.z).map((w) => w.wid);

  let view;
  if (route.view === 'board') {
    view = html`<${BoardView} items=${filtered} planItems=${scopedItems} type=${route.type} onType=${(type) => navigate({ type })} actions=${actions} today=${today} keepPinned=${keepPinned} />`;
  } else if (route.view === 'list') {
    view = html`<${ListView} items=${filtered} planItems=${scopedItems} type=${route.type} status=${route.status} query=${query} keepPinned=${keepPinned}
      onType=${(type) => navigate({ type })} onStatus=${(status) => navigate({ status })}
      sort=${settings.sort} onSort=${(sort) => saveSettings({ sort })} actions=${actions} today=${today} />`;
  } else if (route.view === 'days') {
    view = html`<${DaysView} items=${scopedItems} today=${today} day=${route.day} actions=${actions} />`;
  } else if (route.view === 'projects') {
    view = html`<${ProjectsView} items=${items} projects=${projects} actions=${actions} />`;
  } else if (route.view === 'settings') {
    view = html`<${SettingsView} sync=${sync} actions=${actions} items=${items} theme=${settings.theme}
      installPrompt=${installPrompt} onInstall=${async () => {
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => null);
        setInstallPrompt(null);
      }} />`;
  } else {
    view = html`<${HomeView} items=${scopedItems} today=${today} actions=${actions} hrefFor=${hrefFor} />`;
  }
  const scoped = ['home', 'board', 'list'].includes(route.view);

  return html`<${ProjectsContext.Provider} value=${{ byKey, showProject: actions.showProject, togglePin: actions.togglePin }}><${SearchContext.Provider} value=${query}><div class="app ${drawer ? 'drawer-open' : ''} ${windows.length ? 'has-windows' : ''}">
    <${Sidebar} route=${route} items=${scopedItems} projects=${projects} scope=${scope} query=${query} onProject=${actions.showProject}
      sync=${sync} onSyncClick=${onSyncClick} onNew=${() => actions.newItem()} onTag=${(tag) => actions.searchTag(tag)} onHelp=${() => openHelp()} />
    <div class="scrim" onClick=${() => setDrawer(false)} />
    <main class="main">
      <header class="topbar">
        <button type="button" class="icon-btn menu-btn" aria-label="Menu" onClick=${() => setDrawer(true)}><${Icon} name="menu" size=${22} /></button>
        <h1 class="view-title">${viewTitle(route)}</h1>
        <div class="search ${query ? 'has-query' : ''}">
          <${Icon} name="search" size=${17} />
          <input ref=${searchRef} type="search" value=${query} onInput=${(e) => onSearch(e.currentTarget.value, { pasted: e.inputType === 'insertFromPaste' })}
            onKeyDown=${(e) => e.key === 'Enter' && fragmentItem(query) && (e.preventDefault(), onSearch(query, { pasted: true }))}
            placeholder="Search…  ( / )" aria-label="Search" autocomplete="off" />
          ${query && html`<button type="button" class="icon-btn sm" aria-label="Clear search" onClick=${() => setQuery('')}><${Icon} name="x" size=${15} /></button>`}
        </div>
        <${SyncBadge} sync=${sync} onClick=${onSyncClick} compact />
      </header>
      ${query && route.view !== 'settings' &&
      html`<div class="search-banner">Showing matches for <strong>${query}</strong><button type="button" class="btn link" onClick=${() => setQuery('')}>Clear</button></div>`}
      ${!isLocal(settings) && !isSyncConfigured(settings) && items.length > 0 && route.view === 'home' &&
      html`<a class="sync-hint" href="#/settings"><${Icon} name="cloudOff" size=${16} />Items are only on this device. Set up GitHub sync to use them on your phone and other computers.</a>`}
      <div class="content" ref=${contentRef}>
        ${scoped && html`<${ScopeBar} scope=${scope} projects=${projects} onChange=${setScope} />`}
        ${view}
      </div>
    </main>
    <${BottomNav} route=${route} onNew=${() => actions.newItem()} />
    ${windows.map((win) => {
      const item = itemsById.get(win.id);
      return item && html`<${ItemWindow} key=${win.wid} win=${win} item=${item} z=${30 + Math.min(15, stackOrder.indexOf(win.wid))} front=${front?.wid === win.wid}
        actions=${actions} projects=${projects.map((p) => p.name)} tagSuggestions=${tagNames} today=${today}
        onChange=${(patch) => patchWindow(win.wid, patch)} onFocus=${() => windowActions.focus(win.wid)} onClose=${() => windowActions.close(win.wid)}
        onMinimize=${() => windowActions.minimize(win.wid)} onMaximize=${() => windowActions.toggleMax(win.wid)} />`;
    })}
    ${windows.length > 0 &&
    html`<${WindowDock} windows=${windows} items=${itemsById} front=${front?.wid} onPick=${windowActions.pick} onClose=${(w) => windowActions.close(w.wid)}
      onTile=${windowActions.tile} onMinimizeAll=${windowActions.minimizeAll} onCloseAll=${windowActions.closeAll} />`}
    ${modal && (modal.draft || modalItem) &&
    html`<${ItemModal} key=${modal.id ?? 'new'} item=${modalItem} initial=${modal.draft} find=${modal.find} actions=${actions}
      projects=${projects.map((p) => p.name)} tagSuggestions=${tagNames} today=${today} onClose=${() => closeModal()}
      onPopOut=${modalItem ? (from) => actions.popOut(modalItem, from) : undefined} />`}
    ${help &&
    html`<${HelpDialog} tab=${help.tab} query=${help.query} onTab=${(tab) => setHelp((helpRef.current = { ...help, tab }))} onClose=${() => closeHelp()}
      onRun=${modal ? null : (command) => closeHelp(() => actionsRef.current.command(command.id))} />`}
    <${ListenBar} />
    <${Toasts} toasts=${toasts} onDismiss=${dismissToast} />
    ${fileDrag &&
    html`<div class="drop-overlay"><div><${Icon} name="upload" size=${40} /><p>Drop Markdown files to add them to your reading list</p></div></div>`}
  </div></${SearchContext.Provider}></${ProjectsContext.Provider}>`;
}
