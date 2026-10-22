// User preferences (synchronous, localStorage) and the GitHub token (kept in
// the OS keychain via Electron's safeStorage on desktop, localStorage on web).
import { DEFAULT_LLM_URL } from './llm.js';

const KEY = 'tracker.settings.v1';
const TOKEN_KEY = 'tracker.token';

function defaultDevice() {
  const desktop = globalThis.window?.desktop;
  if (desktop) return `Desktop (${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[desktop.platform] ?? desktop.platform})`;
  const ua = globalThis.navigator?.userAgent ?? '';
  if (/iPhone|Android.*Mobile/.test(ua)) return 'Phone';
  if (/iPad|Android/.test(ua)) return 'Tablet';
  return 'Browser';
}

export const DEFAULT_SETTINGS = {
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
    apiKey: '',
    profile: '',
    webhook: { enabled: false, port: 8766, path: '/llm-webhook', publicUrl: '' },
  },
  // With the model on: quick add understands plain language ("call Ana tomorrow, urgent").
  smartAdd: true,
  // Dictation into quick add (phones): a BCP 47 language, '' = the device's.
  dictationLang: '',
};

let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  settings = { ...DEFAULT_SETTINGS, ...saved, llm: { ...DEFAULT_SETTINGS.llm, ...saved.llm, webhook: { ...DEFAULT_SETTINGS.llm.webhook, ...saved.llm?.webhook } } };
} catch {
  // keep defaults
}

const listeners = new Set();

export const getSettings = () => settings;

export function saveSettings(patch) {
  settings = { ...settings, ...patch, llm: { ...settings.llm, ...patch.llm, webhook: { ...settings.llm.webhook, ...patch.llm?.webhook } } };
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

// Other secrets (the model service's API key and webhook secret), kept like the token.
export const SECRET_NAMES = ['llm-api-key', 'llm-webhook-secret'];
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
