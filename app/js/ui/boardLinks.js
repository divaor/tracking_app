// The release boards in the rest of the tracker: what waits on the person on every board (Home, in
// order of when, ticked done here), what on the boards points to an item (the open item's "On the
// release board"), and the boards' log on a day (Days).
import { html, useMemo, useState } from '../../vendor/preact-htm.js';
import { boardDayLog, boardLinksTo, statusLabel, waitingEverywhere } from '../boards.js';
import { cachedBoard } from '../boardStore.js';
import { BoardText, boardDay, Chip, untilText } from './boardParts.js';
import { Icon } from './icons.js';
import { boardEditor, boardHref, useBoards } from './releaseBoard.js';

const DRAWER_OF = { releases: 'release', features: 'feature', tests: 'test', decisions: 'decision', events: 'event' };
const PART_WORD = { releases: 'Release', features: 'Feature', tests: 'Test', decisions: 'Decision', events: 'Event', actions: 'Waiting on you', briefs: 'Workstream', sessions: 'Session' };

/** The boards read here: [{ slug, board }], those `inScope` (by project) when given (not read again: the sidebar and each sync do). */
function useBoardList(inScope) {
  const list = useBoards(false);
  return list.map(({ slug }) => ({ slug, board: cachedBoard(slug) })).filter(({ board }) => board && (!inScope || inScope(board.project)));
}

/** Home's "Waiting on you": every board's steps waiting on the person, those with a time first. */
export function BoardsWaiting({ actions, inScope, titles }) {
  const boards = useBoardList(inScope);
  const editors = useMemo(() => new Map(), []);
  const [busy, setBusy] = useState('');
  const now = new Date();
  const waiting = waitingEverywhere(boards, now);
  if (!waiting.length) return null;
  const editorOf = (slug) => editors.get(slug) ?? editors.set(slug, boardEditor(slug, actions)).get(slug);
  const tick = async (w) => {
    setBusy(`${w.slug}:${w.action.id}`);
    await editorOf(w.slug).tick({ kind: 'action', id: w.action.id }, true, String(w.action.text ?? ''));
    setBusy('');
  };
  const shown = waiting.slice(0, 8);
  return html`<section class="section board-waiting">
    <header class="section-head">
      <h2><${Icon} name="rocket" size=${17} />Waiting on you<span class="count">${waiting.length}</span></h2>
      ${waiting.length > shown.length && html`<a class="see-all" href="#/release-board">All boards<${Icon} name="arrowRight" size=${14} /></a>`}
    </header>
    <ol class="board-waiting-list">${shown.map((w) => {
      const a = w.action;
      const soon = w.time && w.time - now < 86_400_000;
      return html`<li key=${`${w.slug}:${a.id}`} class="board-waiting-row">
        <button type="button" class="rb-check" role="checkbox" aria-checked="false" aria-label=${`Done: ${a.text}`} title="Mark as done" disabled=${busy === `${w.slug}:${a.id}`} onClick=${() => tick(w)}><${Icon} name="check" size=${13} /></button>
        <div class="board-waiting-body">
          <div class="board-waiting-text"><${BoardText} text=${a.text} titles=${titles} /></div>
          <div class="board-waiting-meta">
            <a class="rb-tag rb-project-tag" href=${boardHref(w.slug)}>${w.project}</a>
            ${a.when && html`<span class="rb-tag ${soon ? 'soon' : ''}">${a.when}${w.time ? ` · ${untilText(w.time, now)}` : ''}</span>`}
            ${a.release && html`<a class="link" href=${boardHref(w.slug, 'release', a.release)}>${a.release}</a>`}
          </div>
        </div>
      </li>`;
    })}</ol>
  </section>`;
}

/** An open item's "On the release board": the board records that point to it, each opening there. */
export function ItemBoardLinks({ item, actions }) {
  const boards = useBoardList();
  const found = boards
    .map(({ slug, board }) => ({ slug, project: board.project, ...boardLinksTo(board, item.id) }))
    .filter((b) => b.records.length || b.log.length);
  if (!found.length) return null;
  const go = (href) => (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    actions.openBoard(href);
  };
  return html`<section class="item-boards" aria-label="On the release board">
    <h3><${Icon} name="rocket" size=${15} />On the release board</h3>
    ${found.map((b) => html`<div key=${b.slug} class="item-board">
      <a class="item-board-name" href=${boardHref(b.slug)} onClick=${go(boardHref(b.slug))}>${b.project}</a>
      <ul>${b.records.slice(0, 12).map((r) => {
        const href = DRAWER_OF[r.part] ? boardHref(b.slug, DRAWER_OF[r.part], r.id) : boardHref(b.slug);
        return html`<li key=${`${r.part}:${r.id}`}><a href=${href} onClick=${go(href)}><span class="muted small">${PART_WORD[r.part] ?? r.part}</span> ${r.title || r.id}</a>
          ${r.status && html` <${Chip} status=${r.status} label=${r.part === 'actions' ? 'Waiting' : statusLabel(r.status)} />`}</li>`;
      })}</ul>
      ${b.log.length > 0 && html`<div class="muted small">In ${b.log.length} log entr${b.log.length === 1 ? 'y' : 'ies'}, the latest ${boardDay(b.log[0].time)}: ${b.log[0].text}</div>`}
    </div>`)}
  </section>`;
}

/** The boards' log entries of a day (Days), newest first. */
export const useBoardDayLog = (day) => boardDayLog(useBoardList(), day);

/** Days: the boards' log entries of the day (useBoardDayLog's). */
export function DayBoardLog({ entries, titles }) {
  return html`<ul class="rb-list rb-log day-board-log">${entries.map(({ slug, project, entry }, i) => html`<li key=${`${slug}:${entry.id ?? i}`}>
    <span class="rb-when">${entry.time.slice(11, 16)} UTC</span>
    <div><div><${BoardText} text=${entry.text} titles=${titles} /></div>
      <div class="rb-links"><a class="rb-tag rb-project-tag" href=${boardHref(slug)}>${project}</a>${entry.release && html`<a class="link small" href=${boardHref(slug, 'release', entry.release)}>${entry.release}</a>`}${entry.by && html`<span class="muted small">${entry.by}</span>`}</div></div>
  </li>`)}</ul>`;
}
