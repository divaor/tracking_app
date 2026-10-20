# Claude connector for Tracker

This folder is an MCP server that lets Claude read and update your tracker. Once it's connected, you can say things like these in any Claude chat or Claude Code session:

| You say | Claude does |
| --- | --- |
| "Send this proposal to my tracker" | Saves the full proposal as `proposal.md` in your data repo and files it under **Docs → To read**. |
| "Send the artifact to my tracker" | Saves the artifact file (`.html`, `.md`, code…) with a short summary. |
| "Update tasks on my tracker: the sync work is done, add a task to write docs" | Finds the existing items, marks them done and adds the new task, all in one commit. |
| "Log this session as Claude work on my tracker" | Adds a *Claude work* item with the session or PR link. |
| "What's on my tracker?" | Gives you an overview: counts, what's in progress, what's due soon and what's waiting for your review. |
| "Check my tracker for feedback on the proposal and revise it" | Reads your decision and feedback, then sends a new version back into your review queue. |

The review loop works like this:

1. Claude sends a proposal or artifact.
2. You open it in the Tracker app on your PC or phone. The files are rendered there, and HTML gets a safe preview with scripts turned off.
3. You pick **Approve**, **Request changes** or **Reject** and write your feedback.
4. Claude reads your decision and feedback back from any session.

## Where things go

Everything lives in the same private data repository the app syncs to:

```
tracker.json                                     items (the app's data file)
files/2026-10-20-offline-sync-proposal-1a2b3c/   one folder per document
  proposal.md                                    the file Claude sent
  mockup.html                                    more files or later versions
```

Every change is a git commit, for example `Tracker: add proposal “Offline sync” (via Claude)`, so you can see and undo anything Claude did. Sending a new version of a file overwrites it, and the old version stays in the git history.

## Set it up (about 10 minutes, once)

You need:

- The **data repository** and app sync from the main README.
- A free **Cloudflare** account. The connector runs there as a Worker, because Claude must reach it over HTTPS.

### 1. Create a token for the connector

Create a GitHub **fine-grained personal access token** that only covers your data repository:

1. Go to GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**.
2. Under *Repository access*, choose only your data repo (for example `tracker-data`).
3. Under permissions, set **Contents: Read and write**.

Use a separate token from the one in the app, so you can revoke either without affecting the other.

### 2. Make a connector secret

The secret is part of the connector's URL and works like a password. Generate one:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 3. Deploy

First check the `[vars]` in [`wrangler.toml`](wrangler.toml). `TRACKER_REPO` must be your data repository (`owner/repo`), and `TRACKER_BRANCH`/`TRACKER_PATH` must match the app's sync settings.

**Option A: from your computer.** Run this from the repository root:

```sh
npx wrangler@4 login
npx wrangler@4 deploy -c mcp/wrangler.toml
npx wrangler@4 secret put GITHUB_TOKEN -c mcp/wrangler.toml   # paste the token from step 1
npx wrangler@4 secret put MCP_SECRET -c mcp/wrangler.toml     # paste the secret from step 2
```

**Option B: from GitHub, no installs.** Works from your phone too.

1. In Cloudflare, create an API token with the **Edit Cloudflare Workers** template, and note your **Account ID**.
2. In this repository, go to **Settings → Secrets and variables → Actions** and add these secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `TRACKER_GITHUB_TOKEN`: the token from step 1
   - `MCP_SECRET`: the secret from step 2
3. Optionally, add a **variable** `TRACKER_REPO` instead of editing `wrangler.toml`.
4. Run **Actions → Deploy Claude connector → Run workflow**.

Wrangler prints the Worker's address, for example `https://tracker-mcp.<your-subdomain>.workers.dev`. Your connector URL is that address plus `/mcp/` and your secret:

```
https://tracker-mcp.<your-subdomain>.workers.dev/mcp/<MCP_SECRET>
```

### 4. Add it to Claude

1. In Claude (claude.ai or the desktop app), go to **Customize → Connectors → Add custom connector**.
2. Name it **Tracker**, paste the connector URL and leave authentication off (no sign-in).
3. In a chat, make sure **Tracker** is enabled under **+ → Connectors**.

A connector added this way is available in Claude on the web, desktop and mobile. It also works in **Claude Code**, both the CLI and Claude Code on the web, when you sign in with the same Claude account. There's nothing to install per machine.

## Other ways to connect

**Claude Code with an API key** (not signed in with a Claude account). Use the bearer header, so the secret isn't part of the URL:

```sh
claude mcp add --transport http --scope user tracker \
  https://tracker-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_SECRET>"
```

**Fully local, nothing hosted.** This uses stdio and only works on the machine where you run it:

```sh
claude mcp add --scope user \
  --env GITHUB_TOKEN=github_pat_… --env TRACKER_REPO=owner/tracker-data \
  --transport stdio tracker -- node /path/to/tracking_app/mcp/stdio.js
```

**Self-hosted HTTP.** You can also run the HTTP server on your own machine:

```sh
MCP_SECRET=… GITHUB_TOKEN=… TRACKER_REPO=owner/repo node mcp/http.js
```

It listens on `127.0.0.1:8787` by default. Put it behind HTTPS (a reverse proxy or a tunnel) before adding it to Claude.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Fine-grained token with Contents read/write on the data repo (a Worker **secret**). |
| `TRACKER_REPO` | yes | `owner/repo` of the data repository. |
| `MCP_SECRET` | HTTP only | Shared secret: 16+ characters (a Worker **secret**). |
| `TRACKER_BRANCH` | no | Branch the app syncs to. Blank means the default branch. |
| `TRACKER_PATH` | no | Data file. Default `tracker.json`. |
| `TRACKER_FILES_DIR` | no | Folder for documents. Default `files`. |
| `TRACKER_DEVICE` | no | Name used in commit messages. Default `Claude`. |
| `TRACKER_APP_URL` | no | Web app address, so replies include links that open the item, e.g. `https://you.github.io/tracking_app/`. |
| `MCP_ALLOWED_ORIGINS` | no | Extra browser origins allowed to call the server (comma-separated). |

## What the connector offers

Tools:

- **`get_overview`**: counts, in progress, due soon, awaiting review, recent decisions.
- **`list_items`**: search and filter by type, status, tag, project, kind or decision.
- **`get_item`**: full details, optionally including the attached files' contents.
- **`read_file`**: reads an attached file, in pages for long files.
- **`add_items`**: adds several items in one commit.
- **`update_items`**: changes status, fields and tags, can append notes, and records review fields.
- **`delete_items`**: only used when you explicitly ask.
- **`send_document`**: saves a proposal or artifact as a file and files it as a doc, or adds a new version to an existing doc.

Prompts (slash commands in Claude Code): `send_proposal`, `update_tracker`, `check_feedback`.

The server also sends Claude short instructions that explain these conventions, so you don't have to.

## Security notes

- **The URL is the key.** Anyone who has the connector URL can read and change your tracker, so keep it private.
  - To rotate it: run `wrangler secret put MCP_SECRET` with a new value, then update the connector URL in Claude.
  - Claude's documentation recommends OAuth for shared or public connectors. A secret URL is a simpler fit for a personal one.
- **Limited reach.** The connector can only touch the data file and the `files/` folder of the one repository its token allows. Scripts in HTML artifacts never run in the app's preview.
- **Easy to undo.** Claude is told never to delete without you asking, and every change is a revertible commit.

## Development

```sh
npm test                                   # includes the MCP tests (protocol, tools, HTTP, stdio)
npm run mcp:stdio                          # stdio server (needs GITHUB_TOKEN, TRACKER_REPO)
npm run mcp:http                           # HTTP server (also needs MCP_SECRET)
npx wrangler@4 dev -c mcp/wrangler.toml    # the Worker locally
```

The server code has no dependencies:

- `protocol.js`: JSON-RPC, MCP and Streamable HTTP.
- `tools.js`: tool and prompt definitions, plus the instructions Claude sees.
- `tracker.js`: reads and writes the data repo, using the app's `model.js` and `github.js`.
