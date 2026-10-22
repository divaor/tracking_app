// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/asyncLlm.js); keep the two in step.
// A model behind an asynchronous HTTP API: one request submits the prompt and
// gets a task id back; the answer comes later, from a status endpoint (polled,
// or held open by the server until something changes) or from a webhook.
// Everything specific to a service lives in a connection profile, JSON the
// user pastes in Settings: addresses, request bodies with {{placeholders}}, and
// where the id, the state and the answer are in the responses.
// Pure (fetch is passed in), so the Node tests can import it.
import { LlmError } from './llm.js';

/** A starting point for the profile, for a made-up service. */
export const PROFILE_EXAMPLE = {
  submit: {
    url: 'https://ai.example.com/api/tasks',
    method: 'POST',
    body: { prompt: '{{prompt}}', model: '{{model}}', callback_url: '{{webhook_url}}', client: { app: '{{app}}', purpose: '{{purpose}}', day: '{{date}}' } },
    taskId: 'id',
  },
  status: {
    url: 'https://ai.example.com/api/tasks/{{task_id}}',
    method: 'GET',
    state: 'status',
    done: ['done', 'completed'],
    failed: ['failed', 'error'],
    answer: 'result.answer',
    error: 'error.message',
    interval: 2,
  },
  auth: { header: 'Authorization', prefix: 'Bearer ' },
  timeout: 300,
};

export const PLACEHOLDERS = ['prompt', 'model', 'task_id', 'rev', 'webhook_url', 'date', 'purpose', 'app'];

/** A value in an object by path: "data.0.id", "data[0].id"; '' gives the object itself. */
export function getPath(value, path) {
  if (!path) return value;
  let out = value;
  for (const part of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (out == null) return undefined;
    out = out[part];
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const ONLY = /^\{\{\s*(\w+)\s*\}\}$/;
const missing = (v) => v === undefined || v === null || v === '';

/**
 * Fills a template: a string that is just "{{name}}" becomes the value with
 * its type (a number stays a number) and its key is left out when the value is
 * empty (e.g. "since_rev" on the first call); placeholders inside longer
 * strings are replaced as text (`encode` applies to them, for URLs).
 */
export function fillTemplate(template, values, encode = (s) => s) {
  if (typeof template === 'string') {
    const only = ONLY.exec(template);
    if (only) return values[only[1]];
    return template.replace(PLACEHOLDER, (_, name) => (missing(values[name]) ? '' : encode(String(values[name]))));
  }
  if (Array.isArray(template)) return template.map((t) => fillTemplate(t, values, encode)).filter((v) => v !== undefined);
  if (template && typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      const filled = fillTemplate(v, values, encode);
      if (!missing(filled)) out[k] = filled;
    }
    return out;
  }
  return template;
}

/** The profile's JSON checked: { profile } or { error } saying what to fix. */
export function parseProfile(text) {
  let p;
  try {
    p = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    return { error: `The profile is not valid JSON: ${err.message}` };
  }
  if (!p || typeof p !== 'object') return { error: 'The profile must be a JSON object.' };
  const need = [
    [p.submit?.url, 'submit.url'],
    [p.submit?.taskId, 'submit.taskId (where the task id is in the submit response)'],
    [p.status?.url, 'status.url'],
    [p.status?.state, 'status.state (where the task state is)'],
    [p.status?.answer, 'status.answer (where the answer is)'],
  ];
  const absent = need.filter(([v]) => !v).map(([, name]) => name);
  if (absent.length) return { error: `The profile needs ${absent.join(', ')}.` };
  for (const url of [p.submit.url, p.status.url]) {
    if (!/^https?:\/\//i.test(url)) return { error: `Addresses must start with http:// or https:// (${url}).` };
  }
  const list = (v, fallback) => (Array.isArray(v) ? v : v ? [v] : fallback).map((s) => String(s).toLowerCase());
  return {
    profile: {
      ...p,
      submit: { method: 'POST', ...p.submit },
      status: { method: 'POST', interval: 2, ...p.status, done: list(p.status.done, ['done']), failed: list(p.status.failed, ['failed', 'error', 'dead']) },
      auth: { header: 'Authorization', prefix: 'Bearer ', ...p.auth },
      timeout: Number(p.timeout) > 0 ? Number(p.timeout) : 300,
    },
  };
}

/** One prompt from chat messages: the service answers one question at a time, with no memory. */
export function promptFromMessages(messages) {
  if (messages.length === 1) return messages[0].content;
  const label = { system: 'Instructions', user: 'User', assistant: 'Assistant' };
  return messages.map((m) => `${label[m.role] ?? m.role}:\n${m.content}`).join('\n\n');
}

/** "Sources:" lines for an answer with numbered references ([1], [2]). */
export function formatSources(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  const lines = sources.map((s, i) => {
    const n = Array.isArray(s?.indices) ? s.indices.join(', ') : (s?.index ?? i + 1);
    const title = s?.title ?? s?.name ?? s?.source ?? `Source ${i + 1}`;
    const url = s?.url ?? s?.download_url ?? s?.link;
    return `- [${n}] ${url ? `[${title}](${url})` : title}`;
  });
  return `\n\nSources:\n${lines.join('\n')}`;
}

const today = (now) => new Date(now()).toISOString().slice(0, 10);

/**
 * A client with the same shape as createLlmClient's: chat({ messages, onToken,
 * signal, purpose, onState }) resolves to the answer (onToken gets it once).
 * `webhook` (optional) is { url, wait(taskId, signal) → Promise<event body> }:
 * the url goes into {{webhook_url}}, and an event can end the wait early;
 * polling goes on meanwhile, more slowly, since deliveries can be lost.
 */
export function createAsyncLlmClient({ profile, apiKey = '', fetchImpl = globalThis.fetch?.bind(globalThis), webhook = null, now = Date.now, sleep = (ms, signal) => abortableSleep(ms, signal) }) {
  const p = profile;

  async function call(spec, values, signal, attempt = 1) {
    const method = String(spec.method || 'POST').toUpperCase();
    const url = fillTemplate(spec.url, values, encodeURIComponent);
    const headers = { Accept: 'application/json', ...(p.headers ?? {}) };
    if (apiKey && p.auth?.header) headers[p.auth.header] = `${p.auth.prefix ?? ''}${apiKey}`;
    let body;
    if (method !== 'GET' && spec.body !== undefined && spec.body !== null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(fillTemplate(spec.body, values));
    }
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body, signal });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      throw new LlmError(`Could not reach ${new URL(url).origin}: ${err?.message ?? 'no answer'}.`);
    }
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(30, Number(res.headers.get('retry-after')) || 5);
      await sleep(wait * 1000, signal);
      return call(spec, values, signal, attempt + 1);
    }
    const message = () => {
      const m = getPath(data, p.errorMessage ?? 'error.message') ?? data?.detail?.message ?? data?.detail ?? data?.message ?? data?.error;
      return typeof m === 'string' ? m : m ? JSON.stringify(m) : text.slice(0, 200);
    };
    if (!res.ok) throw new LlmError(`The model service answered ${res.status}${message() ? `: ${message()}` : ''}.`, res.status);
    if (p.ok && !getPath(data, p.ok)) throw new LlmError(`The model service refused the request${message() ? `: ${message()}` : ''}.`);
    if (data === null) throw new LlmError('The model service did not answer with JSON.');
    return data;
  }

  // The answer from a status response or a webhook event, or null while it is not finished.
  function outcome(data, spec) {
    const state = String(getPath(data, spec.state) ?? '').toLowerCase();
    if (p.status.done.includes(state)) {
      const answer = getPath(data, spec.answer);
      const text = typeof answer === 'string' ? answer : answer == null ? '' : JSON.stringify(answer, null, 2);
      return { state, answer: text + (spec.sources ? formatSources(getPath(data, spec.sources)) : '') };
    }
    if (p.status.failed.includes(state)) {
      const error = getPath(data, spec.error ?? 'error.message');
      return { state, error: `The model service could not answer${error ? `: ${typeof error === 'string' ? error : JSON.stringify(error)}` : '.'}` };
    }
    return { state, pending: true };
  }

  return {
    baseUrl: new URL(p.submit.url).origin,
    async: true,

    async listModels() {
      return [];
    },

    async chat({ model = '', messages, onToken = () => {}, signal, purpose = 'chat', onState = () => {} }) {
      const values = { prompt: promptFromMessages(messages), model, webhook_url: webhook?.url ?? '', date: today(now), purpose, app: 'tracker-editor' };
      const submitted = await call(p.submit, values, signal);
      const taskId = getPath(submitted, p.submit.taskId);
      if (missing(taskId)) throw new LlmError(`The model service accepted the request but no task id was at "${p.submit.taskId}".`);
      onState('queued');
      const deadline = now() + p.timeout * 1000;
      // Progress events ("running") are skipped: only a final one ends the wait.
      const finalEvent = async () => {
        for (;;) {
          const result = outcome(await webhook.wait(taskId, signal), { ...p.status, ...p.webhook });
          if (!result.pending) return result;
        }
      };
      const viaWebhook = webhook ? finalEvent().catch(() => new Promise(() => {})) : null;
      let rev = '';
      for (;;) {
        if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
        const data = await call(p.status, { ...values, task_id: taskId, rev }, signal);
        const result = outcome(data, p.status);
        onState(result.state);
        if (result.error) throw new LlmError(result.error);
        if (!result.pending) {
          onToken(result.answer);
          return result.answer;
        }
        if (now() > deadline) throw new LlmError(`No answer from the model service after ${p.timeout} seconds.`);
        // With a revision the server holds the next call open until the task changes.
        const nextRev = p.status.rev ? getPath(data, p.status.rev) : undefined;
        if (!missing(nextRev)) {
          rev = nextRev;
          continue;
        }
        const pause = (webhook ? Math.max(10, p.status.interval * 5) : p.status.interval) * 1000;
        const early = await Promise.race([sleep(pause, signal).then(() => null), viaWebhook].filter(Boolean));
        if (early && !early.pending) {
          if (early.error) throw new LlmError(early.error);
          onToken(early.answer);
          return early.answer;
        }
      }
    },

    async embed() {
      throw new LlmError('This model connection has no embeddings: search by meaning needs an OpenAI-compatible server.');
    },
  };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    });
  });
}
