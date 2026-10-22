// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/asyncConnection.js); keep the two in step.
// The app's side of an asynchronous model service (asyncLlm.js): the profile
// and API key from Settings, and on desktop the webhook receiver, whose events
// go to the task waiting for them.
import { createAsyncLlmClient, getPath, parseProfile } from './asyncLlm.js';
import { LlmError } from './llm.js';
import { localFetch } from './localFetch.js';
import { getSecret } from './settings.js';

const queues = new Map(); // task id → events not taken yet
const waiters = new Map(); // task id → resolve of a wait()
let taskIdPath = 'task_id';
let listening = '';
let unsubscribe = null;

function deliver(event) {
  const id = String(getPath(event, taskIdPath) ?? '');
  if (!id) return;
  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter(event);
    return;
  }
  // Early, or for a task no one waits for any more: kept a while.
  const queue = queues.get(id) ?? [];
  queue.push(event);
  queues.set(id, queue.slice(-20));
  if (queues.size > 50) queues.delete(queues.keys().next().value);
}

async function webhookFor(profile, settings) {
  const w = settings.llm.webhook;
  const bridge = globalThis.window?.desktop?.webhook;
  if (!w?.enabled || !w.publicUrl || !bridge) return null;
  taskIdPath = profile.webhook?.taskId ?? 'task_id';
  const key = `${w.port}|${w.path}|${profile.webhook?.signatureHeader ?? ''}`;
  if (listening !== key) {
    await bridge.listen({ port: w.port, path: w.path, signatureHeader: profile.webhook?.signatureHeader });
    listening = key;
  }
  unsubscribe ??= bridge.onEvent(deliver);
  return {
    url: w.publicUrl,
    wait(taskId, signal) {
      const id = String(taskId);
      const queued = queues.get(id);
      if (queued?.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        waiters.set(id, resolve);
        signal?.addEventListener('abort', () => {
          waiters.delete(id);
          reject(new DOMException('Stopped', 'AbortError'));
        });
      });
    },
  };
}

/** A client with createLlmClient's shape for settings.llm.provider 'async'. */
export function asyncClient(settings) {
  const ready = async () => {
    const { profile, error } = parseProfile(settings.llm.profile || '{}');
    if (error) throw new LlmError(`Model service: ${error}`);
    return createAsyncLlmClient({ profile, apiKey: await getSecret('llm-api-key'), fetchImpl: localFetch, webhook: await webhookFor(profile, settings) });
  };
  return {
    async: true,
    get baseUrl() {
      try {
        return new URL(JSON.parse(settings.llm.profile).submit.url).origin;
      } catch {
        return '';
      }
    },
    listModels: async () => [],
    chat: async (options) => (await ready()).chat(options),
    embed: async (options) => (await ready()).embed(options),
  };
}
