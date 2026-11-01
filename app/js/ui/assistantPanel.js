// The assistant that does things (2.5): ask it to change the tracker, or how to do something.
// Each question goes with a picture of the tracker (assistantSteps.js contextText); the model's
// ```tracker-steps blocks become cards: looking steps run at once and go back to it; steps that are
// easy to undo run by themselves; the others wait for Apply (deleting ones in red) and show first
// what they will change. Every change has Undo (field by field: what changed since stays). Steps
// run in order and stop at the first that fails or is skipped; the results go back to the model.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import {
  applyDataStep,
  assistantMessages,
  asksHow,
  boardAfter,
  boardChanges,
  boardFor,
  boardIsEmpty,
  changeRows,
  contextText,
  DATA_STEPS,
  dataChanges,
  guideFor,
  lookText,
  MAX_ROUNDS,
  parsePlan,
  resultsMessage,
  rowsText,
  undoBoardChanges,
  undoDataChanges,
  wordsSoFar,
} from '../assistantSteps.js';
import { llmClient, modelReady } from '../assistant.js';
import { boardSlug } from '../boards.js';
import { cachedBoard, cachedBoards, changeBoard, refreshBoards, removeBoard } from '../boardStore.js';
import { renderMarkdown } from '../markdown.js';
import { nowIso, projectKey, resolveProjectName } from '../model.js';
import { connectionOf } from '../providers.js';
import { getSettings } from '../settings.js';
import { store } from '../store.js';
import { Icon } from './icons.js';

// The guide, loaded once: the model answers how to do things from it.
let guideText = null;
const loadGuide = () =>
  (guideText ??= fetch('help/guide.md')
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => ''));

export const SUGGESTIONS = [
  'What is due this week?',
  'Move my overdue tasks to next week',
  'Make a project Kitchen with tasks: fix the leak, call the plumber on Monday, buy parts',
  'What waits on me on my release boards?',
  'Pin my tasks in progress',
  'How do I attach a photo to an item?',
];

const RISK = {
  look: { label: 'Looks', icon: 'eye' },
  auto: { label: 'Done by itself (Undo)', icon: 'play' },
  ask: { label: 'Asks first', icon: 'help' },
  danger: { label: 'Deletes: asks with a warning', icon: 'alert' },
};

const device = () => getSettings().device || 'this device';
const boardsHere = () => cachedBoards().map(({ slug, project }) => ({ slug, project, board: cachedBoard(slug) }));

/** Names for the cards' texts: titles of items, projects with their counts, how many items have a tag. */
function namesOf(env) {
  return {
    titleOf: (id) => env.items.find((i) => i.id === id)?.title,
    projectOf: (name) => env.projects.find((p) => p.key === projectKey(name)) ?? null,
    tagCount: (tag) => {
      const t = String(tag).replace(/^#/, '').toLowerCase();
      return env.items.filter((i) => i.tags.some((x) => x.toLowerCase() === t)).length;
    },
  };
}

/** Where a board step writes: { slug, project } (a project without a board: the board it would start). */
function boardTarget(step, env) {
  const found = boardFor(boardsHere(), step.project);
  const project = found?.project ?? resolveProjectName(step.project, env.projects.map((p) => p.name));
  return { slug: found?.slug ?? boardSlug(project), project, board: found?.board ?? null };
}

/** What a step that waits for Apply would change (a dry run on what is here): rows, or a problem. */
function preview(s, env) {
  try {
    if (DATA_STEPS.has(s.op)) {
      const before = { items: store.all(), projects: store.allProjects() };
      return { rows: changeRows(dataChanges(before, applyDataStep(before, s.step, { now: nowIso(), by: device() }))) };
    }
    if (s.board) {
      const t = boardTarget(s.step, env);
      return { rows: changeRows(boardChanges(t.board, boardAfter(t.board, s.step, { at: nowIso(), by: device(), project: t.project }))) };
    }
  } catch (err) {
    return { problem: err.message };
  }
  return { rows: [] };
}

const WHAT = { added: 'New', deleted: 'Deleted', changed: 'Changed', commented: 'Comment' };

function Rows({ rows, max = 12 }) {
  if (!rows?.length) return null;
  return html`<ul class="aip-rows">
    ${rows.slice(0, max).map(
      (r) => html`<li class=${`aip-row ${r.what}`} key=${`${r.kind}:${r.part ?? ''}:${r.id}`}>
        <span class="aip-what">${WHAT[r.what] ?? r.what}${r.kind === 'project' ? ' project' : r.kind === 'record' && r.part !== 'now' ? ` ${r.part === 'log' ? 'log line' : r.part.replace(/s$/, '')}` : ''}</span>
        ${r.kind === 'item' && r.what !== 'deleted' ? html`<a href=${`#/item/${r.id}`} class="aip-title">${r.title}</a>` : html`<span class="aip-title">${r.title}</span>`}
        ${r.changes.length > 0 &&
        html`<span class="aip-changes">${r.changes.map((c) => html`<span class="aip-change" key=${c.field}><span class="muted">${c.field}</span> ${c.from === '—' ? '' : html`<s>${c.from}</s> `}→ ${c.to}</span>`)}</span>`}
      </li>`,
    )}
    ${rows.length > max && html`<li class="aip-row muted small">and ${rows.length - max} more</li>`}
  </ul>`;
}

function StepCard({ s, onDecide, onUndo }) {
  const r = RISK[s.risk] ?? RISK.ask;
  const icon = s.status === 'ok' ? 'check' : s.status === 'failed' ? 'alert' : s.status === 'running' ? 'sync' : s.status === 'undone' ? 'rotate' : r.icon;
  return html`<div class=${`aip-step risk-${s.risk} st-${s.status}`}>
    <div class="aip-step-head">
      <span class="aip-step-icon" title=${r.label}><${Icon} name=${icon} size=${14} /></span>
      <span class="aip-step-text">${s.text}${s.why && html`<span class="muted small"> · ${s.why}</span>`}</span>
    </div>
    ${(s.status === 'waiting' || s.status === 'ok' || s.status === 'undone' || s.status === 'shown') && html`<${Rows} rows=${s.rows} />`}
    ${s.status === 'waiting' && s.risk === 'danger' && html`<p class="aip-warn small"><${Icon} name="alert" size=${13} /><span>${s.op === 'delete-items' ? 'Deleted items can be brought back with Undo here, or from the message when you delete one by hand.' : 'Undo here brings it back.'}</span></p>`}
    ${s.status === 'waiting' &&
    html`<div class="aip-step-actions">
      <button type="button" class=${`btn sm ${s.risk === 'danger' ? 'danger-solid' : 'primary'}`} onClick=${() => onDecide('run')}><${Icon} name="check" size=${13} />${s.risk === 'danger' ? 'Delete' : 'Apply'}</button>
      <button type="button" class="btn ghost sm" title="Leave this step out (the ones after it are not done either)" onClick=${() => onDecide('skip')}>Skip</button>
      <button type="button" class="btn ghost sm" title="Do none of the steps left" onClick=${() => onDecide('stop')}>Stop</button>
    </div>`}
    ${s.look && s.output && html`<details class="aip-out"><summary class="small muted">What it found</summary><pre>${s.output}</pre></details>`}
    ${s.status === 'failed' && html`<p class="notice error small"><${Icon} name="alert" size=${14} /><span>${s.output}</span></p>`}
    ${s.status === 'ok' && s.note && html`<p class="muted small">${s.note}</p>`}
    ${s.status === 'ok' && s.undo && html`<div class="aip-step-actions"><button type="button" class="btn ghost sm" title="Put back what this step changed (what changed since stays)" onClick=${() => onUndo(s)}><${Icon} name="rotate" size=${13} />Undo</button></div>`}
    ${s.status === 'undone' && html`<p class="muted small">Undone${s.kept ? `; ${s.kept} left as they are (changed since)` : ''}</p>`}
    ${s.status === 'shown' && html`<p class="muted small">For you to do (Only explain is on)</p>`}
    ${s.status === 'skipped' && html`<p class="muted small">Skipped</p>`}
    ${s.status === 'stopped' && html`<p class="muted small">Not done</p>`}
  </div>`;
}

/**
 * The panel. `env()` gives what the app shows now: { items (live), projects (projectList's), today,
 * screen: { label, shown (items) } | null, open: the item open | null }. `start`: { question } to
 * ask at once. `actions`: the app's (openById, showItems, plan, toast, command).
 */
export function AssistantPanel({ env, start = null, actions, onClose }) {
  const { llm } = getSettings();
  const ready = modelReady() && connectionOf(llm) !== 'async';
  const [turns, setTurns] = useState([]); // [{ question, parts: [{ text } | { steps }], problems }]
  const [busy, setBusy] = useState(null); // null | 'asking' | 'running' | 'waiting'
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  // The person does it themselves: the model explains, nothing changes.
  const [explainOnly, setExplainOnly] = useState(Boolean(start?.explainOnly));
  const history = useRef([]); // the conversation for the model (without the pictures)
  const controller = useRef(null);
  const decide = useRef(null); // resolves the step waiting for Apply / Skip / Stop
  const input = useRef(null);
  const end = useRef(null);

  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => {
    refreshBoards().catch(() => {});
    return () => (controller.current?.abort(), decide.current?.('stop'));
  }, []);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [turns, busy]);
  useLayoutEffect(() => {
    if (start?.question && ready) ask(start.question);
  }, []);

  const updateLast = (fn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts.at(-1))] : ts));
  const setPart = (index, part) => updateLast((t) => ({ ...t, parts: t.parts.map((p, i) => (i === index ? part : p)) }));

  /** The picture of the tracker, as it is now. */
  const picture = () => {
    const e = env();
    const time = new Date().toTimeString().slice(0, 5);
    return contextText({ today: e.today, time, items: e.items, projects: e.projects, boards: cachedBoards(), screen: e.screen ? { label: e.screen.label, shown: e.screen.shown?.length } : null, open: e.open });
  };

  /** One answer from the model, streamed into a new part; resolves to the plan. */
  const modelTurn = async (userContent, withPicture, signal, opts) => {
    const messages = assistantMessages(userContent, withPicture ? picture() : '', history.current, opts);
    let partIndex = -1;
    updateLast((t) => {
      partIndex = t.parts.length;
      return { ...t, parts: [...t.parts, { text: '' }] };
    });
    let out = '';
    const reply = await llmClient().chat({
      model: llm.chatModel,
      purpose: 'ask',
      messages,
      signal,
      onToken: (tok) => {
        out += tok;
        setPart(partIndex, { text: wordsSoFar(out) });
      },
      onState: (p) => setPhase(p === 'done' ? '' : p),
    });
    const full = reply || out;
    history.current.push({ role: 'user', content: userContent }, { role: 'assistant', content: full });
    const plan = parsePlan(full, namesOf(env()));
    setPart(partIndex, { text: plan.text });
    if (plan.problems.length) updateLast((t) => ({ ...t, problems: [...(t.problems ?? []), ...plan.problems] }));
    return plan;
  };

  /** Does one step: { status, output, rows, undo, note }. */
  const doStep = async (s) => {
    const e = env();
    if (s.look) return { status: 'ok', output: lookText(s.step, { items: e.items, projects: e.projects, boards: boardsHere(), shown: e.screen?.shown ?? null, today: e.today, now: new Date() }) };
    if (DATA_STEPS.has(s.op)) {
      const { before, after } = store.change((data) => applyDataStep(data, s.step, { now: nowIso(), by: device() }));
      const changes = dataChanges(before, after);
      const rows = changeRows(changes);
      return { status: 'ok', output: rowsText(rows), rows, undo: rows.length ? { kind: 'data', changes } : null };
    }
    if (s.board) {
      const t = boardTarget(s.step, e);
      let wrote = null;
      await changeBoard(t.slug, (there, stamp) => boardAfter(there, s.step, { ...stamp, project: t.project }), s.text.slice(0, 80), {
        create: s.op === 'update-board' ? t.project : '',
        onWrite: (before, after) => (wrote = { before, after }),
      });
      const changes = boardChanges(wrote.before, wrote.after);
      const rows = changeRows(changes);
      return { status: 'ok', output: rowsText(rows), rows, undo: rows.length ? { kind: 'board', slug: t.slug, changes } : null };
    }
    switch (s.op) {
      case 'make-plan':
        actions.plan(s.step.kind);
        return { status: 'ok', output: `The ${s.step.kind === 'week' ? 'review of the week' : 'plan for today'} is being written on the Overview; the earlier one stays among its versions.`, note: 'On the Overview' };
      case 'open-item': {
        if (!e.items.some((i) => i.id === s.step.id)) return { status: 'failed', output: `There is no item “${s.step.id}”.` };
        actions.openById(s.step.id);
        return { status: 'ok', output: 'Opened.' };
      }
      case 'open-board': {
        const t = boardTarget(s.step, e);
        if (!t.board) return { status: 'failed', output: `${s.step.project} has no release board.` };
        location.hash = `#/release-board/${t.slug}${s.step.view && s.step.view !== 'overview' ? `/${s.step.view}` : ''}`;
        return { status: 'ok', output: 'Shown.' };
      }
      case 'show-items':
        actions.showItems(s.step);
        return { status: 'ok', output: 'Shown in the list.' };
      default:
        return { status: 'failed', output: `${s.op} cannot be done here.` };
    }
  };

  /** Runs the steps in order: looking and automatic ones at once, the others after Apply. */
  const runSteps = async (steps, { onlyShown = false } = {}) => {
    let partIndex = -1;
    const cards = steps.map((d) => ({ ...d, status: 'pending', output: '', rows: null }));
    updateLast((t) => {
      partIndex = t.parts.length;
      return { ...t, parts: [...t.parts, { steps: cards }] };
    });
    const set = (i, patch) => {
      cards[i] = { ...cards[i], ...patch };
      setPart(partIndex, { steps: [...cards] });
    };
    let stopped = false;
    for (let i = 0; i < cards.length; i++) {
      const s = cards[i];
      if (stopped) {
        set(i, { status: 'stopped' });
        continue;
      }
      if (onlyShown && !s.look) {
        set(i, { status: 'shown', rows: preview(s, env()).rows ?? null });
        continue;
      }
      if (s.risk === 'ask' || s.risk === 'danger') {
        const seen = preview(s, env());
        if (seen.problem) {
          set(i, { status: 'failed', output: seen.problem });
          stopped = true;
          continue;
        }
        setBusy('waiting');
        set(i, { status: 'waiting', rows: seen.rows });
        const choice = await new Promise((resolve) => (decide.current = resolve));
        decide.current = null;
        if (choice !== 'run') {
          set(i, { status: choice === 'skip' ? 'skipped' : 'stopped' });
          stopped = true;
          if (choice === 'stop') return { results: cards, userStopped: true };
          continue;
        }
      }
      setBusy('running');
      set(i, { status: 'running' });
      try {
        set(i, await doStep(s));
      } catch (err) {
        set(i, { status: 'failed', output: err?.message ?? String(err) });
      }
      if (cards[i].status === 'failed') stopped = true;
    }
    return { results: cards, userStopped: false };
  };

  const ask = async (q) => {
    if (!q.trim() || busy) return;
    controller.current?.abort();
    const signal = (controller.current = new AbortController()).signal;
    setError('');
    setQuestion('');
    setTurns((ts) => [...ts, { question: q, parts: [], problems: [] }]);
    setBusy('asking');
    try {
      // The guide: always for an AI provider (in the system message, cached); for a model on this
      // computer (small contexts), only its parts about the question, when it asks how.
      const local = connectionOf(llm) === 'local';
      const guide = await loadGuide();
      const opts = { explainOnly, guide: local ? '' : guide, excerpts: local && (explainOnly || asksHow(q)) ? guideFor(guide, q) : '' };
      let plan = await modelTurn(q, true, signal, opts);
      for (let round = 1; round < MAX_ROUNDS && plan.steps.length; round++) {
        const looks = plan.steps.filter((s) => s.look);
        if (!looks.length && explainOnly) {
          await runSteps(plan.steps, { onlyShown: true });
          break;
        }
        const { results, userStopped } = await runSteps(looks.length ? looks : plan.steps);
        if (userStopped || signal.aborted) break;
        setBusy('asking');
        // After changes, the model sees the tracker as it is now.
        const changed = !looks.length && results.some((r) => r.status === 'ok');
        const note = looks.length && looks.length < plan.steps.length ? '\n\n(The other steps in that block were not done: looking steps go in a block of their own. Propose them again if they are still right.)' : '';
        plan = await modelTurn(`${resultsMessage(results)}${note}`, changed, signal, { ...opts, excerpts: '' });
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err?.message ?? String(err));
    } finally {
      setBusy(null);
      setPhase('');
      setTimeout(() => input.current?.focus(), 0);
    }
  };

  const undo = async (card) => {
    const u = card.undo;
    let kept = 0;
    try {
      if (u.kind === 'data') {
        ({ kept } = store.change((data) => undoDataChanges(data, u.changes, { now: nowIso(), by: device() })).after);
      } else if (!(u.changes.created && (await removeBoard(u.slug, (there) => boardIsEmpty(undoBoardChanges(there, u.changes, { at: nowIso(), by: device() }).board), 'removed (Undo)')))) {
        await changeBoard(u.slug, (there, stamp) => {
          const out = undoBoardChanges(there, u.changes, stamp);
          kept = out.kept;
          return out.board;
        }, 'undone');
      }
    } catch (err) {
      actions.toast(`Could not undo: ${err?.message ?? err}`, { kind: 'error' });
      return;
    }
    setTurns((ts) => ts.map((t) => ({ ...t, parts: t.parts.map((p) => (p.steps ? { steps: p.steps.map((s) => (s === card ? { ...s, status: 'undone', kept } : s)) } : p)) })));
    history.current.push({ role: 'user', content: `(I clicked Undo on “${card.text}”: what it changed is back as it was${kept ? `, except ${kept} that changed since` : ''}.)` }, { role: 'assistant', content: 'Understood.' });
  };

  const stop = () => {
    controller.current?.abort();
    decide.current?.('stop');
  };

  const head = html`<div class="aip-head">
    <span class="aip-title-bar"><${Icon} name="sparkle" size=${17} />Assistant</span>
    <span class="spacer" />
    ${turns.length > 0 && html`<button type="button" class="btn ghost sm" title="Start over" disabled=${Boolean(busy)} onClick=${() => ((history.current = []), setTurns([]), setError(''))}>New</button>`}
    <button type="button" class="icon-btn sm" aria-label="Close" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
  </div>`;

  if (!ready) {
    return html`<div class="aip-body">
      ${head}
      <div class="aip-scroll">
        <p>${llm.enabled && connectionOf(llm) === 'async' ? 'The assistant needs a model that answers at once (on this computer, or an AI provider with your API key): a service that answers later cannot follow along step by step.' : 'The assistant needs a model: one on this computer (Ollama, LM Studio) or an AI provider with your API key (Claude, OpenAI, Gemini…).'}</p>
        <p class="muted small">Then ask it to add, change, tag, move or tick things, or how to do something in the app.</p>
        <div class="aip-step-actions"><button type="button" class="btn primary sm" onClick=${() => (onClose(), actions.command('model-settings'))}>Set up in Settings</button></div>
      </div>
    </div>`;
  }

  return html`<div class="aip-body">
    ${head}
    <div class="aip-scroll">
      ${!turns.length &&
      html`<div class="aip-intro">
        <p class="small muted">Say what to do (add, change, tag, move, mark done, comment, plan, release boards) or ask how to do something. Small changes are done at once, each with Undo; changing many items asks first, and deleting asks with a warning. The model sees your projects and tags, and only the items it looks up.</p>
        <div class="aip-suggest">${SUGGESTIONS.map((s) => html`<button type="button" class="tag aip-chip" key=${s} onClick=${() => ask(s)}>${s}</button>`)}</div>
      </div>`}
      <div class="assist-thread" aria-live="polite">
        ${turns.map(
          (t, ti) => html`<div class="assist-turn" key=${ti}>
            <p class="assist-question">${t.question}</p>
            ${t.parts.map((p, pi) =>
              p.steps
                ? html`<div class="aip-steps" key=${pi}>${p.steps.map((s, si) => html`<${StepCard} key=${si} s=${s} onDecide=${(c) => decide.current?.(c)} onUndo=${undo} />`)}</div>`
                : p.text && html`<div class="markdown assist-answer" key=${pi} dangerouslySetInnerHTML=${{ __html: renderMarkdown(p.text) }} />`,
            )}
            ${t.problems?.length > 0 && html`<p class="notice small"><${Icon} name="help" size=${14} /><span>Left out: ${t.problems.join('; ')}</span></p>`}
          </div>`,
        )}
        ${busy === 'asking' && html`<p class="muted small aip-busy"><${Icon} name="sync" size=${14} /> Thinking…${phase ? ` (${phase})` : ''}</p>`}
        ${busy && busy !== 'waiting' && html`<button type="button" class="btn sm aip-stop" onClick=${stop}><${Icon} name="stop" size=${14} />Stop</button>`}
        ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
        <span ref=${end} />
      </div>
    </div>
    <form class="aip-ask" onSubmit=${(e) => (e.preventDefault(), ask(question))}>
      <div class="aip-mode" role="group" aria-label="What the assistant does">
        <button type="button" class=${`tag aip-chip ${explainOnly ? '' : 'on'}`} aria-pressed=${!explainOnly} disabled=${Boolean(busy)} title="The assistant makes the changes: small ones at once (with Undo), the rest after you click Apply" onClick=${() => setExplainOnly(false)}>Help me do it</button>
        <button type="button" class=${`tag aip-chip ${explainOnly ? 'on' : ''}`} aria-pressed=${explainOnly} disabled=${Boolean(busy)} title="The assistant tells you where to click; nothing changes" onClick=${() => setExplainOnly(true)}>Only explain, I’ll do it</button>
      </div>
      <div class="aip-input">
        <textarea ref=${input} rows="2" value=${question} aria-label="Ask the assistant" disabled=${Boolean(busy)}
          placeholder=${turns.length ? 'Ask a follow-up…' : 'Say what to do, or ask how: “tag my Deep Time tasks #layers”'}
          onInput=${(e) => setQuestion(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(question);
            }
          }} />
        <button type="submit" class="icon-btn primary aip-send" aria-label="Ask" title="Ask (Enter)" disabled=${!question.trim() || Boolean(busy)}><${Icon} name="send" size=${16} /></button>
      </div>
    </form>
  </div>`;
}
