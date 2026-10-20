# Claude connector for Tracker

This folder is an MCP server that lets Claude read and update your tracker. Once it's connected, you can say things like these in any Claude chat or Claude Code session:

| You say | Claude does |
| --- | --- |
| "Send this proposal to my tracker" | Saves the full proposal as `proposal.md` in your data repo and files it under **Docs → To read**. |
| "Send the artifact to my tracker" | Saves the artifact file (`.html`, `.md`, code…) with a short summary. |
| "Update tasks on my tracker: the sync work is done, add a task to write docs" | Finds the existing items, marks them done and adds the new task, all in one commit. |
| "Log this session as Claude work on my tracker" | Adds a *Claude work* item with the session or PR link. |
| "For this conversation use project Platform and tag with the repos you touch" | Files everything it adds or sends from then on under **Platform**, tagged with each repository involved. It creates the project (asking whether it's work or personal) and new tags as needed. |
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
devices.json                                     phones/browsers that want push notifications
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

### 2. Choose a connector password

You'll type this password once on a sign-in page when you connect Claude. The connector also derives its signing keys from it. Generate a strong one and keep it in your password manager:

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
npx wrangler@4 secret put MCP_SECRET -c mcp/wrangler.toml     # paste the password from step 2
```

**Option B: from GitHub, no installs.** Works from your phone too.

1. In Cloudflare, create an API token with the **Edit Cloudflare Workers** template, and note your **Account ID**.
2. In this repository, go to **Settings → Secrets and variables → Actions** and add these secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `TRACKER_GITHUB_TOKEN`: the token from step 1
   - `MCP_SECRET`: the password from step 2
3. Optionally, add a **variable** `TRACKER_REPO` instead of editing `wrangler.toml`.
4. Run **Actions → Deploy Claude connector → Run workflow**.

Wrangler prints the Worker's address, for example `https://tracker-mcp.<your-subdomain>.workers.dev`. The connector's MCP address is that plus `/mcp`.

### 4. Add it to Claude

1. In Claude (claude.ai or the desktop app), go to **Customize → Connectors → Add custom connector**.
2. Name it **Tracker** and paste `https://tracker-mcp.<your-subdomain>.workers.dev/mcp`.
3. Claude opens the connector's sign-in page. Enter your connector password and press **Allow**.
4. In a chat, make sure **Tracker** is enabled under **+ → Connectors**.

A connector added this way is available in Claude on the web, desktop and mobile. It also works in **Claude Code**, both the CLI and Claude Code on the web, when you sign in with the same Claude account. There's nothing to install per machine, and Claude renews its access automatically.

### 5. Turn on notifications (optional)

- **Phone:** open the Tracker web app installed on your Home Screen, go to **Settings → Notifications**, enter the connector address (without `/mcp`) and tap **Turn on notifications**.
  - On iPhone this needs iOS 16.4 or later, and the app must be opened from its Home Screen icon.
  - Do this on each phone or browser you want notified.
- **Desktop app:** notifications are on by default. It checks for changes every minute and can keep running in the system tray.

You then get a notification when Claude sends a document to review (or a new version), stores a file, or adds, updates, completes or deletes items. Choose which of these you want in the same settings card. Tapping a notification opens the item.

## How sign-in works (OAuth)

The connector is its own OAuth 2.1 authorization server, following the MCP authorization spec:

- **Discovery:** an unauthenticated request to `/mcp` gets `401` with `WWW-Authenticate: Bearer resource_metadata=…`. That points to `/.well-known/oauth-protected-resource/mcp`, which points to `/.well-known/oauth-authorization-server`.
- **Registration:** clients register through `/register` (dynamic client registration). By default only Claude's callback (`https://claude.ai/api/mcp/auth_callback`) and loopback addresses for Claude Code (`http://localhost:<any port>/callback`) are accepted. Add other hosts with `OAUTH_REDIRECT_HOSTS`.
- **Approval:** `/authorize` shows which app is asking and where you'll be sent back, and asks for the connector password. Codes require PKCE (S256).
- **Tokens:** `/token` issues access tokens that last 1 hour and refresh tokens that last 90 days. They're bound to this server's `/mcp` address. Claude refreshes them on its own.
- **No database:** clients, codes and tokens are signed with a key derived from `MCP_SECRET`, so nothing has to be stored.
- **Revoking access:** change `MCP_SECRET`. That signs out every client, and phones need to turn notifications on again.

**Optional hardening:** single-use codes and refresh-token reuse detection. Create a KV namespace and bind it as `OAUTH_KV` (see the commented lines in `wrangler.toml`):

```sh
npx wrangler@4 kv namespace create OAUTH_KV -c mcp/wrangler.toml
```

## Other ways to connect

**Claude Code without the claude.ai connector.** `claude mcp add` runs the same OAuth sign-in through your browser:

```sh
claude mcp add --transport http --scope user tracker https://tracker-mcp.<your-subdomain>.workers.dev/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate**. For scripts, you can skip OAuth by sending the password as a bearer token: add `--header "Authorization: Bearer <MCP_SECRET>"`.

**Older setups.** The secret URL `…/mcp/<MCP_SECRET>` still works for clients that can only take a URL. It's the same password, sent in the address instead of on a sign-in page.

**Fully local, nothing hosted.** This uses stdio and only works on the machine where you run it. Add `--env MCP_SECRET=…` (the same password as the Worker) if it should also send push notifications.

```sh
claude mcp add --scope user \
  --env GITHUB_TOKEN=github_pat_… --env TRACKER_REPO=owner/tracker-data \
  --transport stdio tracker -- node /path/to/tracking_app/mcp/stdio.js
```

**Self-hosted HTTP.** You can also run the HTTP server on your own machine:

```sh
MCP_SECRET=… GITHUB_TOKEN=… TRACKER_REPO=owner/repo MCP_PUBLIC_URL=https://tracker.example.com node mcp/http.js
```

It listens on `127.0.0.1:8787` by default. Put it behind HTTPS (a reverse proxy or a tunnel) and set `MCP_PUBLIC_URL` to the public origin, so the sign-in links are right.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Fine-grained token with Contents read/write on the data repo (a Worker **secret**). |
| `TRACKER_REPO` | yes | `owner/repo` of the data repository. |
| `MCP_SECRET` | HTTP, push | Connector password, 16+ characters (a Worker **secret**). OAuth and push keys are derived from it. |
| `TRACKER_BRANCH` | no | Branch the app syncs to. Blank means the default branch. |
| `TRACKER_PATH` | no | Data file. Default `tracker.json`. `devices.json` sits next to it. |
| `TRACKER_FILES_DIR` | no | Folder for documents. Default `files`. |
| `TRACKER_DEVICE` | no | Name used in commit messages. Default `Claude`. |
| `TRACKER_APP_URL` | no | Web app address, so replies include links that open the item, e.g. `https://you.github.io/tracking_app/`. |
| `OAUTH_REDIRECT_HOSTS` | no | Extra hosts allowed as OAuth redirect targets (comma-separated; `*` allows any https host). |
| `MCP_PUBLIC_URL` | no | Public origin when self-hosting behind a proxy. |
| `VAPID_SUBJECT` | no | Contact URL or `mailto:` for push services. Default: `TRACKER_APP_URL`. |
| `MCP_ALLOWED_ORIGINS` | no | Extra browser origins allowed to call `/mcp` (comma-separated). |
| `OAUTH_KV` | no | KV namespace binding for single-use codes and refresh-token reuse detection. |

## What the connector offers

Tools:

- **`get_overview`**: counts, in progress, due soon, awaiting review, recent decisions, active projects.
- **`list_projects`**: projects (area, counts) and tags in use, so Claude reuses the exact spellings.
- **`save_project`**: create a project, set its area (work/personal), color or description, rename it (items move along) or delete it.
- **`list_items`**: search and filter by type, status, tag, one or more projects, area, kind or decision.
- **`get_item`**: full details, optionally including the attached files' contents.
- **`read_file`**: reads an attached file, in pages for long files.
- **`add_items`**: adds several items in one commit.
- **`update_items`**: changes status, fields and tags, can append notes, and records review fields.
- **`delete_items`**: only used when you explicitly ask.
- **`send_document`**: saves a proposal or artifact as a file and files it as a doc, or adds a new version to an existing doc.

Prompts (slash commands in Claude Code): `use_project`, `send_proposal`, `update_tracker`, `check_feedback`.

The server also sends Claude short instructions that explain these conventions, so you don't have to.

HTTP endpoints:

| Endpoint | Purpose |
| --- | --- |
| `/mcp` | MCP (Streamable HTTP), with an OAuth access token. |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` | OAuth discovery. |
| `/register`, `/authorize`, `/token` | OAuth. |
| `/push/config` | Public key for push subscriptions (used by the app). |
| `/push/test` | Sends a test notification. The app authenticates with its GitHub token, and the connector checks that it can access the data repo. |

## Security notes

- **The password is the key.** Anyone with your connector password can connect a client, so keep it in a password manager.
  - The sign-in page shows which app is asking and where it will send you back.
  - Redirect targets are limited to Claude and localhost unless you add more.
- **Rotating** `MCP_SECRET` revokes every token at once.
- **Push privacy:** notifications are end-to-end encrypted to each device (Web Push, RFC 8291). Push services only see when a notification was sent, not what it says.
- **Limited reach.** The connector can only touch the data file, `devices.json` and the `files/` folder of the one repository its token allows. Scripts in HTML artifacts never run in the app's preview.
- **Easy to undo.** Claude is told never to delete without you asking, and every change is a revertible commit.

## Development

```sh
npm test                                   # includes MCP, OAuth and push tests
npm run mcp:stdio                          # stdio server (needs GITHUB_TOKEN, TRACKER_REPO)
npm run mcp:http                           # HTTP server (also needs MCP_SECRET)
npx wrangler@4 dev -c mcp/wrangler.toml    # the Worker locally
```

The server code has no dependencies and uses only web-standard APIs, so it runs on Workers and Node:

- `protocol.js`: JSON-RPC and MCP.
- `router.js`: HTTP routes and authentication.
- `oauth.js`: the authorization server.
- `tools.js`: tool and prompt definitions, plus the instructions Claude sees.
- `tracker.js`: reads and writes the data repo, using the app's `model.js` and `github.js`.
- `notify.js` and `push.js`: push notifications (VAPID, encryption).
