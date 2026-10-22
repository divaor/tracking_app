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
  - `serializeDocument(items, projects, extra)` keeps unknown top-level fields, so older/newer versions do not drop each other's data. Always pass projects when writing.
- Tracker Editor (github.com/divaor/tracker-editor) shares the data repo:
  - `app/js/editorLinks.js` builds and recognizes its links (`#/file/<id>`, `#/repo/<path>`, `tracker-editor://`). Keep it in step with the editor's `parseRoute` and its `electron/main.cjs`.
  - The address is the `editorUrl` setting (blank = default). The desktop app asks the main process (`editor:installed`) whether the editor's app handles `tracker-editor://`.
- Notifications:
  - Every write stamps `updatedBy` (device name; the connector writes `Claude`). `app/js/changes.js` turns before/after item lists into events.
  - The connector pushes them (`mcp/notify.js` + `mcp/push.js`: VAPID keys derived from `MCP_SECRET`, RFC 8291 encryption) to subscriptions in `devices.json` next to the data file (`app/js/devices.js`).
  - The app registers itself there (`app/js/push.js`); `sw.js` shows pushes. The desktop app polls every minute and shows native notifications (`app/js/notifier.js`); the tray/background mode lives in `electron/main.cjs`.
  - Headless Chromium cannot show notifications; run notification browser tests headed under `xvfb-run`.

## When changing things

- Adding or removing a file under `app/` → update `ASSETS` in `app/sw.js`. `test/app.test.js` enforces this.
- Bumping the version → update `package.json`, `app/js/version.js` and the `CACHE` name in `app/sw.js`. The tests check that they match.
- The manifest `id` (`./`) resolves to the origin root, https://divaor.github.io/, which identifies the installed tracker app. Don't change it: a new id makes installed copies a different app. Other apps on divaor.github.io (Tracker Editor) need ids of their own.
- The CSP in `app/index.html` allows only same-origin scripts. Fetches may go to any https origin (the GitHub API and the user's own connector).
  - Inline styles are allowed so HTML artifacts render in the sandboxed preview frame, which inherits the CSP.
  - Do not add inline scripts.
