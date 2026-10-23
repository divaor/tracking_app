// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/providers.js); keep the two in step.
// Where the model runs (Settings → Model): on this computer (an OpenAI-compatible server such as
// Ollama or LM Studio), at an AI provider with your own API key, or at a service that answers
// later (asyncLlm.js, made by each app). Pure: the tests import it. The tracker keeps a copy.
import { CLAUDE_DEFAULT_MODEL, createClaudeClient } from './claude.js';
import { createLlmClient, DEFAULT_LLM_URL } from './llm.js';

/**
 * AI providers reached with an API key. `kind` 'anthropic' goes through Claude's SDK
 * (claude.js); the others speak the OpenAI API (llm.js) at `baseUrl`.
 */
export const API_PROVIDERS = [
  { id: 'anthropic', label: 'Claude (Anthropic)', kind: 'anthropic', keyUrl: 'https://platform.claude.com/', model: CLAUDE_DEFAULT_MODEL, embeddings: false },
  { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'openrouter', label: 'OpenRouter (many models)', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', embeddings: false },
  { id: 'mistral', label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'groq', label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', embeddings: false },
  { id: 'custom', label: 'Another one (OpenAI-compatible)', kind: 'openai', baseUrl: '' },
];

export const providerOf = (id) => API_PROVIDERS.find((p) => p.id === id) ?? null;

/** The secret (keychain on desktop, this browser's storage on the web) holding a connection's key. */
export const keySecret = (service) => `llm-key-${service || 'local'}`;
/** Every such secret: settings.js (SECRET_NAMES) and the desktop app (SECRET_KEYS) allow these. */
export const LLM_KEY_SECRETS = ['local', ...API_PROVIDERS.map((p) => p.id)].map(keySecret);

/** Which kind of connection settings.llm is: 'local', 'api' or 'async'. */
export function connectionOf(llm) {
  if (llm.provider === 'async') return 'async';
  return llm.provider === 'anthropic' || (llm.service && llm.service !== 'local') ? 'api' : 'local';
}

/**
 * The client for settings.llm (the async service excepted, which each app makes): Claude
 * through its SDK, the others through llm.js. The key is read from `getSecret` when a request
 * goes out, unless `apiKey` gives one (a key typed but not saved yet, to test it).
 */
export function createModelClient(llm, { getSecret, fetchImpl, apiKey } = {}) {
  const service = llm.provider === 'anthropic' ? 'anthropic' : llm.service || 'local';
  const key = async () => apiKey || (await getSecret?.(keySecret(service)).catch(() => '')) || '';
  if (llm.provider === 'anthropic') return createClaudeClient({ apiKey: key, fetchImpl });
  return createLlmClient({ baseUrl: llm.baseUrl || DEFAULT_LLM_URL, apiKey: key, fetchImpl });
}
