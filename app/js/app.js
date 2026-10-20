import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import {
  filterItems,
  localDate,
  matchesScope,
  parseQuickAdd,
  projectList,
  statusLabel,
  STATUSES,
  tagCounts,
  titleFromMarkdown,
  TYPE_IDS,
  TYPES,
  typeInfo,
} from './model.js';
import { store } from './store.js';
import { getSettings, isSyncConfigured, onSettings, saveSettings } from './settings.js';
import { getSyncState, onSyncState, syncNow } from './syncManager.js';
import { setNotificationHandlers } from './notifier.js';
import { Icon } from './ui/icons.js';
import { ProjectsContext, SyncBadge, Toasts } from './ui/components.js';
import { ProjectsView, ScopeBar } from './ui/projects.js';
import { BoardView, HomeView, ListView } from './ui/views.js';
import { ItemModal } from './ui/itemModal.js';
import { SettingsView } from './ui/settingsView.js';

const VIEWS = ['home', 'board', 'list', 'projects', 'settings'];

function parseHash() {
  const [view, type, status] = location.hash.replace(/^#\/?/, '').split('/');
  return {
    view: VIEWS.includes(view) ? view : 'home',
    type: TYPE_IDS.includes(type) ? type : 'all',
    status: STATUSES.includes(status) ? status : 'all',
  };
}

export function hrefFor({ view, type = 'all', status = 'all' }) {
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

function Sidebar({ route, items, projects, scope, onProject, onTag, sync, onSyncClick, onNew }) {
  const open = items.filter((i) => i.status !== 'done');
  const tags = tagCounts(items).slice(0, 12);
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
      <div class="nav-section">Categories</div>
      ${TYPES.map((t) => link({ view: categoryView, type: t.id }, t.plural, t.id, open.filter((i) => i.type === t.id).length, `type-${t.id}`))}
      <div class="nav-section nav-section-row">Projects<a href="#/projects" class="nav-manage" title="Manage projects and tags">Manage</a></div>
      ${projects.slice(0, 12).map((p) => {
        const active = scope.length === 1 && scope[0] === `project:${p.key}`;
        return html`<button type="button" key=${p.key} class="nav-link nav-project ${active ? 'active' : ''}" style=${{ '--pc': p.color }}
          onClick=${() => onProject(p.key)}><span class="project-dot" /><span class="nav-label">${p.name}</span><span class="count">${p.open}</span></button>`;
      })}
      ${!projects.length && html`<a href="#/projects" class="nav-link muted-link"><${Icon} name="plus" size=${16} /><span>Add a project</span></a>`}
      ${tags.length > 0 &&
      html`<div class="nav-section">Tags</div>
        <div class="nav-tags">${tags.map((t) => html`<button type="button" class="tag" key=${t.tag} onClick=${() => onTag(t.tag)}>#${t.tag}<span>${t.count}</span></button>`)}</div>`}
      <div class="nav-section"></div>
      ${link({ view: 'settings' }, 'Settings', 'settings')}
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
  const searchRef = useRef(null);
  const modalRef = useRef(null);
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

  // The modal gets its own history entry so the phone's back button closes it.
  const openModal = (next) => {
    if (!modalRef.current) history.pushState({ trackerModal: true }, '');
    modalRef.current = next;
    setModal(next);
  };
  const closeModal = () => {
    if (!modalRef.current) return;
    modalRef.current = null;
    setModal(null);
    if (history.state?.trackerModal) history.back();
  };
  useEffect(() => {
    const onPop = () => {
      if (modalRef.current) {
        modalRef.current = null;
        setModal(null);
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
      toast('That item is not on this device. Check that GitHub sync is set up.', { kind: 'error' });
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

  const dismissToast = (id) => setToasts((list) => list.filter((t) => t.id !== id));
  const toast = (message, opts = {}) => {
    const id = ++toastSeq;
    setToasts((list) => [...list.slice(-2), { id, message, ...opts }]);
    setTimeout(() => dismissToast(id), opts.duration ?? 4500);
  };
  const toastRef = useRef(toast);
  toastRef.current = toast;

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
  // Viewing a single project: new items go into it.
  const defaultProject = scope.length === 1 && scope[0].startsWith('project:') ? (byKey.get(scope[0].slice(8))?.name ?? '') : '';

  const actions = {
    toast,
    open: (item) => openModal({ id: item.id }),
    newItem: (draft = {}) => openModal({ draft: { type: defaultType, project: defaultProject, ...draft } }),
    create(fields) {
      const item = store.add(fields);
      toast(`Added ${typeInfo(item.type).label.toLowerCase()} “${item.title}”`, {
        action: { label: 'Open', run: () => openModal({ id: item.id }) },
      });
      return item;
    },
    update: (id, patch) => store.update(id, patch),
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
      if (fields.title) actions.create({ project: defaultProject, ...defaults, ...fields });
    },
    showProject(key) {
      closeModal();
      setScope([`project:${key}`]);
      location.hash = hrefFor({ view: 'list' });
    },
    searchTag(tag) {
      closeModal();
      setQuery(`#${tag}`);
      location.hash = hrefFor({ view: 'list' });
    },
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
    const over = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setFileDrag(false);
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setFileDrag(false);
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
      if (modalRef.current) return;
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
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(
    () =>
      window.desktop?.onCommand?.((command) => {
        if (command === 'new-item') actionsRef.current.newItem();
        else if (command === 'sync') syncNow();
        else if (command === 'settings') location.hash = '#/settings';
        else if (command === 'search') searchRef.current?.focus();
      }),
    [],
  );

  const onSearch = (value) => {
    setQuery(value);
    if (value && (route.view === 'home' || route.view === 'settings')) location.hash = hrefFor({ view: 'list' });
  };

  const filtered = useMemo(() => filterItems(scopedItems, { query }), [scopedItems, query]);
  const tagNames = useMemo(() => tagCounts(items).map((t) => t.tag), [items]);

  const modalItem = modal?.id ? items.find((i) => i.id === modal.id) : null;
  useEffect(() => {
    if (modal?.id && !modalItem) closeModal();
  }, [modal, modalItem]);

  let view;
  if (route.view === 'board') {
    view = html`<${BoardView} items=${filtered} type=${route.type} onType=${(type) => navigate({ type })} actions=${actions} today=${today} />`;
  } else if (route.view === 'list') {
    view = html`<${ListView} items=${filtered} type=${route.type} status=${route.status} query=${query}
      onType=${(type) => navigate({ type })} onStatus=${(status) => navigate({ status })}
      sort=${settings.sort} onSort=${(sort) => saveSettings({ sort })} actions=${actions} today=${today} />`;
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

  return html`<${ProjectsContext.Provider} value=${{ byKey, showProject: actions.showProject }}><div class="app ${drawer ? 'drawer-open' : ''}">
    <${Sidebar} route=${route} items=${scopedItems} projects=${projects} scope=${scope} onProject=${actions.showProject}
      sync=${sync} onSyncClick=${onSyncClick} onNew=${() => actions.newItem()} onTag=${(tag) => actions.searchTag(tag)} />
    <div class="scrim" onClick=${() => setDrawer(false)} />
    <main class="main">
      <header class="topbar">
        <button type="button" class="icon-btn menu-btn" aria-label="Menu" onClick=${() => setDrawer(true)}><${Icon} name="menu" size=${22} /></button>
        <h1 class="view-title">${viewTitle(route)}</h1>
        <div class="search ${query ? 'has-query' : ''}">
          <${Icon} name="search" size=${17} />
          <input ref=${searchRef} type="search" value=${query} onInput=${(e) => onSearch(e.currentTarget.value)}
            placeholder="Search…  ( / )" aria-label="Search" autocomplete="off" />
          ${query && html`<button type="button" class="icon-btn sm" aria-label="Clear search" onClick=${() => setQuery('')}><${Icon} name="x" size=${15} /></button>`}
        </div>
        <${SyncBadge} sync=${sync} onClick=${onSyncClick} compact />
      </header>
      ${query && route.view !== 'settings' &&
      html`<div class="search-banner">Showing matches for <strong>${query}</strong><button type="button" class="btn link" onClick=${() => setQuery('')}>Clear</button></div>`}
      ${!isSyncConfigured(settings) && items.length > 0 && route.view === 'home' &&
      html`<a class="sync-hint" href="#/settings"><${Icon} name="cloudOff" size=${16} />Items are only on this device. Set up GitHub sync to use them on your phone and other computers.</a>`}
      <div class="content" ref=${contentRef}>
        ${scoped && html`<${ScopeBar} scope=${scope} projects=${projects} onChange=${setScope} />`}
        ${view}
      </div>
    </main>
    <${BottomNav} route=${route} onNew=${() => actions.newItem()} />
    ${modal && (modal.draft || modalItem) &&
    html`<${ItemModal} key=${modal.id ?? 'new'} item=${modalItem} initial=${modal.draft} actions=${actions}
      projects=${projects.map((p) => p.name)} tagSuggestions=${tagNames} today=${today} onClose=${closeModal} />`}
    <${Toasts} toasts=${toasts} onDismiss=${dismissToast} />
    ${fileDrag &&
    html`<div class="drop-overlay"><div><${Icon} name="upload" size=${40} /><p>Drop Markdown files to add them to your reading list</p></div></div>`}
  </div></${ProjectsContext.Provider}>`;
}
