// User preferences (synchronous, localStorage) and the GitHub token (kept in
// the OS keychain via Electron's safeStorage on desktop, localStorage on web).
import { DEFAULT_LLM_URL } from './llm.js';
import { keySecret, LLM_KEY_SECRETS } from './providers.js';

const KEY = 'tracker.settings.v1';
const TOKEN_KEY = 'tracker.token';

function defaultDevice() {
  const desktop = globalThis.window?.desktop;
  if (desktop?.platform === 'android') return 'Phone';
  if (desktop) return `Desktop (${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[desktop.platform] ?? desktop.platform})`;
  const ua = globalThis.navigator?.userAgent ?? '';
  if (/iPhone|Android.*Mobile/.test(ua)) return 'Phone';
  if (/iPad|Android/.test(ua)) return 'Tablet';
  return 'Browser';
}

export const DEFAULT_SETTINGS = {
  // Where the data is kept: 'local' (this computer: a data folder Tracker Editor shares on desktop,
  // the browser's storage on the web; no GitHub) or 'github' (the data repo, synced across devices).
  storage: 'local',
  owner: '',
  repo: '',
  branch: '',
  path: 'tracker.json',
  device: defaultDevice(),
  autoSync: true,
  theme: 'system',
  sort: 'smart',
  // Project filter for the main views (see matchesScope in model.js).
  projectScope: [],
  // What an open item shows under its title, which always shows (see ITEM_HEAD in ui/itemModal.js).
  itemHead: { status: true, priority: true, project: true, tags: true, id: false },
  // Pinned items show whatever type, status or #tag is picked (their project still has to be shown).
  pinnedPastFilters: false,
  // The sidebar lists every project and tag (else the first ones, with "N more").
  sidebarAll: { projects: false, tags: false },
  // Today's plan made and updated by itself (ui/plans.js usePlanAuto), and where its strip is hidden.
  planAuto: false,
  planStripHidden: { list: false, board: false },
  // Release boards: one with no word for longer than this says so (0: never); reminders of what waits
  // on you with a time (Sun 16:00 UTC), shortly before.
  boardQuietHours: 48,
  boardReminders: true,
  // In a browser on a computer: links to items not on this device go to the desktop app (tracker-app://).
  openItemsInApp: false,
  // Claude connector address, used for push notifications.
  connectorUrl: '',
  // Tracker Editor's web address; blank = the default (editorLinks.js).
  editorUrl: '',
  // Push notifications turned on for this device (web/PWA only).
  push: false,
  // Which changes to be told about (see notifier.js).
  notify: { desktop: true, documents: true, items: true, devices: false },
  // The model (as in Tracker Editor): a server with an OpenAI-compatible API
  // (Ollama, LM Studio, …), or provider 'async': a service that answers later,
  // described by `profile` (JSON; asyncLlm.js). Its API key and webhook secret
  // are kept with getSecret. `webhook` (desktop app): receive its answers on this port.
  llm: {
    enabled: false,
    provider: 'openai',
    baseUrl: DEFAULT_LLM_URL,
    chatModel: '',
    // Which connection (providers.js): 'local' (a server on this computer) or an AI provider's id.
    service: 'local',
    apiKey: '',
    profile: '',
    webhook: { enabled: false, port: 8766, path: '/llm-webhook', publicUrl: '' },
  },
  // With the model on: quick add understands plain language ("call Ana tomorrow, urgent").
  smartAdd: true,
  // Dictation into quick add (phones): a BCP 47 language, '' = the device's.
  dictationLang: '',
  // Listening (as in Tracker Editor, reader.js): the device's voices (a voice URI, '' = the best one
  // for the text's language) or a speech server with an OpenAI-compatible API, and the speed.
  tts: {
    engine: 'device',
    voice: '',
    // An Android app's text-to-speech engine (a package), '' = the phone's preferred one.
    androidEngine: '',
    rate: 1,
    // otherVoices: voices for other languages, as "es=ef_dora, pt=pf_dora" (Kokoro voices speak one language each).
    // The server's API key is a secret (TTS_KEY_SECRET), sent only to the origin it was saved for (`keyOrigin`).
    server: { baseUrl: 'http://localhost:8880/v1', apiKey: '', keyOrigin: '', model: 'kokoro', voice: 'af_heart', otherVoices: 'es=ef_dora, pt=pf_dora', instructions: '' },
  },
};

let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    llm: { ...DEFAULT_SETTINGS.llm, ...saved.llm, webhook: { ...DEFAULT_SETTINGS.llm.webhook, ...saved.llm?.webhook } },
    tts: { ...DEFAULT_SETTINGS.tts, ...saved.tts, server: { ...DEFAULT_SETTINGS.tts.server, ...saved.tts?.server } },
  };
  // Installs from before local mode that sync with GitHub stay on it.
  if (!saved.storage) settings = { ...settings, storage: saved.owner && saved.repo ? 'github' : 'local' };
} catch {
  // keep defaults
}

const listeners = new Set();

export const getSettings = () => settings;

export function saveSettings(patch) {
  settings = {
    ...settings,
    ...patch,
    llm: { ...settings.llm, ...patch.llm, webhook: { ...settings.llm.webhook, ...patch.llm?.webhook } },
    tts: { ...settings.tts, ...patch.tts, server: { ...settings.tts.server, ...patch.tts?.server } },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage full or blocked: settings stay in memory for this session
  }
  for (const fn of listeners) fn(settings);
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const isSyncConfigured = (s = settings) => Boolean(s.owner && s.repo && s.path);
/** The data stays on this device (no GitHub, nothing about syncing shown). */
export const isLocal = (s = settings) => s.storage !== 'github';

export function applyTheme(theme = settings.theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

let tokenCache;

export async function getToken() {
  if (tokenCache !== undefined) return tokenCache;
  const secrets = globalThis.window?.desktop?.secrets;
  try {
    tokenCache = secrets ? ((await secrets.get('github-token')) ?? '') : (localStorage.getItem(TOKEN_KEY) ?? '');
  } catch {
    tokenCache = '';
  }
  return tokenCache;
}

export async function setToken(value) {
  const token = value.trim();
  const secrets = globalThis.window?.desktop?.secrets;
  if (secrets) await secrets.set('github-token', token);
  else if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  tokenCache = token;
}

// Other secrets (the model service's API key and webhook secret, the API key of each model
// connection: providers.js, the speech server's key), kept like the token.
export const TTS_KEY_SECRET = 'tts-server-key';
export const SECRET_NAMES = ['llm-api-key', 'llm-webhook-secret', ...LLM_KEY_SECRETS, TTS_KEY_SECRET];

/** The origin of a server address ('' when it is not one). */
export function originOf(url) {
  try {
    return new URL(String(url ?? '').trim()).origin;
  } catch {
    return '';
  }
}
const secretCache = new Map();

export async function getSecret(name) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${name}`);
  if (secretCache.has(name)) return secretCache.get(name);
  const secrets = globalThis.window?.desktop?.secrets;
  let value = '';
  try {
    value = secrets ? ((await secrets.get(name)) ?? '') : (localStorage.getItem(`${TOKEN_KEY}:${name}`) ?? '');
  } catch {
    value = '';
  }
  secretCache.set(name, value);
  return value;
}

export async function setSecret(name, value) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${name}`);
  const v = String(value ?? '').trim();
  const secrets = globalThis.window?.desktop?.secrets;
  if (secrets) await secrets.set(name, v);
  else if (v) localStorage.setItem(`${TOKEN_KEY}:${name}`, v);
  else localStorage.removeItem(`${TOKEN_KEY}:${name}`);
  secretCache.set(name, v);
}

// Before, a local model server's API key was kept in the settings; it moves to the secrets
// (the keychain on desktop), and the settings forget it.
if (settings.llm.apiKey) {
  const key = settings.llm.apiKey;
  setSecret(keySecret('local'), key).then(
    () => saveSettings({ llm: { apiKey: '' } }),
    () => {},
  );
}
