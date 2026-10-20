import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import {
  filterItems,
  localDate,
  parseQuickAdd,
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
import { Icon } from './ui/icons.js';
import { SyncBadge, Toasts } from './ui/components.js';
import { BoardView, HomeView, ListView } from './ui/views.js';
import { ItemModal } from './ui/itemModal.js';
import { SettingsView } from './ui/settingsView.js';

const VIEWS = ['home', 'board', 'list', 'settings'];

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
    default:
      return 'Overview';
  }
}

const isTyping = (el) => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
const TEXT_FILE = /\.(md|markdown|mdx|txt)$/i;

function Sidebar({ route, items, onTag, sync, onSyncClick, onNew }) {
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
  const [sync, setSync] = useState(getSyncState());
  const [settings, setSettingsState] = useState(getSettings());
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [drawer, setDrawer] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [, setTick] = useState(0);
  const searchRef = useRef(null);
  const modalRef = useRef(null);
  const contentRef = useRef(null);
  const today = localDate();

  useEffect(() => store.subscribe(() => setItems(store.visible())), []);
  useEffect(() => onSyncState(() => setSync(getSyncState())), []);
  useEffect(() => onSettings((s) => setSettingsState(s)), []);
  useEffect(() => {
    const onHash = () => {
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

  const dismissToast = (id) => setToasts((list) => list.filter((t) => t.id !== id));
  const toast = (message, opts = {}) => {
    const id = ++toastSeq;
    setToasts((list) => [...list.slice(-2), { id, message, ...opts }]);
    setTimeout(() => dismissToast(id), opts.duration ?? 4500);
  };

  const navigate = (patch) => {
    location.hash = hrefFor({ ...route, ...patch });
  };
  const defaultType = route.type === 'all' ? 'task' : route.type;

  const actions = {
    toast,
    open: (item) => openModal({ id: item.id }),
    newItem: (draft = {}) => openModal({ draft: { type: defaultType, ...draft } }),
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
      const fields = parseQuickAdd(text, today);
      if (fields.title) actions.create({ ...defaults, ...fields });
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

  const filtered = useMemo(() => filterItems(items, { query }), [items, query]);
  const projects = useMemo(() => [...new Set(items.map((i) => i.project).filter(Boolean))].sort(), [items]);

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
  } else if (route.view === 'settings') {
    view = html`<${SettingsView} sync=${sync} actions=${actions} items=${items} theme=${settings.theme}
      installPrompt=${installPrompt} onInstall=${async () => {
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => null);
        setInstallPrompt(null);
      }} />`;
  } else {
    view = html`<${HomeView} items=${items} today=${today} actions=${actions} hrefFor=${hrefFor} />`;
  }

  return html`<div class="app ${drawer ? 'drawer-open' : ''}">
    <${Sidebar} route=${route} items=${items} sync=${sync} onSyncClick=${onSyncClick} onNew=${() => actions.newItem()}
      onTag=${(tag) => actions.searchTag(tag)} />
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
      <div class="content" ref=${contentRef}>${view}</div>
    </main>
    <${BottomNav} route=${route} onNew=${() => actions.newItem()} />
    ${modal && (modal.draft || modalItem) &&
    html`<${ItemModal} key=${modal.id ?? 'new'} item=${modalItem} initial=${modal.draft} actions=${actions}
      projects=${projects} today=${today} onClose=${closeModal} />`}
    <${Toasts} toasts=${toasts} onDismiss=${dismissToast} />
    ${fileDrag &&
    html`<div class="drop-overlay"><div><${Icon} name="upload" size=${40} /><p>Drop Markdown files to add them to your reading list</p></div></div>`}
  </div>`;
}
