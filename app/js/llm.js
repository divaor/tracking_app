// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/llm.js); keep the two in step.
// Client for a local model server with an OpenAI-compatible API: Ollama
// (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1),
// llama.cpp, Jan and others. On desktop the app passes a fetch that goes
// through the Electron main process, so no CORS settings are needed.

export class LlmError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

export const DEFAULT_LLM_URL = 'http://localhost:11434/v1';

export function createLlmClient({ baseUrl = DEFAULT_LLM_URL, apiKey = '', fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(path, body, signal) {
    const headers = { Accept: body?.stream ? 'text/event-stream' : 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new LlmError(`Could not reach the model server at ${base}. Is Ollama or LM Studio running?`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = data?.error?.message ?? data?.error ?? data?.message ?? '';
      } catch {
        // not JSON
      }
      const hint = res.status === 404 ? ' Check the model name and that it is downloaded (for Ollama: ollama pull <model>).' : '';
      throw new LlmError(`The model server answered ${res.status}${detail ? `: ${detail}` : ''}.${hint}`, res.status);
    }
    return res;
  }

  return {
    baseUrl: base,

    /** Names of the models the server has. */
    async listModels() {
      const data = await (await call('/models')).json();
      return (data?.data ?? []).map((m) => m.id).filter(Boolean).sort();
    },

    /** Streams a chat answer: `onToken` gets each piece; resolves to the full text. */
    async chat({ model, messages, onToken = () => {}, signal, temperature = 0.2 }) {
      const res = await call('/chat/completions', { model, messages, temperature, stream: true }, signal);
      if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content ?? '';
        onToken(text);
        return text;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return full;
          try {
            const piece = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? '';
            if (piece) {
              full += piece;
              onToken(piece);
            }
          } catch {
            // ignore keep-alives and partial noise
          }
        }
      }
      return full;
    },

    /**
     * Text that continues `prompt` (the legacy /completions endpoint, not streamed), for
     * suggestions as you type. `suffix` is the text after the cursor: models that fill in the
     * middle (FIM) use it, others ignore it.
     */
    async complete({ model, prompt, suffix = '', maxTokens = 128, temperature = 0.2, stop, signal }) {
      const body = { model, prompt, max_tokens: maxTokens, temperature, stream: false };
      if (suffix) body.suffix = suffix;
      if (stop?.length) body.stop = stop;
      const data = await (await call('/completions', body, signal)).json();
      return data?.choices?.[0]?.text ?? '';
    },

    /** One vector per input text. */
    async embed({ model, input, signal }) {
      const data = await (await call('/embeddings', { model, input }, signal)).json();
      const rows = [...(data?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== input.length) throw new LlmError(`The model server returned ${rows.length} embeddings for ${input.length} texts. Is “${model}” an embedding model?`);
      return rows.map((r) => r.embedding);
    },
  };
}
