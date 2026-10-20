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

## When changing things

- Adding or removing a file under `app/` → update `ASSETS` in `app/sw.js`. `test/app.test.js` enforces this.
- Bumping the version → update `package.json`, `app/js/version.js` and the `CACHE` name in `app/sw.js`. The tests check that they match.
- The CSP in `app/index.html` allows only same-origin scripts and `https://api.github.com` for fetches. Inline styles are allowed so HTML artifacts render in the sandboxed preview frame (which inherits the CSP); do not add inline scripts.
