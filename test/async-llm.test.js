import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncLlmClient, fillTemplate, formatSources, getPath, parseProfile, PROFILE_EXAMPLE, promptFromMessages } from '../app/js/asyncLlm.js';
import { createLlmClient } from '../app/js/llm.js';

test('templates keep types, drop empty keys and fill strings', () => {
  const values = { task_id: 42, rev: '', prompt: 'Hi "there"', date: '2026-10-22', model: 'docs kb' };
  assert.deepEqual(fillTemplate({ params: { task_id: '{{task_id}}', since_rev: '{{rev}}', wait: 25, mission: 'editor-{{date}}', list: ['{{model}}', '{{nothing}}'] } }, values), {
    params: { task_id: 42, wait: 25, mission: 'editor-2026-10-22', list: ['docs kb'] },
  });
  assert.equal(fillTemplate('https://x.test/tasks/{{model}}', values, encodeURIComponent), 'https://x.test/tasks/docs%20kb');
  assert.equal(getPath({ data: [{ id: 7 }] }, 'data.0.id'), 7);
  assert.equal(getPath({ data: [{ id: 7 }] }, 'data[0].id'), 7);
  assert.equal(getPath({ a: null }, 'a.b'), undefined);
});

test('profiles are checked', () => {
  assert.match(parseProfile('{').error, /not valid JSON/);
  assert.match(parseProfile('{"submit": {"url": "https://x.test"}}').error, /submit\.taskId.*status\.url/);
  assert.match(parseProfile({ ...PROFILE_EXAMPLE, submit: { ...PROFILE_EXAMPLE.submit, url: 'ftp://x' } }).error, /http/);
  const { profile } = parseProfile(JSON.stringify(PROFILE_EXAMPLE));
  assert.deepEqual(profile.status.done, ['done', 'completed']);
  assert.equal(profile.timeout, 300);
});

test('chat messages become one prompt', () => {
  assert.equal(promptFromMessages([{ role: 'user', content: 'hi' }]), 'hi');
  assert.equal(promptFromMessages([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }]), 'Instructions:\nBe brief.\n\nUser:\nhi');
  assert.equal(formatSources([{ indices: [1], title: 'a.md', download_url: 'https://x.test/a' }, { title: 'b.md' }]), '\n\nSources:\n- [1] [a.md](https://x.test/a)\n- [2] b.md');
});

// A service like the one the profile below describes: submit, then a status call
// the server holds open until the task changes (rev / since_rev).
const PROFILE = parseProfile({
  submit: {
    url: 'https://gateway.test/api/submit',
    body: { params: { request_type: 'question', payload: { task: { kb: '{{model}}', query: '{{prompt}}' } }, labels: { app: '{{app}}', feature: '{{purpose}}', batch: 'editor-{{date}}' }, webhook_url: '{{webhook_url}}' } },
    taskId: 'data.0.id',
  },
  status: {
    url: 'https://gateway.test/api/status',
    body: { params: { task_id: '{{task_id}}', wait_seconds: 25, since_rev: '{{rev}}' } },
    state: 'data.0.status',
    rev: 'data.0.rev',
    done: ['done'],
    failed: ['dead'],
    answer: 'data.0.response.result.answer',
    error: 'data.0.response.error.message',
    sources: 'data.0.response.result.sources',
  },
  webhook: { taskId: 'task_id', state: 'event', answer: 'result.answer', error: 'error.message' },
  auth: { header: 'X-API-Key', prefix: '' },
  ok: 'success',
  errorMessage: 'error.message',
}).profile;

function fakeService(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const [status, data, headers = {}] = script(url, body, calls.length);
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { calls, fetchImpl };
}

test('submit, then wait on the status call until the answer is there', async () => {
  const states = [];
  const { calls, fetchImpl } = fakeService((url, body) => {
    if (url.endsWith('/submit')) return [200, { success: true, data: [{ id: 23844 }] }];
    const rev = body.params.since_rev;
    if (!rev) return [200, { success: true, data: [{ status: 'queued', rev: 'r1' }] }];
    if (rev === 'r1') return [200, { success: true, data: [{ status: 'running', rev: 'r2' }] }];
    return [200, { success: true, data: [{ status: 'done', rev: 'r3', response: { ok: true, result: { answer: 'It is a platform [1].', sources: [{ indices: [1], title: 'overview.md' }] } } }] }];
  });
  const client = createAsyncLlmClient({ profile: PROFILE, apiKey: 'k-123', fetchImpl, now: () => Date.parse('2026-10-22T10:00:00Z') });
  let streamed = '';
  const answer = await client.chat({ model: 'docs-kb', messages: [{ role: 'user', content: 'What is it?' }], purpose: 'ask', onToken: (t) => (streamed += t), onState: (s) => states.push(s) });
  assert.equal(answer, 'It is a platform [1].\n\nSources:\n- [1] overview.md');
  assert.equal(streamed, answer);
  assert.deepEqual(states, ['queued', 'queued', 'running', 'done']);
  assert.equal(calls[0].init.headers['X-API-Key'], 'k-123');
  assert.deepEqual(calls[0].body, { params: { request_type: 'question', payload: { task: { kb: 'docs-kb', query: 'What is it?' } }, labels: { app: 'tracker-editor', feature: 'ask', batch: 'editor-2026-10-22' } } });
  assert.deepEqual(calls[1].body, { params: { task_id: 23844, wait_seconds: 25 } });
  assert.deepEqual(calls[2].body, { params: { task_id: 23844, wait_seconds: 25, since_rev: 'r1' } });
  assert.equal(calls.length, 4);
});

test('failures come back as messages', async () => {
  const dead = fakeService((url) => (url.endsWith('/submit') ? [200, { success: true, data: [{ id: 1 }] }] : [200, { success: true, data: [{ status: 'dead', response: { ok: false, error: { code: 'KB_DOWN', message: 'The knowledge base is offline' } } }] }]));
  await assert.rejects(createAsyncLlmClient({ profile: PROFILE, fetchImpl: dead.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }] }), /could not answer: The knowledge base is offline/);
  const forbidden = fakeService(() => [403, { detail: { code: 'KB_FORBIDDEN', message: 'No access to that knowledge base' } }]);
  await assert.rejects(createAsyncLlmClient({ profile: PROFILE, fetchImpl: forbidden.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }] }), /answered 403: No access/);
  const refused = fakeService(() => [200, { success: false, error: { code: 'NOT_FOUND', message: 'Unknown task' } }]);
  await assert.rejects(createAsyncLlmClient({ profile: PROFILE, fetchImpl: refused.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }] }), /refused the request: Unknown task/);
  const noId = fakeService(() => [200, { success: true, data: [] }]);
  await assert.rejects(createAsyncLlmClient({ profile: PROFILE, fetchImpl: noId.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }] }), /no task id/);
});

test('waits out a rate limit, and gives up after the timeout', async () => {
  const slept = [];
  const sleep = async (ms) => slept.push(ms);
  const limited = fakeService((url, body, n) => (n === 1 ? [429, { detail: 'RATE_LIMITED' }, { 'retry-after': '7' }] : url.endsWith('/submit') ? [200, { success: true, data: [{ id: 2 }] }] : [200, { success: true, data: [{ status: 'done', response: { result: { answer: 'ok' } } }] }]));
  assert.equal(await createAsyncLlmClient({ profile: PROFILE, fetchImpl: limited.fetchImpl, sleep }).chat({ messages: [{ role: 'user', content: 'x' }] }), 'ok');
  assert.deepEqual(slept, [7000]);

  let clock = 0;
  const forever = fakeService((url) => (url.endsWith('/submit') ? [200, { success: true, data: [{ id: 3 }] }] : [200, { success: true, data: [{ status: 'running' }] }]));
  const stuck = createAsyncLlmClient({ profile: { ...PROFILE, timeout: 10, status: { ...PROFILE.status, rev: '' } }, fetchImpl: forever.fetchImpl, now: () => clock, sleep: async (ms) => (clock += ms) });
  await assert.rejects(stuck.chat({ messages: [{ role: 'user', content: 'x' }] }), /No answer from the model service after 10 seconds/);
});

test('a webhook event can bring the answer before the next status call', async () => {
  const profile = { ...PROFILE, status: { ...PROFILE.status, rev: '' } };
  const service = fakeService((url) => (url.endsWith('/submit') ? [200, { success: true, data: [{ id: 99 }] }] : [200, { success: true, data: [{ status: 'running' }] }]));
  const waited = [];
  const events = [{ event: 'running', task_id: 99 }, { event: 'done', task_id: 99, result: { answer: 'From the webhook' } }];
  const webhook = { url: 'http://my-pc.test:8765/hook', wait: async (id) => (waited.push(id), events.shift()) };
  const never = (_ms, signal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('stopped'))));
  const answer = await createAsyncLlmClient({ profile, fetchImpl: service.fetchImpl, webhook, sleep: never }).chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(answer, 'From the webhook');
  assert.equal(service.calls[0].body.params.webhook_url, 'http://my-pc.test:8765/hook');
  assert.deepEqual(waited, [99, 99]);
});

test('stopping ends the wait', async () => {
  const service = fakeService((url) => (url.endsWith('/submit') ? [200, { success: true, data: [{ id: 5 }] }] : [200, { success: true, data: [{ status: 'running' }] }]));
  const controller = new AbortController();
  const profile = { ...PROFILE, status: { ...PROFILE.status, rev: '', interval: 0.01 } };
  const pending = createAsyncLlmClient({ profile, fetchImpl: service.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /Stopped|abort/i);
});

test('the model server completes text, with what follows the cursor', async () => {
  const service = fakeService(() => [200, { choices: [{ text: 'b) {\n  return a + b;' }] }]);
  const client = createLlmClient({ baseUrl: 'http://localhost:11434/v1/', fetchImpl: service.fetchImpl });
  const text = await client.complete({ model: 'coder', prompt: 'function add(a, ', suffix: '\n}', maxTokens: 64, stop: ['\n\n'] });
  assert.equal(text, 'b) {\n  return a + b;');
  assert.equal(service.calls[0].url, 'http://localhost:11434/v1/completions');
  assert.deepEqual(service.calls[0].body, { model: 'coder', prompt: 'function add(a, ', suffix: '\n}', max_tokens: 64, temperature: 0.2, stream: false, stop: ['\n\n'] });
  // A server without the endpoint says so with its status.
  const missing = fakeService(() => [404, { error: { message: 'not found' } }]);
  await assert.rejects(createLlmClient({ baseUrl: 'http://x.test/v1', fetchImpl: missing.fetchImpl }).complete({ model: 'm', prompt: 'x' }), (err) => err.status === 404);
});
