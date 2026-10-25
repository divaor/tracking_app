# Tracker — notes for Claude

Personal tracker for tasks, ideas, Claude work and documents. Electron on desktop, PWA on mobile, synced via one JSON file in a GitHub repo.

## Commands

- `npm test` runs the unit tests (`node:test`, no browser needed). Run it before committing.
- `npm run web` serves `app/` at http://localhost:8080.
- `npm start` launches the Electron app. As root/in containers: `npx electron --no-sandbox .`
- `npm run vendor` re-copies Preact/htm, marked and DOMPurify into `app/vendor/` after upgrading them.

## Architecture

- `app/` is a no-build ES-module web app. GitHub Pages serves it directly and Electron loads it via the `app://tracker` protocol (`electron/main.cjs`). Root `package.json` is `"type": "module"`, so Electron files are `.cjs`.
- `app/js/model.js`, `sync.js`, `github.js` and `format.js` are pure and must stay DOM-free so the Node tests can import them.
- Sync is last-write-wins per item, based on `updatedAt`. Edits always bump `updatedAt` past the previous value (`bumpTime`). Deletions are tombstones, pruned after 180 days. `syncOnce` must never overwrite a remote file it cannot parse.
- The token is read and written through `settings.js` (`getToken`/`setToken`): Electron `safeStorage` via the preload bridge on desktop, `localStorage` on web.
- Local mode ("on this computer", setting `storage: 'local'`, the default for new installs; installs that had GitHub set up stay `'github'`; `isLocal()`): the same sync runs against the data on this device instead of GitHub.
  - `localRepo.js` (pure) is a small git-like store with github.js's calls (blobs by git sha, trees as changes from the one before with a full one every 64, branch heads by compare-and-swap, `listCommits` for history, `prune` keeps 180 days); `localData.js` picks its backend: the desktop data folder (`electron/localStore.cjs`, `data:*` IPC: files, a lock file for compare-and-swap, `watchRefs` → `data:changed` so the other app syncs at once; `Documents/Tracker data` unless `<appData>/Tracker data.json` names another) or IndexedDB `tracker-data` (shared with the editor on the same site; a BroadcastChannel tells it). `localRepo.js`, `localData.js`, `moveData.js` and `localStore.cjs` are copies of Tracker Editor's: keep them in step.
  - `syncManager.dataClient()` gives the client for either mode (attachments in `files.js` use it). In local mode the data file is `tracker.json`; nothing about syncing shows (`SyncBadge` hidden, no sync hint).
  - `switchStorage(to, patch)` syncs, then `moveData` copies what the other side lacks and merges tracker.json item by item (nothing deleted), sets the storage and syncs; the local store's meta `movedTo` makes the editor offer to follow (and the other way round).
  - The data folder is created only when local mode uses it (GitHub users never get one).
- `mcp/` is the Claude connector: a dependency-free MCP server.
  - `protocol.js` handles JSON-RPC and Streamable HTTP; `tools.js` holds the tools, prompts and the server instructions Claude sees (keep the instructions under 4,096 characters); `tracker.js` does the repo reads and writes, reusing `app/js/model.js` and `github.js`.
  - Entry points: `worker.js` (Cloudflare), `http.js`, `stdio.js`.
  - Documents go to `files/<date>-<slug>-<id6>/<name>` in the data repo; items reference them in `files`. The user's review lives in `decision` and `feedback`.
  - Tool results must stay small (`MAX_READ_CHARS`); `read_file` pages through long files.
  - `editor.js` gives Claude the Tracker Editor files (`*_editor_file(s)` tools): `editor/index.json` at the repo root lists records, the text is in `editor/files/<id>/<safeName(name)>`.
    - Keep its record fields, `safeName` and `serializeEditorIndex` in step with the editor's `app/js/model.js`. Records keep fields the connector does not know.
    - A save writes the text first, then the index (retried on 409/422); a rename deletes the old path. Text changes set `modifiedAt`/`modifiedBy`; name, project and tags bump `updatedAt`.
    - Encrypted files (`encrypted: true`, or text starting with `TRACKER-EDITOR-ENCRYPTED v1`) are never returned or overwritten. Tombstones are never resurrected.
  - `router.js` serves HTTP: `/mcp`, OAuth (`oauth.js`: discovery metadata, DCR, `/authorize` with the connector password, `/token` with PKCE + refresh), and `/push/*`.
    - OAuth state is HMAC-signed with a key derived from `MCP_SECRET`; an optional `OAUTH_KV` store adds single-use codes and refresh-reuse detection.
- Projects:
  - `tracker.json` has a `projects` list next to `items`: one record per project, keyed by its lowercase name, with area work/personal and a color. It's merged per key with last write wins.
  - Items reference projects by name; `projectList` combines the records with names used on items. Rename and delete logic (`renameProjectIn`, `deleteProjectIn`) is shared by the app store and the connector.
  - The scope filter (`matchesScope`) lives in settings as `projectScope`.
  - Pinned items (`pinned: true`, stored only when set): `pinnedFirst` puts them first, by project name (none last), in Home's Pinned section (all of them in scope, any status), the list and each board column. The filters (type, status, `#tag`, `+project`, scope, words) apply to them as to any item, unless the setting `pinnedPastFilters` (off by default; Settings → Appearance, command `pinned-past-filters`) is on: then `filterItems(…, { keepPinned })` and the list/board views let them past type, status and `#tag` (never the scope, `+project` or words). The connector pins with `update_items` (`pinned`); `list_items` takes `pinned`.
  - `serializeDocument(items, projects, extra)` keeps unknown top-level fields, so older/newer versions do not drop each other's data. Always pass projects when writing.
- Tracker Editor (github.com/divaor/tracker-editor) shares the data repo:
  - `app/js/editorLinks.js` builds and recognizes its links (`#/file/<id>`, `#/repo/<path>`, `tracker-editor://`). Keep it in step with the editor's `parseRoute` and its `electron/main.cjs`.
  - The address is the `editorUrl` setting (blank = default). The desktop app asks the main process (`editor:installed`) whether the editor's app handles `tracker-editor://`.
- Notifications:
  - Every write stamps `updatedBy` (device name; the connector writes `Claude`). `app/js/changes.js` turns before/after item lists into events.
  - The connector pushes them (`mcp/notify.js` + `mcp/push.js`: VAPID keys derived from `MCP_SECRET`, RFC 8291 encryption) to subscriptions in `devices.json` next to the data file (`app/js/devices.js`).
  - The app registers itself there (`app/js/push.js`); `sw.js` shows pushes. The desktop app polls every minute and shows native notifications (`app/js/notifier.js`); the tray/background mode lives in `electron/main.cjs`.
  - Headless Chromium cannot show notifications; run notification browser tests headed under `xvfb-run`.
- The model (as in Tracker Editor, optional):
  - `llm.js`, `asyncLlm.js`, `asyncConnection.js`, `localFetch.js`, `claude.js`, `providers.js` and `vendor/anthropic.js` are copies of the editor's; keep them in step (their tests too: `test/async-llm.test.js`, `test/claude.test.js`, `test/providers.test.js`). Settings `llm` has the same shape; its secrets (`llm-api-key`, `llm-webhook-secret`, and each connection's key `llm-key-<service>`: `LLM_KEY_SECRETS`) go through `getSecret`/`setSecret` and `SECRET_KEYS` in `main.cjs`, never the settings (an old `llm.apiKey` moves to `llm-key-local` on load).
  - Connections (`providers.js`, `connectionOf`): 'local' (a server here, `llm.service` 'local'), 'api' (`API_PROVIDERS`: `llm.provider` 'anthropic' for Claude through Anthropic's SDK in `claude.js`, else 'openai' with the provider's `baseUrl`) and 'async'. `createModelClient` reads the key per request. `ui/modelCard.js` has one form per connection.
  - `claude.js`: the official `@anthropic-ai/sdk` (bundled by the editor's `npm run vendor`), `dangerouslyAllowBrowser` (the person's own key on their device), streaming, `fallbacks: 'default'` (beta `server-side-fallback-2026-07-01`) on the models that take it, effort `low` for quick jobs, no sampling parameters, refusals and API errors turned into readable messages. A Claude subscription cannot be connected (Anthropic allows its sign-in only in its own apps): the connector is the way to use it.
  - `assist.js` (pure) holds the prompts and checks replies: `quickAddMessages`/`parseQuickAddReply`/`refinement` (only existing projects, real dates; the picked type and what was typed with + # ! @ stay; a plain title stays), `ITEM_ACTIONS` (`use`: answer, notes, feedback) and `planMessages`. `assistant.js` makes the calls.
  - Quick add creates the item at once, then `actions.refineQuickAdd` patches it when the model answers (unless it was edited meanwhile), with Undo.
  - Desktop: `llm:request`/`llm:abort` stream model requests through `net.fetch`, `webhook:listen` receives a service's answers (HMAC with the webhook secret).
- An open item (`ui/itemModal.js` `ItemPanel`, shared by the dialog `ItemModal` and `ItemWindow`):
  - `.item-top` stays while `.modal-body` scrolls (`scrolled` adds its edge): the bar, then `ItemHead` (the title always; status + `PriorityPick`, project + tags as settings `itemHead` says, `ITEM_HEAD`, chosen with the eye, `HeadMenu`).
  - Saving sends only the fields changed since editing began, so changes made meanwhile elsewhere stay.
  - The dialog keeps its ids (`modal-title`, `item-form`, `project-options`); each window's get a suffix.
  - `.modal-backdrop` has one `minmax(0, 1fr)` column and `.modal` `min-width: 0`, so wide code blocks and tables scroll inside instead of widening the column (which pushed the dialog off-center).
- Links to items (`itemLinks.js`, pure: `itemIdIn` for `…#/item/<id>`, `tracker-app://item/<id>` and bare ids, `webItemLink`, `appItemLink`, `splitItemIds`):
  - Pasting a link or an id in the search box opens the item (`onSearch` → `actions.openById`: here, else `linkedItem`: sync, then say so). Search also matches ids (`matchesQuery`).
  - `markdown.js` `linkItemIds` makes ids in rendered text `a.item-ref` links (not in `pre`); a capture-phase click listener in app.js opens any link into this app (`linkedItemOf`: same origin, the web app's address, or tracker-app:), Ctrl/middle-click in a window.
  - The eye's `id` part (off by default) shows the id with Copy ID / Copy link (`appBase`: the page's address on the web, else `WEB_APP_URL`). `HeadMenu` places its popover fixed under the eye, kept on screen.
  - Desktop: `main.cjs` registers `tracker-app` (`setAsDefaultProtocolClient`, `build.protocols`); `itemOfLink` reads those links and links to the web app; `openItem` sends `open-item` (preload `onOpenItem`) or keeps `pendingItem` for the first load (`#/item/<id>`); `second-instance`, `open-url`, argv at start, `setWindowOpenHandler` / `will-navigate`.
  - A desktop browser that does not sync (`desktopBrowser`, `isLocal`) and lacks the item offers the app (`offerDesktopApp`); once chosen (setting `openItemsInApp`, also in Settings → Use it everywhere) it goes there at once.
- Item windows (desktop; `ui/itemWindows.js`, placement in `windowLayout.js`, pure and tested):
  - App state `windows` ({ wid, id, x, y, w, h, z, min, max, restore, scroll }) in the order opened; the page keeps that order (moving a node would reload its previews) and `z` stacks them (z-index 30–45, under the dialog).
  - Opened by `actions.open(item, { window: true })` (Ctrl/Cmd+click, Ctrl+Enter, middle-click: `openProps` in components.js), the dialog's W / window button (`actions.popOut`: at the side, its scroll kept), never on narrow screens (`narrowScreen`: the dialog instead). The same item can be open more than once.
  - Dragging moves the element directly and keeps the place on release (pointer captured only once it is a drag, so the bar's double-click maximizes); `clampRect` keeps the bar reachable. Minimized windows stay mounted (`visibility: hidden`, `inert`).
  - `WindowDock`: a button per window, Side by side (`tileRects` over `.content`), Minimize all, Close all; commands `windows-tile`, `windows-minimize`, `windows-close` (also the desktop View menu).
- Help (F1 or ?, `ui/help.js`, as in Tracker Editor): `commands.js` (pure) lists every command (`keys`, `desktop`, `only: 'desktop'`; `run: false` rows show `keys`, `code` or `how`). `app.js`'s `commands` map runs them, and the desktop menu's `send()` goes through it; `test/commands.test.js` checks both. The guide is `app/help/guide.md` (the same text goes to the tracker as a doc): keep it current when features change.
  - The item modal and Help each get a history entry (`layers`, so Back closes the one on top). `closeModal(then)` / `closeHelp(then)` run `then` after the step back, so navigating there is not undone by it. Help owns Esc while open (a layout effect) and keeps its keys from reaching the item behind it; it runs no commands over an open item.
- Quick add from anywhere (desktop): a global shortcut (`prefs.json` `quickAdd`, IPC `quick:*`) opens `quick-add.html` with `quickAddPreload.cjs`. Lines go through `quick-adds.json` until the main window takes them (`quick:take`) and runs its quick add. Dictation in quick add (phones): `ui/dictation.js`.

## When changing things

- Adding or removing a file under `app/` → update `ASSETS` in `app/sw.js`. `test/app.test.js` enforces this.
- Bumping the version → update `package.json`, `app/js/version.js` and the `CACHE` name in `app/sw.js`. The tests check that they match.
- The manifest `id` (`./`) resolves to the origin root, https://divaor.github.io/, which identifies the installed tracker app. Don't change it: a new id makes installed copies a different app. Other apps on divaor.github.io (Tracker Editor) need ids of their own.
- The CSP in `app/index.html` allows only same-origin scripts. Fetches may go to any https origin (the GitHub API and the user's own connector) and to `localhost` (a model server).
  - Inline styles are allowed so HTML artifacts render in the sandboxed preview frame, which inherits the CSP.
  - Do not add inline scripts.
