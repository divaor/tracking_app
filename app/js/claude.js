// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/claude.js); keep the two in step.
// Claude, through Anthropic's official SDK (bundled in vendor/anthropic.js and loaded the first
// time it is used), with the same face as llm.js's client: listModels, chat (streamed: onToken
// gets each piece, the full text is returned), complete and embed (which Claude does not offer:
// they fail with a status, so callers fall back). The API key comes from the device (keychain
// on desktop), never from the settings; the SDK sends it straight to Anthropic, from the
// browser too (`dangerouslyAllowBrowser`: it is the person's own key, on their own device).
import { LlmError } from './llm.js';

export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
// Models that take the server-side refusal fallback in its "default" form: a request declined
// by a safety classifier is re-run on the model Anthropic recommends for that category.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Models that take output_config.effort.
const EFFORT_MODELS = /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;
// Short jobs (names, filing, suggestions as you type, quick add, a test) think less and answer sooner.
const QUICK = new Set(['name', 'file', 'complete', 'quick-add', 'test']);

let sdk = null;
const loadSdk = () => (sdk ??= import('../vendor/anthropic.js').then((m) => m.Anthropic));

/** OpenAI-style messages (llm.js's) as Claude's: the system text apart, images as image blocks. */
export function claudeMessages(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system.push(typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('\n'));
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : m.content.map(claudeBlock).filter(Boolean);
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  // The conversation starts with the person.
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(continue)' });
  return { system: system.join('\n\n'), messages: out };
}

function claudeBlock(part) {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image_url') {
    const url = part.image_url?.url ?? '';
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
    if (/^https:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

/** A readable message for what the API answered (the SDK's typed errors, most specific first). */
function friendly(err, Anthropic) {
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') {
    const stop = new Error('Stopped');
    stop.name = 'AbortError';
    return stop;
  }
  if (err instanceof Anthropic.AuthenticationError) return new LlmError('Claude did not accept the API key. Check it in Settings → Model.', err.status);
  if (err instanceof Anthropic.PermissionDeniedError) return new LlmError(`This API key may not use that: ${err.message}`, err.status);
  if (err instanceof Anthropic.NotFoundError) return new LlmError(`Claude has no model by that name. Press “Test and list models” and pick one. (${err.message})`, err.status);
  if (err instanceof Anthropic.RateLimitError) return new LlmError('Too many requests for this API key right now (or its spending limit is reached). Try again in a minute.', err.status);
  if (err instanceof Anthropic.BadRequestError) return new LlmError(`Claude could not take this request: ${err.message}`, err.status);
  if (err instanceof Anthropic.InternalServerError) return new LlmError('Claude is having trouble right now. Try again in a moment.', err.status);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('Could not reach Claude (api.anthropic.com). Check the connection.');
  if (err instanceof Anthropic.APIError) return new LlmError(`Claude answered ${err.status ?? ''}: ${err.message}`.trim(), err.status ?? 0);
  return err;
}

/**
 * A client for the Claude API. `apiKey` is the key or an async function that returns it;
 * `fetchImpl` is the fetch to use (the desktop app's goes through its main process).
 */
export function createClaudeClient({ apiKey, fetchImpl = globalThis.fetch?.bind(globalThis), baseURL } = {}) {
  let client = null;
  let clientKey = '';
  // The key is read for each request, so a new one saved in Settings is used at once.
  const getClient = async () => {
    const Anthropic = await loadSdk();
    const key = (typeof apiKey === 'function' ? await apiKey() : apiKey) || '';
    if (!key) throw new LlmError('Add your Claude API key in Settings → Model.', 401);
    if (!client || key !== clientKey) {
      client = new Anthropic({ apiKey: key, fetch: fetchImpl, dangerouslyAllowBrowser: true, maxRetries: 2, ...(baseURL ? { baseURL } : {}) });
      clientKey = key;
    }
    return { client, Anthropic };
  };

  return {
    provider: 'anthropic',

    /** The models this key can use, newest first. */
    async listModels() {
      const { client, Anthropic } = await getClient();
      try {
        const ids = [];
        for await (const model of client.models.list()) ids.push(model.id);
        return ids;
      } catch (err) {
        throw friendly(err, Anthropic);
      }
    },

    /** Streams an answer: `onToken` gets each piece; resolves to the full text. */
    async chat({ model = CLAUDE_DEFAULT_MODEL, messages, onToken = () => {}, onRestart = () => {}, signal, purpose = '' }) {
      const { client, Anthropic } = await getClient();
      const { system, messages: turns } = claudeMessages(messages);
      const quick = QUICK.has(purpose);
      const params = {
        model,
        // Thinking counts toward max_tokens, so even short jobs keep room.
        max_tokens: quick ? 4096 : 64000,
        messages: turns,
        ...(system ? { system } : {}),
        ...(EFFORT_MODELS.test(model) ? { output_config: { effort: quick ? 'low' : 'medium' } } : {}),
      };
      const fallback = FALLBACK_MODELS.has(model);
      let full = '';
      try {
        const stream = fallback
          ? client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
          : client.messages.stream(params, { signal });
        for await (const event of stream) {
          // A decline part way through, rescued by the fallback model: its answer starts over.
          if (event.type === 'content_block_start' && event.content_block?.type === 'fallback') {
            full = '';
            onRestart();
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            full += event.delta.text;
            onToken(event.delta.text);
          }
        }
        const message = await stream.finalMessage();
        if (message.stop_reason === 'refusal') {
          const why = message.stop_details?.explanation || message.stop_details?.category;
          throw new LlmError(`Claude declined this request${why ? ` (${why})` : ''}. Rephrase it, or pick another model.`);
        }
        return full;
      } catch (err) {
        throw err instanceof LlmError ? err : friendly(err, Anthropic);
      }
    },

    /** Claude does not fill in the middle: callers ask the chat instead. */
    async complete() {
      throw new LlmError('Claude has no /completions: it is asked like a chat.', 501);
    },

    /** No embeddings from Claude: finding by meaning needs an embedding model elsewhere. */
    async embed() {
      throw new LlmError('Claude has no embeddings. Finding by meaning needs an embedding model (on this computer, or another provider).', 501);
    },
  };
}
