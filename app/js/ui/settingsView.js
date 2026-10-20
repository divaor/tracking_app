import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { createGitHubClient, decodeBase64, encodeBase64 } from '../github.js';
import { localDate, parseDocument, serializeDocument } from '../model.js';
import { getSettings, getToken, isSyncConfigured, saveSettings, setToken } from '../settings.js';
import { store } from '../store.js';
import { syncNow } from '../syncManager.js';
import { formatDateTime, timeAgo } from '../format.js';
import { APP_VERSION } from '../version.js';
import { Icon } from './icons.js';
import { Segmented, SyncBadge } from './components.js';
import { NotificationsCard } from './notificationsCard.js';

const SETUP_PREFIX = 'tracker-setup:';
const SYNC_FIELDS = ['owner', 'repo', 'branch', 'path', 'device', 'autoSync'];

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function environmentLabel() {
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
      if (file) lines.push(`Found ${path} with ${parseDocument(file.text).filter((i) => !i.deleted).length} items.`);
      else lines.push(`${path} does not exist yet — it will be created on the first sync.`);
      if (!info.private) lines.push('Warning: this repository is public, so anyone can read your tracker data. Use a private repository.');
      if (info.permissions && !info.permissions.push) lines.push('Warning: you do not have write access to this repository.');
      setCheck({ state: info.private ? 'ok' : 'warn', message: lines.join(' ') });
    } catch (err) {
      setCheck({ state: 'error', message: err.message });
    }
  };

  const disconnect = async () => {
    if (!confirm('Stop syncing on this device? Your items stay here; the token is removed from this device.')) return;
    await setToken('');
    setTokenValue('');
    setSavedToken('');
    syncNow();
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

  return html`<${Card} title="Sync with GitHub" icon="cloud" id="sync">
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
    ${sync.phase === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${16} />${sync.error}</p>`}

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
        hint=${window.desktop ? 'Stored encrypted with your operating system’s keychain.' : 'Stored only in this browser.'}>
        <div class="input-row">
          <input type=${showToken ? 'text' : 'password'} value=${token} onInput=${(e) => setTokenValue(e.currentTarget.value)}
            placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck=${false} />
          <button type="button" class="btn sm" onClick=${() => setShowToken(!showToken)}>${showToken ? 'Hide' : 'Show'}</button>
        </div>
      </${Field}>
      <${Field} label="This device’s name" hint="Shown in commit messages">
        <input value=${form.device} onInput=${set('device')} placeholder="Work PC" />
      </${Field}>
      <label class="field checkbox">
        <input type="checkbox" checked=${form.autoSync} onChange=${set('autoSync')} />
        <span>Sync automatically<small>After edits, every 5 minutes and when the app regains focus</small></span>
      </label>
      <div class="form-actions span-2">
        <button type="submit" class="btn primary" disabled=${!changed}>Save</button>
        <button type="button" class="btn" disabled=${!clean.owner || !clean.repo || !token.trim()} onClick=${test}>Test connection</button>
        ${savedToken && html`<button type="button" class="btn ghost danger" onClick=${disconnect}>Disconnect</button>`}
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
    </details>
  </${Card}>`;
}

const CONNECTOR_GUIDE = 'https://github.com/divaor/tracking_app/blob/HEAD/mcp/README.md';

function ConnectorCard() {
  return html`<${Card} title="Claude connector" icon="claude" id="connector">
    <p>
      Let Claude work with your tracker from any chat or Claude Code session: “send this proposal to my tracker”, “send the artifact to my
      tracker”, “update tasks on my tracker”, “check my tracker for feedback”.
    </p>
    <ol class="connector-steps">
      <li>Deploy the connector once: a small free Cloudflare Worker that reads and writes your data repository.</li>
      <li>In Claude, open <strong>Customize → Connectors → Add custom connector</strong> and paste its address ending in <code>/mcp</code>.</li>
      <li>Claude opens a sign-in page: enter your connector password and press <strong>Allow</strong>.</li>
      <li>It then works in Claude on the web, desktop and phone, and in Claude Code when you are signed in with the same account.</li>
    </ol>
    <a class="btn sm" href=${CONNECTOR_GUIDE} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${15} />Step-by-step setup guide</a>
    <p class="muted small connector-note">
      Proposals and artifacts Claude sends show up under Docs with their files. Open one to read it, then approve, request changes or reject
      and leave feedback; Claude can read your decision back.
    </p>
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
      const added = store.importItems(parseDocument(await file.text()));
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
      <button type="button" class="btn" onClick=${() => download(`tracker-backup-${localDate()}.json`, serializeDocument(all))}><${Icon} name="download" size=${16} />Export backup</button>
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
        <p>Open the web version (GitHub Pages) in your phone’s browser, then install it: on iPhone tap <em>Share → Add to Home Screen</em>, on Android tap <em>⋮ → Install app</em>. It works offline and syncs when online.</p>
        ${isWeb && installPrompt && html`<button type="button" class="btn primary sm" onClick=${onInstall}><${Icon} name="install" size=${15} />Install this app</button>`}
      </div>
      <div>
        <h3>Computers</h3>
        <p>Download the desktop app from the repository’s <em>Releases</em> page (Windows installer or portable .exe, macOS .dmg, Linux AppImage), or run it from a clone with <code>npm install</code> and <code>npm start</code>.</p>
      </div>
    </div>
  </${Card}>`;
}

export function SettingsView({ sync, actions, items, installPrompt, onInstall, theme }) {
  return html`<div class="settings">
    <${SyncCard} sync=${sync} actions=${actions} />
    <${ConnectorCard} />
    <${NotificationsCard} actions=${actions} />
    <${Card} title="Appearance" icon="eye">
      <${Segmented} label="Theme" value=${theme} onChange=${(t) => saveSettings({ theme: t })}
        options=${[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} />
    </${Card}>
    <${DataCard} actions=${actions} items=${items} />
    <${AppsCard} installPrompt=${installPrompt} onInstall=${onInstall} />
    <${Card} title="Keyboard shortcuts" icon="list">
      <dl class="shortcuts">
        <div><dt><kbd>N</kbd></dt><dd>New item</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>Search</dd></div>
        <div><dt><kbd>E</kbd></dt><dd>Edit the open item</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>Enter</kbd></dt><dd>Save</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close</dd></div>
      </dl>
    </${Card}>
    <p class="about muted">Tracker ${APP_VERSION} · ${environmentLabel()}${store.meta.lastSyncAt ? ` · last synced ${formatDateTime(store.meta.lastSyncAt)}` : ''}</p>
  </div>`;
}
