// The release board's drawer: a release with its tabs (overview, features, merges, commands, tests,
// decisions, recommendations, links), or a feature, test, decision or event. Opened from anywhere on
// the board (`onOpen({ type, id, tab, command })`), with Back through what was opened from it.
import { html, useContext, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { liveRecords, releaseProgress, statusLabel } from '../boards.js';
import { Bar, BoardComments, BoardEdit, BoardText, boardDay, Chip, Command, DecisionCard, Empty, ItemLink, KeyValues, releaseColor, Steps } from './boardParts.js';
import { Icon } from './icons.js';
import { ListenButton, sourceOf } from './listen.js';

// What a drawer does not read aloud: its bar, tabs, buttons and fields, comment times.
const DRAWER_NOT_READ = '.rb-dr-bar, .rb-dr-tabs, .rb-comment-head .muted, .rb-comment-new, .rb-comment-open, .rb-decide, button, input, textarea, select, label, .rb-code';

// An open decision decided here: one of its options (buttons), or the person's words; a decided one
// can be opened again. Claude sees it on its next look (get_board since, the log).
function Decide({ d }) {
  const edit = useContext(BoardEdit);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!edit) return null;
  const label = d.code || d.title || d.id;
  const go = async (choice) => {
    setBusy(true);
    if (await edit.decide(d.id, choice, label)) setText('');
    setBusy(false);
  };
  if (d.status !== 'open') {
    return html`<div class="rb-decide decided">
      ${d.decided_by && html`<span class="muted small">Decided ${d.decided_at ? `${boardDay(d.decided_at)} ` : ''}by ${d.decided_by}</span>`}
      <button type="button" class="btn sm" disabled=${busy} onClick=${() => go(null)}>Open it again</button>
    </div>`;
  }
  const options = (Array.isArray(d.options) ? d.options : []).map((o) => (typeof o === 'string' ? o : String(o?.label ?? ''))).filter(Boolean);
  return html`<div class="rb-decide">
    <h4>Decide</h4>
    ${options.length > 0 && html`<div class="rb-options">${options.map((o) => html`<button type="button" key=${o} class="btn sm" disabled=${busy} onClick=${() => go(o)}>${o}</button>`)}</div>`}
    <div class="rb-decide-row">
      <input type="text" value=${text} placeholder=${options.length ? 'Or say what you decided' : 'What you decided'} aria-label="What you decided"
        onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && text.trim() && go(text)} />
      <button type="button" class="btn sm primary" disabled=${busy || !text.trim()} onClick=${() => go(text)}>Decide</button>
    </div>
    <p class="muted small">Claude sees your decision on its next look at the board; a comment below can say why.</p>
  </div>`;
}

export function Drawer({ board, open, onOpen, onBack, onClose, titles, canBack }) {
  const ref = useRef(null);
  // A layout effect, so an Escape pressed right after it opens closes it.
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open.command) setTimeout(() => ref.current?.querySelector(`#rb-cmd-${CSS.escape(open.command)}`)?.scrollIntoView({ block: 'center' }), 50);
    else ref.current?.querySelector('.rb-dr-body')?.scrollTo?.(0, 0);
  }, [open.type, open.id, open.tab, open.command]);
  const byId = (part) => new Map(liveRecords(board, part).map((r) => [r.id, r]));
  const release = (id) => html`<button type="button" class="link-btn" onClick=${() => onOpen({ type: 'release', id })}>${id}</button>`;
  let head = null;
  let tabs = [];
  const body = {};
  if (open.type === 'release') {
    const r = byId('releases').get(open.id);
    if (!r) return null;
    const p = releaseProgress(r);
    const color = releaseColor(r);
    const features = (r.features ?? []).map((id) => byId('features').get(id)).filter(Boolean);
    const tests = (r.tests ?? []).map((id) => byId('tests').get(id)).filter(Boolean);
    const decisions = (r.decisions ?? []).map((id) => byId('decisions').get(id)).filter(Boolean);
    const commands = [...(r.commands ?? [])].sort((a, b) => (a.status === 'done') - (b.status === 'done'));
    head = html`<div class="rb-kicker">Release</div><h2 class="rb-dr-title">${r.id} · <${BoardText} text=${r.title} titles=${titles} /></h2>
      <div class="rb-dr-meta"><${Chip} status=${r.status} label=${r.short_status} />${r.ship_label && html`<span class="rb-tag">${r.ship_label}</span>`}<${ItemLink} id=${r.item} titles=${titles} label="release item" /></div>
      <${Bar} percent=${p.percent} color=${color} /><div class="small muted">${p.percent}% · ${p.done} of ${p.total} steps done</div>`;
    tabs = [
      ['overview', 'Overview'],
      ['features', 'Features', features.length],
      ['merges', 'Merges', (r.merges ?? []).length],
      ['commands', 'Commands', commands.filter((c) => c.status !== 'done').length],
      ['tests', 'Tests', tests.length],
      ['decisions', 'Decisions', decisions.length],
      ['reco', 'Recommendations', (r.recommendations ?? []).length + (r.risks ?? []).length],
      ['links', 'Links', (r.links ?? []).length],
    ];
    const dates = r.dates ?? {};
    body.overview = html`${r.summary && html`<p><${BoardText} text=${r.summary} titles=${titles} /></p>`}
      <h4>Dates</h4><${KeyValues} rows=${[['Opened', dates.opened], ['Merged', dates.merged], ['Deployed', dates.deployed], ['Tested', dates.tested], ['Closed', dates.closed], ['Expected', dates.expected]].map(([k, v]) => [k, boardDay(v)])} />
      <h4>Steps</h4><${Steps} steps=${r.steps} titles=${titles} part="releases" record=${r} />
      <${BoardComments} record=${r} part="releases" titles=${titles} />`;
    body.features = features.length
      ? html`<ul class="rb-list">${features.map((f) => html`<li key=${f.id}><button type="button" class="link-btn" onClick=${() => onOpen({ type: 'feature', id: f.id })}><b>${f.name}</b></button> <${Chip} status=${f.status} />
          <div class="rb-desc"><${BoardText} text=${f.what} titles=${titles} /></div>
          <div class="rb-links">${(f.repos ?? []).map((x) => html`<span class="rb-tag" key=${x}>${x}</span>`)}${(f.items ?? []).map((i) => html`<${ItemLink} key=${i} id=${i} titles=${titles} />`)}</div></li>`)}</ul>`
      : html`<${Empty}>No features listed.</${Empty}>`;
    body.merges = (r.merges ?? []).length
      ? html`<div class="rb-table-scroll"><table class="rb-table"><thead><tr><th>Repo</th><th>What</th><th>Commit</th><th>Status</th><th>When</th></tr></thead><tbody>
          ${r.merges.map((m, i) => html`<tr key=${i}><td><b>${m.repo}</b></td><td><${BoardText} text=${m.branch} titles=${titles} />${m.into && html` <span class="muted">→ ${m.into}</span>`}
            ${m.note && html`<div class="rb-desc"><${BoardText} text=${m.note} titles=${titles} /></div>`}${m.mr && html`<div class="small"><${BoardText} text=${m.mr} titles=${titles} /></div>`}</td>
            <td class="rb-mono">${m.commit || ''}</td><td><${Chip} status=${m.status === 'merged' ? 'done' : m.status === 'held' ? 'planned' : 'pending'} label=${m.status} /></td><td class="small rb-nowrap">${boardDay(m.date)}</td></tr>`)}
        </tbody></table></div>`
      : html`<${Empty}>No merges listed.</${Empty}>`;
    body.commands = commands.length ? commands.map((c) => html`<${Command} key=${c.id || c.label} c=${c} titles=${titles} release=${r} highlight=${open.command && c.id === open.command} />`) : html`<${Empty}>No commands for this release.</${Empty}>`;
    body.tests = tests.length
      ? html`<ul class="rb-list">${tests.map((t) => html`<li key=${t.id}><button type="button" class="link-btn" onClick=${() => onOpen({ type: 'test', id: t.id })}><b><${BoardText} text=${t.title} titles=${titles} /></b></button> <${Chip} status=${t.status} />
          ${t.note && html`<div class="rb-desc"><${BoardText} text=${t.note} titles=${titles} /></div>`}
          <div class="rb-links"><span class="rb-tag">${boardDay(t.date) || 'not run'}</span>${t.owner && html`<span class="rb-tag">${t.owner}</span>`}<${ItemLink} id=${t.item} titles=${titles} /></div></li>`)}</ul>`
      : html`<${Empty}>No tests yet.</${Empty}>`;
    body.decisions = decisions.length ? html`<div class="rb-cards">${decisions.map((d) => html`<${DecisionCard} key=${d.id} d=${d} titles=${titles} onOpen=${onOpen} />`)}</div>` : html`<${Empty}>No decisions tied to this release.</${Empty}>`;
    body.reco =
      (r.recommendations ?? []).length || (r.risks ?? []).length
        ? html`${(r.recommendations ?? []).length > 0 && html`<h4>Recommendations</h4><ul class="rb-reco">${r.recommendations.map((x, i) => html`<li key=${i}><${BoardText} text=${x} titles=${titles} /></li>`)}</ul>`}
            ${(r.risks ?? []).length > 0 && html`<h4>Risks and watch-outs</h4><ul class="rb-reco">${r.risks.map((x, i) => html`<li key=${i} class="risk"><${BoardText} text=${x} titles=${titles} /></li>`)}</ul>`}`
        : html`<${Empty}>None.</${Empty}>`;
    body.links = (r.links ?? []).length
      ? html`<ul class="rb-list">${r.links.map((l, i) => html`<li key=${i}><div class="rb-ttl"><${BoardText} text=${l.label} titles=${titles} /></div><div class="rb-links"><${ItemLink} id=${l.item} titles=${titles} />${l.url && /^https?:\/\//.test(l.url) && html`<a href=${l.url} target="_blank" rel="noopener noreferrer">${l.url}</a>`}</div></li>`)}</ul>`
      : html`<${Empty}>No links.</${Empty}>`;
  } else if (open.type === 'feature') {
    const f = byId('features').get(open.id);
    if (!f) return null;
    head = html`<div class="rb-kicker">Feature</div><h2 class="rb-dr-title">${f.name}</h2>
      <div class="rb-dr-meta"><${Chip} status=${f.status} />${f.release && release(f.release)}${(f.items ?? []).map((i) => html`<${ItemLink} key=${i} id=${i} titles=${titles} />`)}</div>`;
    const rel = f.release && byId('releases').get(f.release);
    body.overview = html`<p><${BoardText} text=${f.what} titles=${titles} /></p>${f.detail && html`<p><${BoardText} text=${f.detail} titles=${titles} /></p>`}
      <${KeyValues} rows=${[['Status', statusLabel(f.status)], ['Release', f.release ? (rel ? `${rel.id} · ${rel.title}` : f.release) : 'not in a release yet'], ['Shipped', boardDay(f.shipped)], ['Expected', boardDay(f.expected)], ['Repos', (f.repos ?? []).join(', ')], ['Session', f.session], ['Branch', f.branch], ['Commit', f.commit], ['Migration', f.migration]]} />
      ${f.blockers && html`<h4>Waiting on</h4><div class="rb-callout"><${BoardText} text=${f.blockers} titles=${titles} /></div>`}
      <${BoardComments} record=${f} part="features" titles=${titles} />`;
  } else if (open.type === 'test') {
    const t = byId('tests').get(open.id);
    if (!t) return null;
    head = html`<div class="rb-kicker">Test</div><h2 class="rb-dr-title"><${BoardText} text=${t.title} titles=${titles} /></h2>
      <div class="rb-dr-meta"><${Chip} status=${t.status} />${t.release && release(t.release)}<${ItemLink} id=${t.item} titles=${titles} /></div>`;
    body.overview = html`${t.note && html`<p><${BoardText} text=${t.note} titles=${titles} /></p>`}<${KeyValues} rows=${[['Status', statusLabel(t.status)], ['When', boardDay(t.date)], ['Owner', t.owner]]} />
      <${BoardComments} record=${t} part="tests" titles=${titles} />`;
  } else if (open.type === 'decision') {
    const d = byId('decisions').get(open.id);
    if (!d) return null;
    head = html`<div class="rb-kicker">Decision${d.code ? ` ${d.code}` : ''}</div><h2 class="rb-dr-title"><${BoardText} text=${d.title} titles=${titles} /></h2>
      <div class="rb-dr-meta"><${Chip} status=${d.status} />${d.release && release(d.release)}<${ItemLink} id=${d.item} titles=${titles} /></div>`;
    body.overview = html`${d.question && html`<p class="rb-question"><span class="muted small">The question</span><br /><${BoardText} text=${d.question} titles=${titles} /></p>`}
      <p><${BoardText} text=${d.choice} titles=${titles} /></p><${KeyValues} rows=${[['Date', boardDay(d.date)], ['Status', statusLabel(d.status)]]} />
      <${Decide} d=${d} />
      <${BoardComments} record=${d} part="decisions" titles=${titles} />`;
  } else if (open.type === 'event') {
    const e = byId('events').get(open.id);
    if (!e) return null;
    head = html`<div class="rb-kicker">${e.kind ? `Event · ${e.kind}` : 'Event'}</div><h2 class="rb-dr-title"><${BoardText} text=${e.title} titles=${titles} /></h2>
      <div class="rb-dr-meta"><${Chip} status=${e.status} />${e.release && release(e.release)}<${ItemLink} id=${e.item} titles=${titles} /></div>`;
    body.overview = html`${e.detail && html`<p><${BoardText} text=${e.detail} titles=${titles} /></p>`}<${KeyValues} rows=${[['When', boardDay(e.date)], ['Status', statusLabel(e.status)]]} />
      ${(e.steps ?? []).length > 0 && html`<h4>Steps</h4><${Steps} steps=${e.steps} titles=${titles} part="events" record=${e} />`}
      <${BoardComments} record=${e} part="events" titles=${titles} />`;
  }
  const tab = tabs.some(([id]) => id === open.tab) ? open.tab : 'overview';
  const readName = `${board.project}: ${open.id}`;
  return html`<div class="rb-scrim" onClick=${onClose} />
    <aside class="rb-drawer" role="dialog" aria-modal="true" aria-label="Release board details" tabindex="-1" ref=${ref}>
      <div class="rb-dr-head">
        <div class="rb-dr-bar">
          ${canBack && html`<button type="button" class="icon-btn" aria-label="Back" title="Back" onClick=${onBack}><${Icon} name="arrowLeft" size=${18} /></button>`}
          <span class="spacer" />
          <${ListenButton} readKey=${`board-drawer:${open.type}:${open.id}:${tab}`} name=${readName} label=${false} className="icon-btn" size=${18}
            source=${() => sourceOf(ref.current, { scroller: ref.current?.querySelector('.rb-dr-body'), notRead: DRAWER_NOT_READ, fromStart: true })} />
          <button type="button" class="icon-btn" aria-label="Close" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${18} /></button>
        </div>
        ${head}
      </div>
      ${tabs.length > 1 && html`<div class="rb-dr-tabs" role="tablist">${tabs.map(([id, label, n]) => html`<button type="button" key=${id} role="tab" aria-selected=${tab === id} class=${tab === id ? 'on' : ''} onClick=${() => onOpen({ ...open, tab: id, command: '' }, { replace: true })}>${label}${n != null && html`<span class="n">${n}</span>`}</button>`)}</div>`}
      <div class="rb-dr-body">${body[tab]}</div>
    </aside>`;
}
