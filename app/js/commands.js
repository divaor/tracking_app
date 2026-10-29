// Every command with its shortcut, for Help (F1): the cheat sheet, searchable, where a
// command can also be run. `keys` use "Mod" for Ctrl (Cmd on macOS) and "Alt" for Alt
// (Option); `desktop` keys apply in the desktop app instead; `only: 'desktop'` marks
// commands that exist only there. Rows with `run: false` are things done in place: they
// show `keys`, `code` (what to type) or `how`. Pure, so the Node tests can check it.

export const COMMAND_GROUPS = ['Items', 'Go to', 'Search and filter', 'In an item', 'Item windows', 'Quick add', 'The model', 'App'];

/** [{ id, group, label, keys?, desktop?, mac?, only?, code?, how?, hint?, run? }] */
export const COMMAND_LIST = [
  { id: 'new-item', group: 'Items', label: 'New item', keys: 'N', desktop: 'N · Mod+N' },
  { id: 'new-task', group: 'Items', label: 'New task' },
  { id: 'new-idea', group: 'Items', label: 'New idea' },
  { id: 'new-claude', group: 'Items', label: 'New Claude work (a session, PR, chat or artifact)' },
  { id: 'new-doc', group: 'Items', label: 'New document to read' },
  { id: 'import-docs', group: 'Items', label: 'Add Markdown files to the reading list', hint: 'Or drop them on the window' },
  { id: 'quick-add-window', group: 'Items', label: 'Quick add from any app (when turned on)', keys: 'Mod+Alt+T', only: 'desktop', hint: 'The keys you set in Settings → Quick add' },
  { id: 'sync', group: 'Items', label: 'Sync now', desktop: 'Mod+Shift+S', local: false },

  { id: 'go-home', group: 'Go to', label: 'Overview' },
  { id: 'go-board', group: 'Go to', label: 'Board' },
  { id: 'go-list', group: 'Go to', label: 'All items' },
  { id: 'go-tasks', group: 'Go to', label: 'Tasks' },
  { id: 'go-ideas', group: 'Go to', label: 'Ideas' },
  { id: 'go-claude', group: 'Go to', label: 'Claude work' },
  { id: 'go-docs', group: 'Go to', label: 'Docs (your reading list)' },
  { id: 'go-projects', group: 'Go to', label: 'Projects and tags' },
  { id: 'settings', group: 'Go to', label: 'Settings', desktop: 'Mod+,' },

  { id: 'search', group: 'Search and filter', label: 'Search', keys: '/', desktop: '/ · Mod+F' },
  { id: 'clear-search', group: 'Search and filter', label: 'Clear the search', keys: 'Esc', hint: 'In the search box' },
  { id: 'search-phrase', group: 'Search and filter', label: 'Search a phrase as written (case and accents never matter)', code: '"a phrase"', run: false },
  { id: 'search-tag', group: 'Search and filter', label: 'Search a tag', code: '#tag', run: false },
  { id: 'search-project', group: 'Search and filter', label: 'Search a project', code: '+project', run: false },
  { id: 'open-by-link', group: 'Search and filter', label: 'Open an item from a link to it or its ID (as Claude gives)', how: 'Paste it in the search box', run: false },
  { id: 'scope-all', group: 'Search and filter', label: 'Show all projects' },
  { id: 'scope-work', group: 'Search and filter', label: 'Show only work projects' },
  { id: 'scope-personal', group: 'Search and filter', label: 'Show only personal projects' },
  { id: 'pinned-past-filters', group: 'Search and filter', label: 'Show pinned items whatever the filters, or not (Settings → Appearance)' },

  { id: 'item-edit', group: 'In an item', label: 'Edit the open item', keys: 'E', run: false },
  { id: 'item-find', group: 'In an item', label: 'Find in the open item (its notes, the file shown, comments): Enter next, Shift+Enter previous', keys: 'Mod+F · /', run: false, hint: 'Or the magnifier in the item’s bar; opened from a search, it finds those words' },
  { id: 'item-pin', group: 'In an item', label: 'Pin or unpin the open item (it comes first in the lists it shows in, and on the Overview)', keys: 'P', run: false, hint: 'Or the pin on a pinned item' },
  { id: 'item-comment', group: 'In an item', label: 'Comment on the open item (for Claude, or a note); Ctrl+Enter posts it', keys: 'C', run: false, hint: 'Claude reads the comments of any item through the connector' },
  { id: 'item-save', group: 'In an item', label: 'Save', keys: 'Mod+Enter', run: false },
  { id: 'item-close', group: 'In an item', label: 'Close (asks before dropping changes)', keys: 'Esc', run: false },
  { id: 'item-status', group: 'In an item', label: 'Move to the next status', how: 'Click the round status icon', run: false },
  { id: 'item-check', group: 'In an item', label: 'Tick a checklist step', how: 'Click it in the reader', run: false },
  { id: 'item-tags', group: 'In an item', label: 'Add a tag / remove the last one', keys: 'Enter · Backspace', hint: 'In the tags field', run: false },
  { id: 'item-ask', group: 'In an item', label: 'Ask the model about this', how: 'In the item, with a model on', run: false },
  { id: 'item-undo', group: 'In an item', label: 'Undo a delete or a Done', how: 'Undo in the message', run: false },
  { id: 'item-priority', group: 'In an item', label: 'Change the priority', how: 'The priority next to the status, under the title', run: false },
  { id: 'item-head', group: 'In an item', label: 'Choose what shows under the title (status, priority, project, tags)', how: 'The eye in the item’s bar', run: false },
  { id: 'item-id', group: 'In an item', label: 'See the item’s ID, copy it or a link to the item', how: 'The eye → Its ID and link', run: false },
  { id: 'item-ref', group: 'In an item', label: 'Open an item named in the notes (its ID or a link to it)', how: 'Click it (Ctrl+click: in a window)', run: false },

  { id: 'item-window', group: 'Item windows', label: 'Open the item in a window, to keep it aside or compare it with others', keys: 'W', run: false, hint: 'In an open item, or its window button' },
  { id: 'item-window-click', group: 'Item windows', label: 'Open an item straight in a window (again for another view of the same item)', keys: 'Mod+click · middle-click', run: false },
  { id: 'window-move', group: 'Item windows', label: 'Move, resize, maximize or minimize a window', how: 'Drag its top bar or an edge; double-click the bar to maximize', run: false },
  { id: 'windows-tile', group: 'Item windows', label: 'Item windows side by side' },
  { id: 'windows-minimize', group: 'Item windows', label: 'Minimize all item windows (out of the way)' },
  { id: 'windows-close', group: 'Item windows', label: 'Close all item windows' },

  { id: 'qa-project', group: 'Quick add', label: 'Put it in a project', code: '+project', run: false },
  { id: 'qa-tag', group: 'Quick add', label: 'Add a tag', code: '#tag', run: false },
  { id: 'qa-priority', group: 'Quick add', label: 'Priority (! high, !! urgent)', code: '!high · !low · !urgent', run: false },
  { id: 'qa-due', group: 'Quick add', label: 'Due date', code: '@today · @tomorrow · @2026-11-02', run: false },
  { id: 'qa-link', group: 'Quick add', label: 'Fill the link', code: 'https://…', run: false },
  { id: 'qa-voice', group: 'Quick add', label: 'Say it (phone)', how: 'Tap the microphone', run: false },

  { id: 'plan-day', group: 'The model', label: 'Plan my day' },
  { id: 'plan-week', group: 'The model', label: 'Review my week' },
  { id: 'model-settings', group: 'The model', label: 'Connect a model (Ollama, LM Studio or a service)' },

  { id: 'help', group: 'App', label: 'Help: commands and shortcuts', keys: 'F1 · ?' },
  { id: 'help-guide', group: 'App', label: 'The guide' },
  { id: 'theme', group: 'App', label: 'Switch the theme (system, light, dark)' },
  { id: 'full-screen', group: 'App', label: 'Full screen', keys: 'F11', mac: 'Ctrl+Cmd+F', only: 'desktop', run: false },
  { id: 'quit', group: 'App', label: 'Quit (the tray icon keeps it running otherwise)', keys: 'Mod+Q', only: 'desktop', run: false },
];

/** The keys of a command as this computer shows them (Cmd and Option on macOS; the desktop app's own keys there). */
export function keysFor(command, { mac = false, desktop = false } = {}) {
  const keys = (mac && command.mac) || (desktop && command.desktop) || command.keys || '';
  return mac ? keys.replace(/Mod\+/g, 'Cmd+').replace(/Alt\+/g, 'Option+') : keys.replace(/Mod\+/g, 'Ctrl+');
}

/**
 * The commands for this place (desktop-only ones left out in the browser), matching every
 * word of `query`; while searching, the ones whose label matches come first.
 */
export function findCommands(query = '', { desktop = false, list = COMMAND_LIST, mac = false, local = false } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Local mode (no GitHub): nothing about syncing (`local: false` leaves a command out, a string relabels it).
  if (local) list = list.filter((c) => c.local !== false).map((c) => (typeof c.local === 'string' ? { ...c, label: c.local } : c));
  const found = list.filter(
    (c) => (desktop || c.only !== 'desktop') && words.every((w) => `${c.label} ${c.group} ${keysFor(c, { mac, desktop })} ${c.code ?? ''} ${c.how ?? ''} ${c.hint ?? ''}`.toLowerCase().includes(w)),
  );
  if (!words.length) return found;
  const rank = (c) => {
    const label = c.label.toLowerCase();
    return label.startsWith(words.join(' ')) ? 0 : words.every((w) => label.includes(w)) ? 1 : 2;
  };
  return found.map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

/** The groups to show for `found`: in their usual order, or while searching in the order of their best match. */
export function groupsOf(found, searching) {
  return searching ? [...new Set(found.map((c) => c.group))] : COMMAND_GROUPS.filter((g) => found.some((c) => c.group === g));
}
