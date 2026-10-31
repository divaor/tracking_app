import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { createGitHubClient, decodeBase64, encodeBase64 } from '../github.js';
import { localDate, parseData, serializeDocument } from '../model.js';
import { getSettings, getToken, isLocal, isSyncConfigured, saveSettings, setToken } from '../settings.js';
import { DEFAULT_EDITOR_URL } from '../editorLinks.js';
import { store } from '../store.js';
import { switchStorage, syncNow } from '../syncManager.js';
import { localDataInfo } from '../localData.js';
import { formatDateTime, timeAgo } from '../format.js';
import { APP_VERSION } from '../version.js';
import { Icon } from './icons.js';
import { Segmented, SyncBadge } from './components.js';
import { NotificationsCard } from './notificationsCard.js';
import { ModelCard, QuickAddCard } from './modelCard.js';
import { ReadAloudCard } from './readAloudCard.js';
import { saveToDevice } from '../saveFile.js';
import { isAndroidApp } from '../platform.js';

const SETUP_PREFIX = 'tracker-setup:';
const SYNC_FIELDS = ['owner', 'repo', 'branch', 'path', 'device', 'autoSync'];

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

const download = (filename, text) => saveToDevice(filename, new Blob([text], { type: 'application/json' }));

function environmentLabel() {
  if (isAndroidApp()) return `Android app (WebView ${window.desktop.versions?.chrome ?? ''})`;
  if (window.desktop) return `Desktop app (Electron ${window.desktop.versions?.electron ?? ''})`;
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return 'Installed web app';
  return 'Web browser';
}

function Card({ title, icon, children, id }) {
  return html`<section class="settings-card" id=${id}>
    <h2>${icon && html`<${Icon} name=${icon} size=${18} />`}${title}</h2>
    ${children}
  </section>`;
}

function Field({ label, hint, children, wide = false }) {
  return html`<label class="field ${wide ? 'span-2' : ''}">
    <span>${label}</span>
    ${children}
    ${hint && html`<small>${hint}</small>`}
  </label>`;
}

function SyncCard({ sync, actions }) {
  const local = isLocal();
  // Local mode: the GitHub form opens on request; where the data is kept; a move running.
  const [githubOpen, setGithubOpen] = useState(!local || Boolean(getSettings().owner));
  const [where, setWhere] = useState(null);
  const [moving, setMoving] = useState('');
  useEffect(() => {
    localDataInfo().then(setWhere, () => setWhere({ browser: true }));
  }, []);
  const [form, setForm] = useState(() => pick(getSettings(), SYNC_FIELDS));
  const [token, setTokenValue] = useState('');
  const [savedToken, setSavedToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [check, setCheck] = useState(null);
  const [includeToken, setIncludeToken] = useState(false);
  const [setupCode, setSetupCode] = useState('');

  useEffect(() => {
    getToken().then((t) => {
      setTokenValue(t);
      setSavedToken(t);
    });
  }, []);

  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const clean = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const saved = pick(getSettings(), SYNC_FIELDS);
  const changed = JSON.stringify(clean) !== JSON.stringify(saved) || token.trim() !== savedToken;
  const configured = isSyncConfigured(saved) && Boolean(savedToken);

  const save = async (e) => {
    e.preventDefault();
    if (isLocal()) {
      // From this computer to GitHub: everything here is copied there first, nothing is lost.
      if (!clean.owner || !clean.repo || !token.trim()) return actions.toast('Fill in the owner, the repository and a token first', { kind: 'error' });
      await setToken(token);
      setSavedToken(token.trim());
      setMoving('Copying your data to GitHub…');
      try {
        const moved = await switchStorage('github', { ...clean, path: clean.path || 'tracker.json' });
        actions.toast(`Your data is on GitHub now (${clean.owner}/${clean.repo}${moved.copied ? `, ${moved.copied} files copied` : ''}). Connect Tracker Editor too, with the same token.`, { duration: 10000 });
      } catch (err) {
        actions.toast(`Your data stays on this computer: ${err.message}`, { kind: 'error', duration: 10000 });
      } finally {
        setMoving('');
      }
      return;
    }
    const target = (s) => [s.owner, s.repo, s.branch, s.path].join('/');
    if (target(clean) !== target(saved)) store.markUnsynced();
    saveSettings({ ...clean, path: clean.path || 'tracker.json' });
    await setToken(token);
    setSavedToken(token.trim());
    setCheck(null);
    actions.toast('Sync settings saved');
    syncNow();
  };

  const test = async () => {
    setCheck({ state: 'running', message: 'Checking…' });
    try {
      const client = createGitHubClient({ token: token.trim(), owner: clean.owner, repo: clean.repo });
      const info = await client.getRepo();
      const path = clean.path || 'tracker.json';
      const file = await client.getFile(path, clean.branch || undefined);
      const lines = [`Connected to ${info.full_name} (${info.private ? 'private' : 'public'} repository).`];
      if (file) lines.push(`Found ${path} with ${parseData(file.text).items.filter((i) => !i.deleted).length} items.`);
      else lines.push(`${path} does not exist yet — it will be created on the first sync.`);
      if (!info.private) lines.push('Warning: this repository is public, so anyone can read your tracker data. Use a private repository.');
      if (info.permissions && !info.permissions.push) lines.push('Warning: you do not have write access to this repository.');
      setCheck({ state: info.private ? 'ok' : 'warn', message: lines.join(' ') });
    } catch (err) {
      setCheck({ state: 'error', message: err.message });
    }
  };

  // Back to this computer: GitHub's copy comes here first; the repository keeps everything.
  const keepHere = async () => {
    if (!confirm('Stop syncing with GitHub? Everything is kept on this computer (what is only on GitHub is copied here first), and the repository keeps its copy.')) return;
    setMoving('Copying your data to this computer…');
    try {
      await switchStorage('local');
      setGithubOpen(false);
      actions.toast('Your data is kept on this computer now. Tracker Editor here uses it too once it stops syncing with GitHub.', { duration: 10000 });
    } catch (err) {
      actions.toast(`Still syncing with GitHub: ${err.message}`, { kind: 'error', duration: 10000 });
    } finally {
      setMoving('');
    }
  };

  const copySetup = async () => {
    const payload = pick(clean, ['owner', 'repo', 'branch', 'path']);
    if (getSettings().connectorUrl) payload.connectorUrl = getSettings().connectorUrl;
    if (includeToken) payload.token = token.trim();
    const code = SETUP_PREFIX + encodeBase64(JSON.stringify(payload));
    try {
      await navigator.clipboard.writeText(code);
      actions.toast('Setup code copied');
    } catch {
      setSetupCode(code);
      actions.toast('Copy the code from the box below');
    }
  };

  const applySetup = () => {
    try {
      const data = JSON.parse(decodeBase64(setupCode.trim().replace(SETUP_PREFIX, '')));
      setForm({ ...form, ...pick(data, ['owner', 'repo', 'branch', 'path']) });
      if (data.token) setTokenValue(data.token);
      if (typeof data.connectorUrl === 'string') saveSettings({ connectorUrl: data.connectorUrl });
      setSetupCode('');
      actions.toast('Setup code applied — review and press Save');
    } catch {
      actions.toast('That does not look like a setup code', { kind: 'error' });
    }
  };

  const statusPart = html`
    <div class="sync-status">
      <${SyncBadge} sync=${sync} onClick=${() => syncNow()} />
      <span class="muted">
        ${configured ? `${saved.owner}/${saved.repo}${saved.branch ? ` @ ${saved.branch}` : ''} · ${saved.path}` : 'Not connected — items are only stored on this device.'}
        ${sync.lastSyncAt && html` · last sync ${timeAgo(sync.lastSyncAt)}`}
      </span>
      <button type="button" class="btn sm" disabled=${!configured || sync.phase === 'syncing'} onClick=${() => syncNow()}>
        <${Icon} name="sync" size=${15} />Sync now
      </button>
    </div>
    ${sync.phase === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${16} />${sync.error}</p>`}`;

  const githubPart = html`
    <form class="field-grid settings-form" onSubmit=${save}>
      <${Field} label="GitHub owner" hint="Your username or organization">
        <input value=${form.owner} onInput=${set('owner')} placeholder="your-username" autocomplete="off" autocapitalize="off" spellcheck=${false} />
      </${Field}>
      <${Field} label="Repository" hint="A private repo, e.g. tracker-data">
        <input value=${form.repo} onInput=${set('repo')} placeholder="tracker-data" autocomplete="off" autocapitalize="off" spellcheck=${false} />
      </${Field}>
      <${Field} label="Branch" hint="Blank = the repo’s default branch. Created if missing.">
        <input value=${form.branch} onInput=${set('branch')} placeholder="(default branch)" autocomplete="off" autocapitalize="off" spellcheck=${false} />
      </${Field}>
      <${Field} label="Data file" hint="Path inside the repository">
        <input value=${form.path} onInput=${set('path')} placeholder="tracker.json" autocomplete="off" autocapitalize="off" spellcheck=${false} />
      </${Field}>
      <${Field} label="Personal access token" wide
        hint=${isAndroidApp() ? 'Stored encrypted with a key kept in this phone’s secure hardware.' : window.desktop ? 'Stored encrypted with your operating system’s keychain.' : 'Stored only in this browser.'}>
        <div class="input-row">
          <input type=${showToken ? 'text' : 'password'} value=${token} onInput=${(e) => setTokenValue(e.currentTarget.value)}
            placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck=${false} />
          <button type="button" class="btn sm" onClick=${() => setShowToken(!showToken)}>${showToken ? 'Hide' : 'Show'}</button>
        </div>
      </${Field}>
      <${Field} label="This device’s name" hint="Shown in commit messages">
        <input value=${form.device} onInput=${set('device')} placeholder="Work PC" />
      </${Field}>
      ${!local &&
      html`<label class="field checkbox">
        <input type="checkbox" checked=${form.autoSync} onChange=${set('autoSync')} />
        <span>Sync automatically<small>After edits, every 5 minutes and when the app regains focus</small></span>
      </label>`}
      <div class="form-actions span-2">
        <button type="submit" class="btn primary" disabled=${(!local && !changed) || Boolean(moving)}>${local ? 'Copy my data to GitHub and sync' : 'Save'}</button>
        <button type="button" class="btn" disabled=${!clean.owner || !clean.repo || !token.trim()} onClick=${test}>Test connection</button>
      </div>
    </form>
    ${check && html`<p class="notice ${check.state}">${check.message}</p>`}

    <details class="help">
      <summary>How do I set this up?</summary>
      <ol>
        <li>Create a <strong>private</strong> repository on GitHub for your data, e.g. <code>tracker-data</code> (it can be empty).</li>
        <li>
          Create a token: GitHub → Settings → Developer settings → Personal access tokens →
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Fine-grained tokens</a>.
          Under <em>Repository access</em> choose <em>Only select repositories</em> and pick the data repository.
          Under <em>Permissions → Repository permissions</em> set <strong>Contents</strong> to <strong>Read and write</strong>.
        </li>
        <li>Fill in the owner, repository and token above, press <em>Test connection</em>, then <em>Save</em>.</li>
        <li>On your phone and other computers, enter the same settings (or use a setup code below).</li>
      </ol>
      <p class="muted">Each change is committed to the data file, so the repository history doubles as a backup.</p>
    </details>

    <details class="help">
      <summary>Copy these settings to another device</summary>
      <p class="muted">A setup code fills in the repository settings on another device. Include the token only if you send the code somewhere private, such as your password manager.</p>
      <label class="field checkbox">
        <input type="checkbox" checked=${includeToken} onChange=${(e) => setIncludeToken(e.currentTarget.checked)} />
        <span>Include the token</span>
      </label>
      <div class="form-actions">
        <button type="button" class="btn sm" disabled=${!form.owner || !form.repo} onClick=${copySetup}><${Icon} name="copy" size=${15} />Copy setup code</button>
      </div>
      <div class="input-row">
        <input value=${setupCode} onInput=${(e) => setSetupCode(e.currentTarget.value)} placeholder="Paste a setup code" autocomplete="off" />
        <button type="button" class="btn sm" disabled=${!setupCode.trim()} onClick=${applySetup}>Apply</button>
      </div>
    </details>`;

  if (local) {
    return html`<${Card} title="Where your data is" icon="folder" id="sync">
      <p class="muted">
        ${where?.dir
          ? html`Kept on this computer, in <code>${where.dir}</code>. Tracker Editor on this computer uses the same folder: your projects and documents show in both, and its Send to tracker reaches you here.`
          : 'Kept in this browser, on this device. Tracker Editor opened in this browser (or installed from it) shares it.'}
      </p>
      ${where?.dir && html`<div class="form-actions"><button type="button" class="btn sm" onClick=${() => window.desktop.data.show()}><${Icon} name="folder" size=${15} />Show the folder</button></div>`}
      ${moving && html`<p class="notice"><${Icon} name="sync" size=${16} />${moving}</p>`}
      ${githubOpen
        ? html`<h3 class="card-subtitle">Sync across your devices with GitHub</h3>
            <p class="muted small">Everything here is copied to your private data repository first, so nothing is lost; then this app syncs with it (and so can your phone, other computers, Tracker Editor and the Claude connector).</p>
            ${githubPart}`
        : html`<div class="field-grid">
              <${Field} label="This device’s name" hint="Shown on items changed here"><input value=${form.device} onInput=${set('device')} onChange=${() => saveSettings({ device: form.device.trim() })} placeholder="Work PC" /></${Field}>
            </div>
            <button type="button" class="btn link" onClick=${() => setGithubOpen(true)}>Sync across your devices with GitHub…</button>`}
    </${Card}>`;
  }

  return html`<${Card} title="Sync with GitHub" icon="cloud" id="sync">
    ${statusPart}
    ${moving && html`<p class="notice"><${Icon} name="sync" size=${16} />${moving}</p>`}
    ${githubPart}
    <button type="button" class="btn link" disabled=${Boolean(moving)} onClick=${keepHere}>Stop syncing with GitHub and keep everything on this computer…</button>
  </${Card}>`;
}

const CONNECTOR_GUIDE = 'https://github.com/divaor/tracking_app/blob/HEAD/mcp/README.md';

function ConnectorCard() {
  return html`<${Card} title="Claude connector" icon="claude" id="connector">
    <p>
      Let Claude work with your tracker from any chat or Claude Code session: “send this proposal to my tracker”, “send the artifact to my
      tracker”, “update tasks on my tracker”, “check my tracker for comments”.
    </p>
    ${isLocal() && html`<p class="notice"><${Icon} name="cloud" size=${16} />The connector reaches your data on GitHub: turn on <strong>Sync across your devices with GitHub</strong> above first.</p>`}
    <ol class="connector-steps">
      <li>Deploy the connector once: a small free Cloudflare Worker that reads and writes your data repository.</li>
      <li>In Claude, open <strong>Customize → Connectors → Add custom connector</strong> and paste its address ending in <code>/mcp</code>.</li>
      <li>Claude opens a sign-in page: enter your connector password and press <strong>Allow</strong>.</li>
      <li>It then works in Claude on the web, desktop and phone, and in Claude Code when you are signed in with the same account.</li>
    </ol>
    <a class="btn sm" href=${CONNECTOR_GUIDE} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${15} />Step-by-step setup guide</a>
    <p class="muted small connector-note">
      Proposals and artifacts Claude sends show up under Docs with their files. Open one to read it, then approve, request changes or reject
      and leave feedback; Claude can read your decision back. Comments on any item reach Claude too, and it answers there.
    </p>
  </${Card}>`;
}

function EditorCard() {
  const [url, setUrl] = useState(getSettings().editorUrl);
  const [installed, setInstalled] = useState(null);
  useEffect(() => {
    window.desktop?.hasEditorApp?.().then(setInstalled, () => setInstalled(false));
  }, []);
  return html`<${Card} title="Tracker Editor" icon="code" id="editor">
    <p>
      The companion text editor: many files open at once, synced to the same data repository, with projects and tags shared with the tracker.
      Items sent from it get <strong>Open in editor</strong>, and attached files get <strong>Edit in editor</strong>.
    </p>
    <div class="field-grid">
      <${Field} label="Editor address" hint="Blank = the default address" wide>
        <input value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} onBlur=${() => saveSettings({ editorUrl: url.trim() })}
          placeholder=${DEFAULT_EDITOR_URL} inputmode="url" autocomplete="off" autocapitalize="off" spellcheck=${false} />
      </${Field}>
    </div>
    <div class="form-actions">
      <a class="btn sm" href=${url.trim() || DEFAULT_EDITOR_URL} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${15} />Open the editor</a>
    </div>
    ${installed !== null &&
    html`<p class="muted small">${installed ? 'Links open in the Tracker Editor app on this computer.' : 'Links open in the browser. Install the Tracker Editor desktop app to open them there instead.'}</p>`}
  </${Card}>`;
}

function DataCard({ actions, items }) {
  const fileRef = useRef(null);
  const all = store.all();
  const importFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      const added = store.importData(parseData(await file.text()));
      actions.toast(`Import complete${added > 0 ? ` — ${added} new items` : ''}`);
    } catch (err) {
      actions.toast(err.message, { kind: 'error' });
    }
  };
  const clear = () => {
    const message = isSyncConfigured() ? 'Remove all items from this device? They will be downloaded again from GitHub on the next sync.' : 'Delete all items on this device? Sync is not set up, so this cannot be undone. Export a backup first if unsure.';
    if (!confirm(message)) return;
    store.clear();
    actions.toast('Local copy cleared');
    syncNow();
  };
  return html`<${Card} title="Your data" icon="folder">
    <p class="muted">${items.length} items on this device${all.length > items.length ? ` (plus ${all.length - items.length} deletions waiting to sync)` : ''}.</p>
    <div class="form-actions">
      <button type="button" class="btn" onClick=${() => download(`tracker-backup-${localDate()}.json`, serializeDocument(all, store.allProjects()))}><${Icon} name="download" size=${16} />Export backup</button>
      <button type="button" class="btn" onClick=${() => fileRef.current?.click()}><${Icon} name="upload" size=${16} />Import backup</button>
      <input ref=${fileRef} type="file" hidden accept=".json,application/json" onChange=${importFile} />
      <button type="button" class="btn ghost danger" onClick=${clear}><${Icon} name="trash" size=${16} />Clear local copy</button>
    </div>
    <p class="muted small">Importing merges the file with what is here; for each item the most recently edited version wins.</p>
  </${Card}>`;
}

function AppsCard({ installPrompt, onInstall }) {
  const isWeb = !window.desktop;
  return html`<${Card} title="Use it everywhere" icon="install">
    <div class="apps">
      <div>
        <h3>Phone</h3>
        <p><strong>Android:</strong> the Tracker app, from the repository’s <em>Releases</em> (<code>Tracker-…apk</code>), best with Obtainium, which keeps it up to date: share things to it, notifications while it is closed, the phone’s voices. <strong>iPhone</strong> (or any phone): open the web version (GitHub Pages) in the browser and install it: on iPhone tap <em>Share → Add to Home Screen</em>. Both work offline and sync when online.</p>
        ${isWeb && installPrompt && html`<button type="button" class="btn primary sm" onClick=${onInstall}><${Icon} name="install" size=${15} />Install this app</button>`}
      </div>
      <div>
        <h3>Computers</h3>
        <p>Download the desktop app from the repository’s <em>Releases</em> page (Windows installer or portable .exe, macOS .dmg, Linux AppImage), or run it from a clone with <code>npm install</code> and <code>npm start</code>.</p>
        ${isWeb &&
        !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) &&
        html`<label class="field checkbox">
          <input type="checkbox" checked=${getSettings().openItemsInApp} onChange=${(e) => saveSettings({ openItemsInApp: e.currentTarget.checked })} />
          <span>Open item links in the desktop app<small>A link to an item that is not in this browser (as Claude gives) goes to the Tracker app on this computer</small></span>
        </label>`}
      </div>
    </div>
  </${Card}>`;
}

export function SettingsView({ sync, actions, items, installPrompt, onInstall, theme }) {
  return html`<div class="settings">
    <${SyncCard} sync=${sync} actions=${actions} />
    <${ConnectorCard} />
    <${EditorCard} />
    <${ModelCard} actions=${actions} />
    <${QuickAddCard} />
    <${ReadAloudCard} settings=${getSettings()} actions=${actions} />
    <${NotificationsCard} actions=${actions} />
    <${Card} title="Appearance" icon="eye">
      <${Segmented} label="Theme" value=${theme} onChange=${(t) => saveSettings({ theme: t })}
        options=${[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} />
      <label class="field checkbox">
        <input type="checkbox" checked=${Boolean(getSettings().pinnedPastFilters)} onChange=${(e) => saveSettings({ pinnedPastFilters: e.currentTarget.checked })} />
        <span>Show pinned items whatever the filters<small>On top of every list and board column, whatever type, status or #tag you filter by, as long as their project is shown. Off: they show only when they match, then on top.</small></span>
      </label>
      <h3 class="settings-sub">Release boards</h3>
      <label class="field inline-number">
        <span>Say a board is quiet after<small>A board with no word from Claude or anyone for longer says so at its top (0: never).</small></span>
        <span class="with-unit"><input type="number" min="0" max="999" step="1" value=${getSettings().boardQuietHours ?? 48}
          onChange=${(e) => saveSettings({ boardQuietHours: Math.max(0, Math.min(999, Math.round(Number(e.currentTarget.value) || 0))) })} /> hours</span>
      </label>
      <label class="field checkbox">
        <input type="checkbox" checked=${getSettings().boardReminders !== false} onChange=${(e) => saveSettings({ boardReminders: e.currentTarget.checked })} />
        <span>Remind me of steps waiting on me<small>A step with a time (“Sun 16:00 UTC”) is notified 15 minutes before, while the app is open (the desktop app also in the background).</small></span>
      </label>
    </${Card}>
    <${DataCard} actions=${actions} items=${items} />
    <${AppsCard} installPrompt=${installPrompt} onInstall=${onInstall} />
    <${Card} title="Help and keyboard shortcuts" icon="help" id="help">
      <dl class="shortcuts">
        <div><dt><kbd>N</kbd></dt><dd>New item</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>Search</dd></div>
        <div><dt><kbd>E</kbd></dt><dd>Edit the open item</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>Enter</kbd></dt><dd>Save</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close</dd></div>
        <div><dt><kbd>F1</kbd> <kbd>?</kbd></dt><dd>Help</dd></div>
      </dl>
      <div class="form-actions">
        <button type="button" class="btn" onClick=${() => actions.help('commands')}><${Icon} name="list" size=${16} />All commands and shortcuts</button>
        <button type="button" class="btn" onClick=${() => actions.help('guide')}><${Icon} name="doc" size=${16} />Guide</button>
      </div>
    </${Card}>
    <p class="about muted">Tracker ${APP_VERSION} · ${environmentLabel()}${store.meta.lastSyncAt ? ` · last synced ${formatDateTime(store.meta.lastSyncAt)}` : ''}</p>
  </div>`;
}
