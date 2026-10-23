// Claude through Anthropic's SDK (claude.js), against a fake API: streamed answers, the refusal
// fallback, declines, the model list, errors, and messages turned into Claude's shape.
// A copy of Tracker Editor's test, with this copy of claude.js; keep the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeMessages, createClaudeClient } from '../app/js/claude.js';

const sse = (events) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const start = (model = 'claude-opus-5-5') => ({
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 1 } },
});
const textBlock = (index, ...pieces) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...pieces.map((text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
  { type: 'content_block_stop', index },
];
const end = (stop_reason = 'end_turn', extra = {}) => [
  { type: 'message_delta', delta: { stop_reason, stop_sequence: null, ...extra }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];

/** A fetch that answers like the Claude API; `reply(url, body, headers)` → [status, body, contentType]. */
function fakeApi(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method, headers, body });
    const [status, data, type = 'application/json'] = reply(String(url), body, headers);
    return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': type, 'request-id': 'req_1' } });
  };
  return { calls, fetchImpl };
}

test('messages in Claude’s shape: the system apart, images as image blocks', () => {
  const { system, messages } = claudeMessages([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: [{ type: 'text', text: 'What does it say?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } }] },
    { role: 'assistant', content: 'It says hi.' },
    { role: 'user', content: 'Thanks' },
  ]);
  assert.equal(system, 'Be brief.');
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'What does it say?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }]);
  assert.deepEqual(messages.slice(1), [{ role: 'assistant', content: 'It says hi.' }, { role: 'user', content: 'Thanks' }]);
  // A conversation never starts with Claude.
  assert.equal(claudeMessages([{ role: 'assistant', content: 'x' }]).messages[0].role, 'user');
});

test('a streamed answer, with the key, effort and refusal fallback the request needs', async () => {
  const api = fakeApi(() => [200, sse([start(), ...textBlock(0, 'Hel', 'lo!'), ...end()]), 'text/event-stream']);
  const claude = createClaudeClient({ apiKey: async () => 'sk-ant-test', fetchImpl: api.fetchImpl });
  const pieces = [];
  const text = await claude.chat({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello' }], onToken: (t) => pieces.push(t) });
  assert.equal(text, 'Hello!');
  assert.deepEqual(pieces, ['Hel', 'lo!']);
  const [call] = api.calls;
  assert.match(call.url, /\/v1\/messages(\?|$)/);
  assert.equal(call.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(call.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.fallbacks, 'default');
  assert.equal(call.body.system, 'Be brief.');
  assert.deepEqual(call.body.output_config, { effort: 'medium' });
  assert.equal(call.body.stream, true);
  assert.equal('temperature' in call.body, false, 'no sampling parameters');
  assert.equal('betas' in call.body, false, 'betas go in the header');
});

test('short jobs think less; models without the fallback are asked plainly', async () => {
  const api = fakeApi(() => [200, sse([start('claude-haiku-5-5'), ...textBlock(0, 'Notes.md'), ...end()]), 'text/event-stream']);
  const claude = createClaudeClient({ apiKey: 'sk-ant-test', fetchImpl: api.fetchImpl });
  assert.equal(await claude.chat({ model: 'claude-haiku-5-5', purpose: 'name', messages: [{ role: 'user', content: 'Name it' }] }), 'Notes.md');
  const [call] = api.calls;
  assert.deepEqual(call.body.output_config, { effort: 'low' });
  assert.equal(call.body.max_tokens, 4096);
  assert.equal('fallbacks' in call.body, false);
  assert.equal(call.headers['anthropic-beta'], undefined);
});

test('a decline part way through, rescued by the fallback model, starts the answer over', async () => {
  const api = fakeApi(() => [
    200,
    sse([
      start(),
      ...textBlock(0, 'Partial '),
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } },
      { type: 'content_block_stop', index: 1 },
      ...textBlock(2, 'Rescued answer'),
      ...end(),
    ]),
    'text/event-stream',
  ]);
  const claude = createClaudeClient({ apiKey: 'k', fetchImpl: api.fetchImpl });
  let restarted = 0;
  const text = await claude.chat({ messages: [{ role: 'user', content: 'x' }], onRestart: () => restarted++ });
  assert.equal(text, 'Rescued answer');
  assert.equal(restarted, 1);
});

test('a decline is said plainly; errors read well; no key, no request', async () => {
  const refused = fakeApi(() => [200, sse([start(), ...end('refusal')]), 'text/event-stream']);
  await assert.rejects(createClaudeClient({ apiKey: 'k', fetchImpl: refused.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }] }), /Claude declined this request/);
  const badKey = fakeApi(() => [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }]);
  await assert.rejects(createClaudeClient({ apiKey: 'nope', fetchImpl: badKey.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }] }), (err) => err.status === 401 && /did not accept the API key/.test(err.message));
  const noModel = fakeApi(() => [404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } }]);
  await assert.rejects(createClaudeClient({ apiKey: 'k', fetchImpl: noModel.fetchImpl }).chat({ model: 'claude-x', messages: [{ role: 'user', content: 'x' }] }), /no model by that name/);
  const none = fakeApi(() => [200, {}]);
  await assert.rejects(createClaudeClient({ apiKey: async () => '', fetchImpl: none.fetchImpl }).listModels(), /Add your Claude API key/);
  assert.equal(none.calls.length, 0);
  // What Claude does not have: the callers fall back (suggestions use the chat).
  await assert.rejects(createClaudeClient({ apiKey: 'k' }).complete(), (err) => err.status === 501);
  await assert.rejects(createClaudeClient({ apiKey: 'k' }).embed(), /no embeddings/);
});

test('stopping a request', async () => {
  const api = fakeApi(() => [200, sse([start(), ...textBlock(0, 'x'), ...end()]), 'text/event-stream']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createClaudeClient({ apiKey: 'k', fetchImpl: api.fetchImpl }).chat({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal }), (err) => err.name === 'AbortError');
});

test('the models this key can use, page after page', async () => {
  const api = fakeApi((url) =>
    url.includes('after_id=claude-opus-5')
      ? [200, { data: [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5' }]
      : [200, { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z' }, { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-05-01T00:00:00Z' }], has_more: true, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5' }],
  );
  const ids = await createClaudeClient({ apiKey: 'k', fetchImpl: api.fetchImpl }).listModels();
  assert.deepEqual(ids, ['claude-opus-5-5', 'claude-opus-5', 'claude-haiku-5-5']);
});
