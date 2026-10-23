// Model connections (providers.js): which client, which key, and every key's secret allowed by
// the page (settings.js) and the desktop app (main.cjs). A copy of Tracker Editor's test; keep the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_PROVIDERS, connectionOf, createModelClient, keySecret, LLM_KEY_SECRETS, providerOf } from '../app/js/providers.js';
import { SECRET_NAMES } from '../app/js/settings.js';

test('connections and their keys', () => {
  assert.equal(connectionOf({ provider: 'openai', service: 'local' }), 'local');
  assert.equal(connectionOf({ provider: 'openai' }), 'local', 'settings from before');
  assert.equal(connectionOf({ provider: 'openai', service: 'gemini' }), 'api');
  assert.equal(connectionOf({ provider: 'anthropic', service: 'anthropic' }), 'api');
  assert.equal(connectionOf({ provider: 'async' }), 'async');
  assert.equal(keySecret('openrouter'), 'llm-key-openrouter');
  assert.equal(keySecret(''), 'llm-key-local');
  assert.equal(providerOf('anthropic').kind, 'anthropic');
  assert.ok(API_PROVIDERS.filter((p) => p.kind === 'openai' && p.id !== 'custom').every((p) => p.baseUrl.startsWith('https://')));
});

test('every key has a secret the page and the desktop app allow', () => {
  for (const name of LLM_KEY_SECRETS) assert.ok(SECRET_NAMES.includes(name), name);
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const allowed = /const SECRET_KEYS = new Set\(\[([^\]]*)\]\)/.exec(main)[1];
  for (const name of LLM_KEY_SECRETS) assert.ok(allowed.includes(`'${name}'`), `${name} in main.cjs SECRET_KEYS`);
});

test('the client: Claude through its SDK, the rest OpenAI-style, the key read when asked', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()) });
    return new Response(JSON.stringify({ data: [{ id: 'm1', type: 'model' }], has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const secrets = { 'llm-key-gemini': 'g-key', 'llm-key-anthropic': 'a-key' };
  const getSecret = async (name) => secrets[name] ?? '';
  await createModelClient({ provider: 'openai', service: 'gemini', baseUrl: providerOf('gemini').baseUrl }, { getSecret, fetchImpl }).listModels();
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.equal(seen[0].headers.authorization, 'Bearer g-key');
  await createModelClient({ provider: 'anthropic', service: 'anthropic' }, { getSecret, fetchImpl }).listModels();
  assert.match(seen[1].url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
  assert.equal(seen[1].headers['x-api-key'], 'a-key');
  // A key typed in Settings, not saved yet, is the one tested.
  await createModelClient({ provider: 'openai', service: 'openai', baseUrl: providerOf('openai').baseUrl }, { getSecret, fetchImpl, apiKey: 'typed' }).listModels();
  assert.equal(seen[2].headers.authorization, 'Bearer typed');
  // A server on this computer without a key sends none.
  await createModelClient({ provider: 'openai', service: 'local', baseUrl: 'http://localhost:11434/v1' }, { getSecret, fetchImpl }).listModels();
  assert.equal(seen[3].headers.authorization, undefined);
});
