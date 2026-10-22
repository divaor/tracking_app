// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/localFetch.js); keep the two in step.
// fetch() for servers on this computer (the local model, a speech server). In
// the desktop app it goes through the main process, so Ollama, LM Studio or
// Kokoro need no CORS setup; in the browser it is plain fetch().

function desktopFetch(url, init = {}) {
  const bridge = window.desktop.llm;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let controller;
  const stream = new ReadableStream({
    start: (c) => (controller = c),
    cancel: () => bridge.abort(id),
  });
  const off = bridge.onChunk(id, (chunk, done, error) => {
    if (chunk) controller.enqueue(chunk);
    if (error) controller.error(new Error(error));
    else if (done) controller.close();
    if (done || error) off();
  });
  init.signal?.addEventListener('abort', () => bridge.abort(id));
  return bridge.request(id, url, { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null }).then(
    // 204 and the like may not have a body.
    (meta) => new Response([101, 204, 205, 304].includes(meta.status) ? null : stream, { status: meta.status, statusText: meta.statusText, headers: meta.headers }),
    (err) => {
      off();
      throw new TypeError(err?.message ?? 'Request failed');
    },
  );
}

export const localFetch = (url, init) => (window.desktop?.llm ? desktopFetch(url, init) : fetch(url, init));
