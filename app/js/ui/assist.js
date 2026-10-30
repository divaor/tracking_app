import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { actionsFor, appendToNotes } from '../assist.js';
import { askAboutItem, modelReady } from '../assistant.js';
import { loadFileText } from '../files.js';
import { renderMarkdown } from '../markdown.js';
import { fileKind, isTextAttachment } from '../model.js';
import { Icon } from './icons.js';

// The text of an item's attached files the model can read (not pictures, PDFs or other documents).
async function documentsOf(item) {
  const readable = item.files.filter((f) => isTextAttachment(f) && fileKind(f.name) !== 'svg').slice(0, 4);
  const texts = await Promise.all(readable.map((f) => loadFileText(f).then((text) => ({ name: f.name, text }), () => null)));
  return texts.filter(Boolean);
}

/**
 * Ask the model about an item: summarize, break into steps, draft review
 * feedback for a document, questions, risks, translate, or any question,
 * with follow-ups. Answers can be added to the notes or used as feedback.
 */
export function ItemAssistant({ item, actions }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [conv, setConv] = useState(null); // { action, turns: [{ question, answer }], status, error, phase }
  const controller = useRef(null);
  const docs = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    controller.current?.abort();
    setConv(null);
    docs.current = null;
  }, [item.id]);
  if (!modelReady()) return null;

  const ask = async (action, followUp = '') => {
    controller.current?.abort();
    const signal = (controller.current = new AbortController()).signal;
    const turns = followUp ? conv.turns : [];
    const history = turns.flatMap((t, i) => [...(i > 0 ? [{ role: 'user', content: t.question }] : []), { role: 'assistant', content: t.answer }]).concat(followUp ? [{ role: 'user', content: followUp }] : []);
    const asking = [...turns, { question: followUp || action.label, answer: '' }];
    setConv({ action, turns: asking, status: 'asking', phase: '' });
    setQuestion('');
    let out = '';
    const show = (answer) => setConv((c) => c && { ...c, turns: [...asking.slice(0, -1), { ...asking.at(-1), answer }] });
    try {
      docs.current ??= await documentsOf(item);
      const reply = await askAboutItem(action, item, docs.current, { history, signal, onToken: (t) => show((out += t)), onState: (phase) => setConv((c) => c && { ...c, phase }) });
      show(reply || out);
      setConv((c) => c && { ...c, status: 'done' });
    } catch (err) {
      if (err?.name === 'AbortError') return setConv((c) => (c && c.turns.length > 1 ? { ...c, turns: c.turns.slice(0, -1), status: 'done' } : null));
      setConv((c) => c && { ...c, status: 'error', error: err.message });
    }
  };
  const submit = () => {
    const q = question.trim();
    if (!q) return;
    if (conv?.status === 'done') return ask(conv.action, q);
    ask({ id: 'custom', label: q, use: 'answer', prompt: q });
  };
  const last = conv?.turns.at(-1);

  if (!open) {
    return html`<button type="button" class="btn ghost assist-open" onClick=${() => setOpen(true)}><${Icon} name="sparkle" size=${16} />Ask the model about this</button>`;
  }
  return html`<section class="item-assist" aria-label="Ask the model">
    <h3><${Icon} name="sparkle" size=${16} />Model
      <span class="spacer" />
      ${conv && html`<button type="button" class="btn ghost sm" onClick=${() => (controller.current?.abort(), setConv(null))}>New</button>`}
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${() => (controller.current?.abort(), setConv(null), setOpen(false))}><${Icon} name="x" size=${16} /></button>
    </h3>
    ${!conv &&
    html`<div class="assist-actions">
      ${actionsFor(item).map((a) => html`<button type="button" key=${a.id} class="btn sm" onClick=${() => ask(a)}><${Icon} name=${a.icon} size=${14} />${a.label}</button>`)}
    </div>`}
    ${conv &&
    html`<div class="assist-thread" aria-live="polite">
      ${conv.turns.map(
        (t, i) => html`<div class="assist-turn" key=${i}>
          <p class="assist-question">${t.question}</p>
          ${t.answer
            ? html`<div class="markdown assist-answer" dangerouslySetInnerHTML=${{ __html: renderMarkdown(t.answer) }} />`
            : conv.status === 'asking' && i === conv.turns.length - 1 && html`<p class="muted small"><${Icon} name="sync" size=${14} /> Thinking… ${conv.phase && conv.phase !== 'done' ? `(${conv.phase})` : ''}</p>`}
        </div>`,
      )}
      ${conv.status === 'asking' && html`<button type="button" class="btn sm" onClick=${() => controller.current?.abort()}><${Icon} name="stop" size=${14} />Stop</button>`}
      ${conv.status === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${15} />${conv.error}</p>`}
      ${conv.status === 'done' &&
      html`<div class="assist-answer-actions">
        ${conv.action.use === 'feedback' && conv.turns.length === 1
          ? html`<button type="button" class="btn primary sm" onClick=${() => actions.useFeedback(item, last.answer)}><${Icon} name="check" size=${14} />Use as my feedback</button>`
          : html`<button type="button" class="btn ${conv.action.use === 'notes' ? 'primary' : ''} sm" onClick=${() => actions.addToNotes(item, last.answer)}><${Icon} name="edit" size=${14} />Add to the notes</button>`}
        <button type="button" class="btn sm" onClick=${() => navigator.clipboard.writeText(last.answer).then(() => actions.toast('Copied'))}><${Icon} name="copy" size=${14} />Copy</button>
      </div>`}
    </div>`}
    <form class="assist-ask" onSubmit=${(e) => (e.preventDefault(), submit())}>
      <input value=${question} disabled=${conv?.status === 'asking'} aria-label="Your question" onInput=${(e) => setQuestion(e.currentTarget.value)}
        placeholder=${conv?.status === 'done' ? 'Ask a follow-up…' : item.type === 'doc' ? 'Ask about this document…' : 'Ask anything about it…'} />
      <button type="submit" class="btn primary sm" disabled=${!question.trim() || conv?.status === 'asking'} aria-label="Ask"><${Icon} name="send" size=${14} /></button>
    </form>
  </section>`;
}
