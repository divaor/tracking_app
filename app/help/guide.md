# Tracker guide

One place for your tasks, ideas, the Claude work you have going and the documents you need to read, on your computers, your phone and inside Claude.

Version 2.1.0 · Download: https://github.com/divaor/tracking_app/releases/latest · Web app: https://divaor.github.io/tracking_app/

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

### Android: the Tracker app

An app for your phone, updated from the releases like the desktop app. It works offline and syncs when you're online.

1. Install **Obtainium** (from https://github.com/ImranR98/Obtainium/releases or F-Droid). It installs apps from their GitHub releases and keeps them up to date.
2. In Obtainium: **Add app**, paste `https://github.com/divaor/tracking_app`, **Add**, then **Install** (`Tracker-<version>.apk`). The first time, Android asks to let Obtainium install apps: allow it.
3. Open Tracker and connect it to your data (below). Obtainium tells you when there's a new version and installs it over the old one; your items and settings stay. (Or download the `.apk` from the releases page and open it; then updates are by hand.)

What the app adds over the web app:

- **Share → Tracker** from any app. Text and links become a new item to look over before you add it. Pictures and other files become a new item, or go on an item you pick.
- **Add to Tracker** in the menu of text you select in any app: a new item from it.
- **Long-press the icon** for **Quick add**, **Voice note** (say the item) and **Send a log**.
- **Notifications while the app is closed**: it looks for what Claude and your other devices changed about every 15 minutes (section 13).
- **The phone's own voices** for Listen (Google's, or an engine you install), and **its speech input** for the microphone in quick add.
- **Attachments open with your phone's apps** (a PDF in your PDF reader, a spreadsheet in Sheets), and **Download** and **Export** ask where to save.
- A model or speech server on your computer (Ollama, Kokoro) works at its address on your network, such as `http://192.168.1.20:11434/v1`, with no extra setup.
- **Back** closes what is open, then goes to the Overview.
- The GitHub token and your keys are kept encrypted with a key in the phone's secure hardware, and left out of Android's backups.

### iPhone (and any phone's browser)

The web app installed to your Home Screen. It works offline and syncs when you're online.

1. Open https://divaor.github.io/tracking_app/ in Safari (iPhone) or Chrome.
2. Install it. On **iPhone**: Share → **Add to Home Screen**. On **Android** (instead of the app): ⋮ → **Install app**.
3. Open it from the new icon and connect it to your data (below).

### Desktop (Windows, Mac, Linux)

Download the file for your computer from the latest release (https://github.com/divaor/tracking_app/releases/latest):

- **Windows:** `Tracker.Setup.<version>.exe` installs it. If you can't install software (for example on a work PC), `Tracker-<version>-portable.exe` runs without installing.
- **Mac (Apple silicon):** the `.dmg`. Open it and drag Tracker to Applications.
- **Linux:** the `.AppImage`. Make it executable (`chmod +x`) and run it.

The installers aren't code-signed, so your computer warns you once. Windows SmartScreen: **More info → Run anyway**. Mac: right-click the app → **Open**.

The desktop app looks and works like the web app. It also shows native notifications, opens a quick add window from any app, can keep running in the system tray when you close the window, and opens links to your items that your browser hands over (section 11).

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

The home screen shows what needs attention: your **pinned** items, **due soon**, **in progress**, **up next**, your **reading list** and **recently completed** items, with a quick add at the top. Click any card to open it. Click the round status icon on a card to move it to the next status.

With a model connected, the Overview can also **Plan my day** or **Review my week**, and keep them (see [Your day's plan and your week's review](#your-days-plan-and-your-weeks-review)).

The sidebar lists the categories, your projects and your most used tags, each with its count of open items. On a phone, the bottom bar switches between Home, Board, Items and Settings, the round button adds an item, and ☰ opens the sidebar.

### Your day's plan and your week's review

The **Your day** card on the Overview asks your model (section 9) to **Plan my day**: what to do first today and why, from your open items. Its **Week** tab does **Review my week**: what got done, what is stuck or overdue and what to focus on next.

- **It is kept** with your data (a small file a day under `plans/`), so your other devices see it, and so does Claude. It says when and where it was made, and what changed since (*2 done, 1 added since*).
- **Update** asks again with the plan and what changed since it was made: the items done, started and added since, and those overdue now. The model keeps what still holds and fits in what is new. Each update keeps the one before: **‹ ›** shows the earlier ones of the day, **Latest** goes back.
- **By itself:** tick **Settings → Model → Make and update today's plan by itself** (off at first). The plan is then made the first time the app is open each day (from 6:00) and updated after you finish, start or add items, at most every 2 hours, while the app is open. Each one is a request to your model.
- **Above List and Board** today's plan shows as a strip over the items, a few lines of it: click it to read it all, or **Update** it there. **×** hides it in that view (List and Board apart, on each device); **Today's plan** in the toolbar brings it back.
- **No model?** Ask Claude with the connector: *"plan my day in my tracker"* (section 11). It is kept the same way, marked as made by Claude.
- **Listen** to it: the speaker on the card, the strip or in Days (see [Listen](#listen)).

### Days: looking back

**Days** in the sidebar (or the calendar on the plan card) shows how much got done each day of the last four weeks, as bars; a dot under a bar means a plan was kept that day. Click a bar, step with **‹ ›** or pick a date to see that day: its plan and its week review (with their earlier versions), what got **done**, **started** and **added**, and the **comments** written, yours and Claude's. Each day has its own address (`#/days/2026-10-29`), and **Today** comes back.

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

- **Search** (`/`) finds words in the titles, notes, comments, review feedback, links, file names, tags and item IDs, wherever they are in an item (every word you type, in any order). Capitals and accents don't matter: *cancion* finds *canción*. Put words in quotes for a phrase as written (`"deploy the api"`). Use `#tag` for a tag or `+project` for a project. **Esc** in the search box clears it.
- Typing a search on the **Overview** shows the matches in **All items**. The filters stay: the type, the status, and the projects picked in the bar above apply to what is found (on the board too).
- **Each result shows where it matched**: the words are marked in its title, and when they are not all in the title, the passage that has them shows under it, with where it is from (**Notes**, **Comment**, **Claude**, **Feedback**, **File**, **Link**).
- **Open a result** and it opens finding those words: they are marked in the item and it scrolls to the first one (see [Find in an item](#find-in-an-item)).
- **Paste a link to an item** (the ones Claude gives, `…/#/item/…`) **or its ID** in the search box to open that item.
- **Part of an ID works too**: paste a piece Claude gave you (`27e83a7b`, `mvtquqbr`, `mvtquqbr-27e8…`, 6 characters or more), or type it and press **Enter**, and the item it belongs to opens. While you type, the list shows the items whose ID has it.
- Click a **tag** in the sidebar or on an item to see everything with that tag (the sidebar marks the tag searched for). Click a **project chip** to show that project.
- The sidebar lists the first 12 projects and tags; **N more** shows all of them (and **Fewer** the first ones again). Each device remembers it.

### Pinned items

Pin an item (the pin at the top of an open item, or **P**) to keep it on top: first on the Overview (under **Pinned**, whatever its status), and first in the list and in its column on the board, grouped by project. It is marked with a pin and tinted in its project's color, and clicking the pin unpins it (with **Undo**).

The filters apply to pinned items like to any other: a type, a status, a `#tag`, a `+project`, the projects picked in the bar above or words you search for show a pinned item only when it matches, and then on top of the rest. **Projects → Manage** counts each project's pinned items.

To keep them in view instead, tick **Settings → Appearance → Show pinned items whatever the filters** (off at first; also in Help): pinned items then show on top of every list and board column whatever type, status or `#tag` you pick, as long as their project is shown (the projects picked, `+project` and words you search for still apply).

## 7. Opening and editing an item

Click an item to open it. Its top stays in place while you scroll the content, set apart by its own shade and an edge, so it never reads as part of the notes:

- the **title**;
- the **status** buttons, with the **priority** on their right (change either right there);
- the **project** and **tags**.

The eye in the item's bar chooses which of status, priority, project and tags show (each device remembers it); the title always shows. **Its ID and link** (off at first) adds the item's ID with **Copy ID** and **Copy link**, to compare it with the one Claude names or to send the link.

IDs of other items in the notes (Claude often names items by their ID) are links: click one to open that item, **Ctrl+click** for a window (below). Links to items open here too.

Press the pencil (or **E**) to edit, or the pin (or **P**) to pin it (section 6). You can change its type, status, priority, due date, project, link and tags, and write notes in Markdown.

- **Checklists:** write `- [ ] step` lines. You can tick them right in the reader, and cards show the progress (for example 1/3).
- **Tags** are chips: type one and press Enter (Backspace in an empty field removes the last one). Suggestions come from tags you already use.
- **Documents:** paste text, use **Import file**, or drop Markdown files onto the window to add them to your reading list.
- Save with **Ctrl+Enter** (**Cmd+Enter** on a Mac); **Esc** closes (and asks before dropping unsaved changes). Deleting an item or marking it done shows an **Undo** button for a few seconds. Saving changes only what you changed, so an edit made meanwhile somewhere else stays.

### Listen

The speaker in an open item's bar (or **L**) reads it to you: the title, the notes, the document open in it and the comments, each with who wrote it. It reads what the item shows, not its buttons, fields or dates; code is announced, not read.

- **The sentence being read is marked**, and the item scrolls to keep it in view.
- It starts at the title, or where you have scrolled to, or with the words you selected.
- **The player** at the bottom: **◀ ▶** the sentence before or after, **play/pause**, the speed (**1×**, click for faster), the voice, and **×** to stop. The speaker in the item pauses and goes on too.
- Reading stops when you close the item or start editing it. Each item window reads on its own (desktop).
- **Plans and documents:** the speaker on the Overview's plan card, the strip above List and Board and the plans in **Days** reads that plan or review; **Listen** in a document's bar (Markdown or text files in an item) reads only that document.
- **The voice:** **Settings → Read aloud**, the same as in Tracker Editor:
  - **This device:** the voices of your phone or computer, the most natural one for the text's language unless you pick one. The list shows them by name, accent and voice (female or male), the text's language first; ▶ plays one. How human it sounds depends on the voices installed (the card says how to get better ones).
  - **Speech server:** natural voices from **Kokoro** on your computer (free, nothing leaves it) or **OpenAI** (with your key), or another server with an OpenAI-compatible API. Its key stays in this device's secure storage and goes only to that server. In a browser, a server on your computer is reachable only from that computer; the desktop app also reaches one elsewhere on your network.
- With a speech server, your phone's or computer's media controls (lock screen, keyboard keys) pause and skip too.

### Find in an item

**Ctrl+F** (**Cmd+F** on a Mac), **/** or the magnifier in an open item's bar shows a find bar under its title. Type, and the words are marked in the item (its notes, the file it shows, its comments), with how many there are (*2 of 5*):

- **Enter** (or the down arrow) goes to the next one, **Shift+Enter** (or the up arrow) to the one before; the item scrolls there.
- Words are found apart, in any order; `"a phrase"` in quotes as written. Capitals and accents don't matter.
- **Esc** closes the bar (a second **Esc** closes the item). Opening an item from a search fills the bar with the words searched for.
- It keeps up with the item: a file that finishes loading, or a comment that arrives, is searched too. Text in an HTML file's preview isn't searched (its **Source** view is).
- Each item window has its own (desktop).

### Files and pictures

Any item can carry files: photos, screenshots, PDFs, Word, Excel and PowerPoint files, notes, anything up to 25 MB each.

- **Attach** under the notes picks files. You can also **drop** files on an open item, or **paste** a picture (a screenshot, an image copied from a page). On a phone, **Photo** takes one with the camera.
- **Pictures** show as small versions; a click shows one large. **←** and **→** go through them, the magnifier shows it at full size, **Esc** closes it (the item stays open). Download, open with its program (desktop app) or remove it from there.
- **Text files** (Markdown, txt, CSV, code…) read inside the item; **Edit in editor** opens them in Tracker Editor.
- **PDFs and documents** are chips with their type and size. A click opens one with its program in the desktop app (a copy, so changes there don't come back); in a browser it downloads. **Open in editor** (the `</>` button) shows a PDF, Word or other document as it looks in Tracker Editor. Programs and scripts are never opened.
- **Photos over 4 MB are made smaller** (2,560 pixels on the long side) so your data repo doesn't fill up with phone photos. The message says so; **Keep full size** puts the original back.
- Files are kept with your data, next to Claude's documents (`files/` in your data repo, or the data on this device), so every device and Claude see them. A file added without a connection shows an upload arrow and goes up with the next sync.
- The bin on a file (or in the large picture) removes it from the item, with **Undo**. Its versions stay in the data repo's history.
- Lists and board cards show 📎 and how many files an item has. File names count in search.
- **Claude can attach them too**: ask it to attach a screenshot, a chart or a PDF to an item (section 11).

### Comments

Every item, not only documents, has **Comments** under its notes: what to change, a question, a decision, a note to yourself. Claude reads them through the connector and answers there.

- Write in the box (or press **C** to go to it) and press **Comment** or **Ctrl+Enter**. Comments are Markdown; item IDs in them are links.
- Each one says who wrote it: **You** (with the device) or **Claude**, in its own color. Edit yours with the pencil; delete any with the bin (**Undo** brings it back).
- Then tell Claude *"check my tracker for comments"*: it finds the items whose latest comment is yours, reads them, does what they ask and replies, for example with what it changed and a link.
- Lists and board cards show how many comments an item has; the count turns Claude's color when the last one is Claude's answer.
- A comment you started stays in the box if you close the item. Search finds words in comments, and **Ask the model about this** reads them too.
- Comments written at the same time on two devices are both kept.

### Several items at once (desktop)

To compare items, or keep one at hand while you open others, open them in **windows** inside the app:

- In an open item, press the window button (or **W**): it moves to a window at the side, scrolled where you were.
- **Ctrl+click** (**Cmd+click** on a Mac) or **middle-click** an item to open it straight in a window. Do it again on the same item for a second view of it, to read two parts at once.
- A plain click still opens the item as usual, over everything.
- **Drag** a window by its top bar, **resize** it from its edges, **double-click** the bar to maximize it.
- **Minimize** puts it in the bar at the bottom, out of the way. Click its name there to bring it back, or to bring it to the front.
- The bar also has **Side by side** (every open window next to each other), **Minimize all** and **Close all**; the desktop app has them in the **View** menu too.
- **Esc** closes the window you are in. Each window has its own scroll position and can be edited on its own.

On a phone, items open one at a time as before.

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
- **Plan my day** / **Review my week** on the Overview, kept and updated as the day goes, by itself if you like (see [Your day's plan and your week's review](#your-days-plan-and-your-weeks-review)).
- **Quick add in plain language** (section 4).

## 10. Documents and reviews

Documents Claude sends arrive under **Docs**, with the file attached and a short summary of what to decide. They're stored in your data repo under `files/`.

- **Markdown** files are rendered, with tables, code and checklists.
- **HTML artifacts** are shown in a safe preview with scripts turned off.
- **Source** shows the raw file, and **Download** saves it.
- **Edit in editor** opens the file in Tracker Editor; your edits come back here.
- Pictures, PDFs and documents you attach yourself work the same on any item: see [Files and pictures](#files-and-pictures).

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
| "Pin the release checklist in my tracker" / "Unpin it" | Pins or unpins items, so they stay on top of their project (section 6). |
| "Log this session as Claude work on my tracker" | Adds a Claude work item with a link to the session or PR. |
| "Attach this screenshot to the checkout task in my tracker" | Attaches the picture (or a PDF or any file up to 10 MB) to the item, shown like your own. From Claude Code it sends files from your computer (a screenshot it took, a chart it made); in a chat, files from a public link. A file of the same name is replaced. |
| "For this conversation use project Platform in my tracker and tag with the repos you touch" | Files everything it adds or sends under Platform and tags each item with the repositories involved, creating them if needed. |
| "What's on my tracker?" / "What's left open?" | Summarizes counts, what's in progress, what's due and what's waiting for review. |
| "Check my tracker for feedback on the proposal and revise it" | Reads your decision and feedback and sends a new version. |
| "Check my tracker for comments" | Finds the items whose latest comment is yours, reads them, acts on them and replies in the comments. |
| "Plan my day in my tracker" / "Update my plan, the parser is done" | Writes the day's plan (or the week's review) from your items and keeps it on the tracker, a new version each time: the Overview, the strip over List and Board and Days show it. |
| "What did I get done this week?" | Reads the plans and reviews kept and what got done each day. |
| "Save this to my editor as deploy-notes.md" / "Find the SQL I pasted about invoices in my editor files" | Saves, finds and reads your Tracker Editor files. |

### Links Claude gives you

Claude links to items as `https://divaor.github.io/tracking_app/#/item/<ID>`:

- **On your phone**, or in a browser where your data syncs, the link opens the item.
- **In the desktop app**, paste the link, the ID or part of it in the search box.
- **In a browser on your computer that doesn't sync your data** (the link opens there, not in the desktop app), the page offers **Open in the app**: the desktop app opens the item. The browser may ask once to allow it (tick *Always allow*); after that, such links go to the app straight away. Turn that off in **Settings → Use it everywhere → Open item links in the desktop app**.

Claude sees the files on an item and can look at the pictures (a screenshot of a problem, a photo of a whiteboard): ask *"look at the screenshot on the kitchen leak task"*. It cannot read PDFs or Word files through the tracker.

Claude only deletes items when you explicitly ask. It never reads or changes files you encrypted in Tracker Editor. Every change it makes is a commit in your data repo, so anything can be undone from the repo history.

## 12. Tracker Editor

Tracker Editor (https://github.com/divaor/tracker-editor) is the companion text editor: many files open in tabs, synced to the same data repo with the same projects and tags.

- Items sent from the editor get **Open in editor**, attached text files get **Edit in editor**, and PDFs and documents get **Open in editor** (shown as they look; Tracker Editor 0.34 or later).
- Set its address in **Settings → Tracker Editor** (blank = the default web app). The desktop app opens these links in the editor's desktop app when it is installed.

## 13. Notifications

You can be notified when:

- Claude sends a **document to review** (or a new version), or **attaches** a picture or file to an item.
- Claude **adds, updates, completes or deletes** items, or **answers in the comments** (the notification shows the start of its comment).
- On the desktop, an item changes **on one of your other devices**, for example a task you completed on your phone.

Tap a notification to open that item.

- **Android app:** notifications while the app is closed are on once you set up GitHub sync: allow them when Android asks (or **Settings → Notifications → Allow notifications**). The app looks about every 15 minutes (the shortest Android allows); **Look now** looks at once. While the app is open, changes show at once. Changes from your other devices are told only with **Changes from my other devices** on, and never this phone's own.
- **Phone (web app):** in the installed app, go to **Settings → Notifications**, enter your connector's address (without `/mcp`) and tap **Turn on notifications**. Do this on each phone or browser you want notified. On iPhone this needs iOS 16.4 or later, with the app opened from its Home Screen icon. The phone gets push notifications even when the app is closed.
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
| **Ctrl+F** · **/** | Find in the open item; **Enter** / **Shift+Enter** the next / previous match |
| **Esc** | Clear the search, or close what's open |
| **E** | Edit the open item |
| **P** | Pin or unpin the open item |
| **C** | Comment on the open item |
| **L** | Listen to the open item (again: pause or go on) |
| **W** | Open the open item in a window (desktop) |
| **Ctrl+click** · middle-click | Open an item in a window (desktop) |
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
| Claude doesn't see my comment | Claude reads your data repo: the device you commented on must be set up with GitHub sync and have synced (the badge says *Synced*). On a device that keeps its data on this computer, the connector can't reach it. |
| A link from Claude opens the browser, not the app | Click **Open in the app** in the message the page shows (needs the desktop app 1.11 or later), or paste the link in the app's search box. |
| Listen says it cannot read aloud, or nothing is heard | The browser has no voices: try another browser (Edge and Chrome have good ones), install voices (Settings → Read aloud says how), or use a speech server. |
| "Could not reach the speech server" | Kokoro (or your server) isn't running, or the address is wrong. In a browser, a server at `localhost` works only on that computer; use the desktop app, or an https server like OpenAI. |
| The plan doesn't update by itself | It needs the setting on (Settings → Model), a model connected and the app open (in a browser, its tab in front); it waits 2 hours after the last plan and for an item done, started or added since. |
| Days shows no plan for a day | Only plans made from 1.17 on are kept. On a device that keeps its data on this computer, Claude's plans don't reach it. |
| A file shows an upload arrow | It is waiting to upload from that device (it was added offline, or the upload failed). It goes up with the next sync; until then other devices say it isn't there yet. |
| "… is not in your data repo (yet)" when opening a file | It was attached on another device that hasn't synced since. Sync that device. |
| A photo was made smaller and you wanted the original | Press **Keep full size** in the message, or attach it again and press it then. |
| Open in editor shows a PDF as strange text | Update Tracker Editor to 0.34 or later. |
| Search doesn't find a phrase | Words without quotes are found apart, anywhere in the item; `"in quotes"` they must be next to each other, as written. A phrase is never found across two parts (the title and the notes, two comments). |
| The phone app shows an old version | Close it completely and open it again while online. It updates itself on the next start. |
| Obtainium says the Android app cannot be updated ("signatures do not match") | An APK built elsewhere (or a test build) is installed. Sync first (or Export a backup), uninstall Tracker and install it again from Obtainium. |
| No notifications from the Android app | Settings → Notifications: GitHub sync must be set up and notifications allowed; **Look now** says when it last looked and any error. Some phones stop background work for apps they think unused: in Android's settings, set Tracker's battery use to *Unrestricted*. |
| The microphone in quick add does nothing (Android app) | The app uses the phone's speech input (Google's): install or turn on the Google app, or Speech Services by Google. |

## 17. Updates and releases

All of this runs from the **Actions** tab of the app's repository, so it also works from your phone.

- **Web and phone app:** deploys by itself when changes to `app/` reach `main`.
- **Desktop and Android apps:** after the version is bumped (`package.json`, `app/js/version.js` and the cache name in `app/sw.js`), run **Release desktop app** with the new tag (for example `v2.0.0`), or push the tag. It builds the installers and the Android app (`Tracker-<version>.apk`, signed with the key in the `ANDROID_KEYSTORE` and `ANDROID_KEYSTORE_PASSWORD` secrets; without them the release has no APK) and publishes the release. Keep a copy of that key: every update must be signed with it.
- **Android check:** Actions → **Android check** runs the app in an emulator and checks what a browser cannot (sharing, links, Back, the phone's voices, notifications).
- **Claude connector:** run **Deploy Claude connector** after it changes. Its secrets live in the repository's Actions secrets.
