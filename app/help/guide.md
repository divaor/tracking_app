# Tracker guide

One place for your tasks, ideas, the Claude work you have going and the documents you need to read, on your computers, your phone and inside Claude.

Version 1.8.1 · Download: https://github.com/divaor/tracking_app/releases/latest · Web app: https://divaor.github.io/tracking_app/

Press **F1** (or **?**) anywhere for this guide and the list of every command and shortcut.

---

## 1. How it works

Every item has a **type** and a **status**:

- **Tasks** and **Ideas**: things to do or think about.
- **Claude work**: Claude Code sessions, pull requests, chats and artifacts you have going.
- **Docs**: things to read or review, such as proposals, artifacts, READMEs, specs, reports and articles.
- Status moves **Pending → In progress → Done**. For docs the same steps read **To read → Reading → Read**.

**Your data starts on this computer.** A new install keeps everything on the device: on the desktop in a data folder (`Documents/Tracker data`) that Tracker Editor on the same computer shares, in the browser in its own storage (the editor opened in the same browser shares it). Projects, tags, documents and Tracker Editor's Send to tracker all work, and nothing about syncing shows.

**To use your phone and other computers too**, turn on *Sync across your devices with GitHub* (Settings → Where your data is): everything on this device is copied to your private data repo first, so nothing is lost. Each device then keeps a full copy and syncs it through `tracker.json` in that repo. Claude reads and writes the same file through the connector, and Tracker Editor keeps its files in the same repo. Every change becomes a commit, so the repo history is also your backup.

## 2. Get it and connect it

### Phone

The phone app is the web app installed to your Home Screen. It works offline and syncs when you're online.

1. Open https://divaor.github.io/tracking_app/ in Safari (iPhone) or Chrome (Android).
2. Install it. On **iPhone**: Share → **Add to Home Screen**. On **Android**: ⋮ → **Install app**.
3. Open it from the new icon and connect it to your data (below).

### Desktop (Windows, Mac, Linux)

Download the file for your computer from the latest release (https://github.com/divaor/tracking_app/releases/latest):

- **Windows:** `Tracker.Setup.<version>.exe` installs it. If you can't install software (for example on a work PC), `Tracker-<version>-portable.exe` runs without installing.
- **Mac (Apple silicon):** the `.dmg`. Open it and drag Tracker to Applications.
- **Linux:** the `.AppImage`. Make it executable (`chmod +x`) and run it.

The installers aren't code-signed, so your computer warns you once. Windows SmartScreen: **More info → Run anyway**. Mac: right-click the app → **Open**.

The desktop app looks and works like the web app. It also shows native notifications, opens a quick add window from any app, and can keep running in the system tray when you close the window.

### Keep your data on this computer (the default)

Nothing to set up. **Settings → Where your data is** says where it is (on the desktop, **Show the folder** opens it; copying that folder is a backup). Install Tracker Editor on the same computer and the two work together straight away: its projects are yours, it opens the tracker's documents, its *Send to tracker* lands here at once.

- History is kept here too, for 180 days.
- Phone notifications and the Claude connector need GitHub sync (below).
- On an iPhone, apps added to the home screen each keep their own storage, so the tracker and the editor work together there in Safari, or through GitHub.

### Connect a device to your data (GitHub sync)

Do this once on each device. You need a private repository for your data (for example `tracker-data`; it can start empty) and a GitHub token that can read and write it:

1. On GitHub: Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. Under *Repository access*, choose **Only select repositories** and pick your data repo.
3. Under *Repository permissions*, set **Contents** to **Read and write**, then create the token.
4. In the app, open **Settings → Where your data is → Sync across your devices with GitHub…**. Enter the owner, the repository, the token, and a name for this device (for example *Work PC* or *Phone*).
5. Press **Test connection**, then **Copy my data to GitHub and sync**. Everything on this device goes to the repo first (an empty repo gets all of it; one with data from other devices is merged item by item, the newest edit winning). The badge then shows *Synced*.
6. **Tracker Editor on this computer** offers to follow (*Your data moved to GitHub: Connect*): connect it with the same token.

To go back, **Stop syncing with GitHub and keep everything on this computer…** at the bottom of the card copies anything that is only on GitHub to this computer first; the repo keeps its copy.

The device name appears in commit messages and in notifications about changes from your other devices.

**More devices:** on a device that's already set up, open *Copy these settings to another device* at the bottom of the card, copy the setup code and paste it on the new device. The code contains your token, so only send it to yourself.

### Connect Claude

1. Deploy the connector (see `mcp/README.md` in the repository; the **Deploy Claude connector** workflow does it from the Actions tab).
2. In Claude, go to **Customize → Connectors → Add custom connector**, name it **Tracker** and paste `https://<your connector>/mcp`.
3. A sign-in page opens. Enter your connector password and press **Allow**.
4. In a chat, make sure Tracker is on under **+ → Connectors**.

The connector then works in Claude on the web, desktop and phone, and in Claude Code signed in with the same account. Claude renews its access on its own.

## 3. Overview

The home screen shows what needs attention: **due soon**, **in progress**, **up next**, your **reading list** and **recently completed** items, with a quick add at the top. Click any card to open it. Click the round status icon on a card to move it to the next status.

With a model connected, the Overview can also **Plan my day** or **Review my week** (section 9).

The sidebar lists the categories, your projects and your most used tags, each with its count of open items. On a phone, the bottom bar switches between Home, Board, Items and Settings, the round button adds an item, and ☰ opens the sidebar.

## 4. Quick add

Pick a type (Task, Idea, Claude work, Document), type one line and press **Enter**. Shortcuts in the text fill in the details:

| Type | Effect |
| --- | --- |
| `+platform` | Puts it in the project Platform (existing names match loosely; a new name creates the project). |
| `#work` | Adds the tag `work`. |
| `!high`, `!low`, `!urgent` | Sets the priority. `!` means high and `!!` means urgent. |
| `@today`, `@tomorrow`, `@2026-11-02` | Sets the due date. |
| `https://…` | Fills the item's Link. |

`Write report +platform #work !high @tomorrow` creates a high-priority task in Platform, tagged `work`, due tomorrow.

- **Plain language** (with a model, Settings → Quick add): type *call Ana tomorrow about the invoice, urgent*. The item is added at once as you typed it, then the model fills in the due date, priority, project (only ones you have) and tags it understood, with **Undo**. What you typed with `+ # ! @` and the type you picked stay as they are, and a plain title is never rewritten.
- **From any app (desktop):** turn on the shortcut in **Settings → Quick add** (`Ctrl+Alt+T` by default; click the field and press the keys you want). A small window opens over whatever you're doing: pick the type, type the line, press **Enter**. It works with the window closed while Tracker runs in the tray, and from the tray menu and **File → Quick Add…**.
- **By voice (phone):** tap the microphone in quick add and say it; it goes after anything you typed. Pick the language in **Settings → Quick add**. It uses the browser's speech service, so it needs a connection.

## 5. Board

Three columns: **Pending**, **In progress** and **Done**. Drag cards between columns on a computer, or swipe between columns on the phone. The tabs at the top limit the board to one type, and **+** on a column adds an item with that status.

Each card shows its type, priority, project, due date, checklist progress, attached files and tags.

## 6. All items and search

Filter by type and status, and sort by priority, due date and more (*Smart* lists items in progress first, then the rest by priority and due date). The sidebar's categories open the same list already filtered.

- **Search** (`/`) matches titles, notes, links and file names. Use `#tag` for a tag or `+project` for a project. **Esc** in the search box clears it.
- Click a **tag** in the sidebar or on an item to see everything with that tag. Click a **project chip** to show that project.

## 7. Editing an item

Open an item and press the pencil (or **E**). You can change its type, status, priority, due date, project, link and tags, and write notes in Markdown.

- **Checklists:** write `- [ ] step` lines. You can tick them right in the reader, and cards show the progress (for example 1/3).
- **Tags** are chips: type one and press Enter (Backspace in an empty field removes the last one). Suggestions come from tags you already use.
- **Documents:** paste text, use **Import file**, or drop Markdown files onto the window to add them to your reading list.
- Save with **Ctrl+Enter** (**Cmd+Enter** on a Mac); **Esc** closes (and asks before dropping unsaved changes). Deleting an item or marking it done shows an **Undo** button for a few seconds.

## 8. Projects and tags

Each item can belong to one **project**, and each project is either **Work** or **Personal**. **Tags** are free labels; use them, for example, for the repos a proposal touches.

### Filter what you see

The bar above every view filters by **All**, **Work**, **Personal**, or any mix of projects (**Projects ▾**). Each device remembers your choice. When exactly one project is selected, new items go into it.

### Manage projects and tags

Open **Projects → Manage** in the sidebar. There you can add projects, set each one's area and color, rename a project (its items move along, and renaming to an existing name merges the two) or delete it (its items stay, without a project). Tags can be renamed, which also merges them, or deleted.

## 9. The model (optional)

Connect a model of your own in **Settings → Model**, the same kinds as in Tracker Editor:

- **A server on your computer** (**This computer**: Ollama, LM Studio or anything with an OpenAI-compatible API): press **Ollama**, then **Test and list models**, pick one and **Save and turn on**. Nothing leaves your machine. The desktop app makes the requests itself, so the server needs no setup; in a browser, Ollama must allow the site (`OLLAMA_ORIGINS=https://divaor.github.io`).
- **An AI provider with your own API key** (**AI provider**): **Claude**, OpenAI, Google Gemini, OpenRouter (many models with one key), Mistral, Groq, or another service with an OpenAI-compatible API. Pick the provider, paste your key (**Get a key** opens the provider's page), press **Test and list models**, pick a model and **Save and turn on**. What you ask about is sent to that provider, which bills your account for what you use. The key stays on the device: the keychain in the desktop app, the browser's storage on the web and on your phone; it is never synced or put in the settings (**Forget the key** removes it). Each device needs the key once. Works on the phone too.
- **Your Claude subscription (Pro or Max) cannot be connected here**: Anthropic allows its sign-in only in its own apps, and the API is paid separately with a key from the [Claude Console](https://platform.claude.com/). To use your subscription with the tracker, add the Tracker connector in the Claude app (section 11): Claude can then read, add and update your items from its own app, on your phone too.
- **A service that answers later** (**Answers later**): paste its connection profile (the same JSON as in Tracker Editor; **Start from the example** shows the shape), the model or agent name and the API key, which the desktop app keeps in the system keychain. The desktop app can also receive answers by webhook (use a different port from Tracker Editor's).

With a model on:

- **Ask the model about this**, in every item: Summarize, Break into steps (tasks), Turn into a plan (ideas), **Draft my feedback** (documents, from their files too), Questions to ask, Risks and gaps, In English / In Spanish, or any question, with follow-ups. **Add to the notes** puts an answer (a checklist of steps, say) in the item; **Use as my feedback** fills your review of a document.
- **Plan my day** / **Review my week** on the Overview: what to do first today, or what got done, what is stuck and what to focus on next.
- **Quick add in plain language** (section 4).

## 10. Documents and reviews

Documents Claude sends arrive under **Docs**, with the file attached and a short summary of what to decide. They're stored in your data repo under `files/`.

- **Markdown** files are rendered, with tables, code and checklists.
- **HTML artifacts** are shown in a safe preview with scripts turned off.
- **Source** shows the raw file, and **Download** saves it.
- **Edit in editor** opens the file in Tracker Editor; your edits come back here.

### Review

At the end of a document, choose **Approve**, **Request changes** or **Reject**, and write feedback (or let the model draft it). Then tell Claude *"check my tracker for feedback"*. It reads your decision and notes and can send a revised version. A new version replaces the file and puts the doc back in your reading list.

## 11. Working with Claude

In any Claude chat or Claude Code session with the Tracker connector on, just say what you want:

| Say | What Claude does |
| --- | --- |
| "Send this proposal to my tracker" | Saves the complete proposal as a file under Docs, with a summary of what to decide. |
| "Send the artifact to my tracker" | Saves the artifact (HTML, Markdown, code…) as a file you can preview. |
| "Add a task to my tracker: renew the domain, due Friday" | Adds items, checking first for duplicates. |
| "Update tasks on my tracker: the login fix is done" | Finds the items and changes their status, notes or dates. |
| "Log this session as Claude work on my tracker" | Adds a Claude work item with a link to the session or PR. |
| "For this conversation use project Platform in my tracker and tag with the repos you touch" | Files everything it adds or sends under Platform and tags each item with the repositories involved, creating them if needed. |
| "What's on my tracker?" / "What's left open?" | Summarizes counts, what's in progress, what's due and what's waiting for review. |
| "Check my tracker for feedback on the proposal and revise it" | Reads your decision and feedback and sends a new version. |
| "Save this to my editor as deploy-notes.md" / "Find the SQL I pasted about invoices in my editor files" | Saves, finds and reads your Tracker Editor files. |

Claude only deletes items when you explicitly ask. It never reads or changes files you encrypted in Tracker Editor. Every change it makes is a commit in your data repo, so anything can be undone from the repo history.

## 12. Tracker Editor

Tracker Editor (https://github.com/divaor/tracker-editor) is the companion text editor: many files open in tabs, synced to the same data repo with the same projects and tags.

- Items sent from the editor get **Open in editor**, and attached files get **Edit in editor**.
- Set its address in **Settings → Tracker Editor** (blank = the default web app). The desktop app opens these links in the editor's desktop app when it is installed.

## 13. Notifications

You can be notified when:

- Claude sends a **document to review** (or a new version), or stores a file.
- Claude **adds, updates, completes or deletes** items.
- On the desktop, an item changes **on one of your other devices**, for example a task you completed on your phone.

Tap a notification to open that item.

- **Phone:** in the installed app, go to **Settings → Notifications**, enter your connector's address (without `/mcp`) and tap **Turn on notifications**. Do this on each phone or browser you want notified. On iPhone this needs iOS 16.4 or later, with the app opened from its Home Screen icon. The phone gets push notifications even when the app is closed.
- **Desktop:** notifications are on by default. The app checks for changes every minute; with *Keep running in the background* on, closing the window leaves it in the system tray (quit from the tray icon).

Choose what you hear about in **Settings → Notifications**.

## 14. Sync, offline and backups

- **On this computer only** (the default): there is nothing to sync and no badge; the data is saved as you work.
- **Offline first:** everything works without a connection, and changes sync when you're back online.
- **Automatic sync** runs after edits, every few minutes and when the app comes back into focus. The badge in the sidebar (or the cloud icon on the phone) shows the state; click it to sync now (**Ctrl+Shift+S** on the desktop).
- **Conflicts** are resolved per item: the most recent edit wins. Deletions sync too.
- **Backups:** every sync is a commit in your data repo. You can also use **Settings → Your data → Export backup**. **Import backup** merges a file into what's there; for each item the newest version wins.
- **Theme:** system, light or dark, in **Settings → Appearance**.

## 15. Keyboard shortcuts and Help

Press **F1** or **?** to open Help: **Commands and shortcuts** lists everything the app can do with its keys. Type to find one (*sync*, *board*, *ctrl+enter*…), click it (or press **Enter** for the first match) to run it, or press **Print** to keep the cheat sheet on paper or as a PDF. **Guide** is this text, with its sections on the side and a search.

| Keys | Action |
| --- | --- |
| **N** | New item |
| **/** | Search (**Ctrl+F** on the desktop) |
| **Esc** | Clear the search, or close what's open |
| **E** | Edit the open item |
| **Ctrl+Enter** | Save the item |
| **Ctrl+Shift+S** | Sync now (desktop) |
| **Ctrl+,** | Settings (desktop) |
| **Ctrl+Alt+T** | Quick add from any app (desktop, when turned on) |
| **F1** · **?** | Help |

On a Mac, use **Cmd** for **Ctrl**.

## 16. Troubleshooting

| Problem | Fix |
| --- | --- |
| Sync shows an error about the token | The token expired or lost access. Create a new fine-grained token for your data repo (Contents: Read and write) and paste it in Settings → Sync with GitHub (Where your data is when not syncing). |
| "Set up GitHub sync to open attached files" | Files are read from your data repo, so that device needs sync set up. |
| No notifications on iPhone | Needs iOS 16.4 or later, with the app opened from its Home Screen icon (not Safari). Then turn notifications on again in Settings. |
| Claude says the connector isn't available | Turn Tracker on under **+ → Connectors** in that chat. If it asks you to sign in again, enter the connector password. |
| Remove Claude's access everywhere | Change the connector's `MCP_SECRET` and deploy it again. Every Claude sign-in and phone notification subscription stops working until you connect again. |
| The quick add shortcut does nothing | Another app may own the keys: Settings → Quick add says so. Pick other keys. |
| The model doesn't answer | Settings → Model → **Test and list models**. A local server must be running; in a browser, Ollama must allow the site (`OLLAMA_ORIGINS`). With an AI provider: check the key and that the account has credit; a provider that refuses requests from web pages works from the desktop app. |
| The phone app shows an old version | Close it completely and open it again while online. It updates itself on the next start. |

## 17. Updates and releases

All of this runs from the **Actions** tab of the app's repository, so it also works from your phone.

- **Web and phone app:** deploys by itself when changes to `app/` reach `main`.
- **Desktop app:** after the version is bumped (`package.json`, `app/js/version.js` and the cache name in `app/sw.js`), run **Release desktop app** with the new tag (for example `v1.6.0`), or push the tag. It builds the installers and publishes the release.
- **Claude connector:** run **Deploy Claude connector** after it changes. Its secrets live in the repository's Actions secrets.
