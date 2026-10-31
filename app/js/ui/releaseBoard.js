// A project's release board (#/release-board/<slug>), from the board kept with the data (boards.js,
// boardStore.js): its banner, the next milestone, the tiles, the releases' cards, what waits on you,
// the latest advancements and what is still missing. A release, feature, test, decision or event
// opens in the drawer, a release with its tabs (features, merges, commands, tests, decisions,
// recommendations, links). Claude keeps the board current (update_board); here a board file can be
// imported and the board downloaded as its standalone page's data file. #/release-board lists them.
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { boardDate, boardSummary, boardUpdated, isLive, liveRecords, releaseProgress, statusLabel } from '../boards.js';
import { cachedBoard, cachedBoards, exportBoardFile, importBoardFile, onBoards, refreshBoards } from '../boardStore.js';
import { splitItemIds } from '../itemLinks.js';
import { saveToDevice } from '../saveFile.js';
import { Icon } from './icons.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n) => String(n).padStart(2, '0');
const DAY = 86400000;

/** The boards known here, read again when the view opens and after each sync. */
export function useBoards() {
  const [, bump] = useState(0);
  useEffect(() => {
    const off = onBoards(() => bump((n) => n + 1));
    refreshBoards();
    return off;
  }, []);
  return cachedBoards();
}

function useNow(every = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/** "Mon 11-02" or "Mon 11-02 16:00 UTC", as the standalone page writes dates. */
export function boardDay(value) {
  if (!value) return '';
  const d = boardDate(value);
  if (!d) return String(value);
  const time = /\d{2}:\d{2}/.test(String(value)) ? ` ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC` : '';
  return `${WD[d.getUTCDay()]} ${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}${time}`;
}

/** "in 1 d 14 h", "3 h 5 min ago". */
export function untilText(date, now) {
  let ms = date - now;
  const past = ms < 0;
  ms = Math.abs(ms);
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const text = days ? `${days} d ${hours} h` : hours ? `${hours} h ${mins} min` : `${mins} min`;
  return past ? `${text} ago` : `in ${text}`;
}

const statusVar = (status) => `var(--st-${/^[a-z_]+$/.test(status ?? '') ? status : 'planned'}, var(--st-planned))`;

function Chip({ status, label }) {
  return html`<span class="rb-chip" style=${`--c: ${statusVar(status)}`}>${label || statusLabel(status) || 'Planned'}</span>`;
}

function ItemLink({ id, titles, label }) {
  if (!id) return null;
  const title = titles?.get(id);
  return html`<a class="rb-trk" href=${`#/item/${encodeURIComponent(id)}`} title=${title ? `${title} (${id})` : `Open ${id}`}>${label || title || id.slice(0, 8)}</a>`;
}

// Text of the board: `code`, **bold**, [label](https://…) and tracker item ids as links.
function inline(text, titles, keyBase) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  const plain = (s, k) =>
    splitItemIds(s).map((p, i) => (typeof p === 'string' ? p : html`<${ItemLink} key=${`${k}-${i}`} id=${p.id} titles=${titles} />`));
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(...plain(text.slice(last, m.index), `${keyBase}-${m.index}`));
    out.push(m[1] != null ? html`<b key=${`${keyBase}-b${m.index}`}>${m[1]}</b>` : html`<a key=${`${keyBase}-a${m.index}`} href=${m[3]} target="_blank" rel="noopener noreferrer">${m[2]}</a>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...plain(text.slice(last), `${keyBase}-end`));
  return out;
}

export function BoardText({ text, titles }) {
  if (text == null || text === '') return null;
  return String(text)
    .split(/(`[^`]+`)/g)
    .flatMap((part, i) => (/^`[^`]+`$/.test(part) ? [html`<code key=${i}>${part.slice(1, -1)}</code>`] : inline(part, titles, i)));
}

function Ring({ percent, color }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return html`<svg class="rb-ring" viewBox="0 0 54 54" role="img" aria-label=${`${percent}% done`}>
    <circle cx="27" cy="27" r=${r} fill="none" stroke="var(--rb-track)" stroke-width="6" />
    <circle cx="27" cy="27" r=${r} fill="none" stroke=${color} stroke-width="6" stroke-linecap="round" stroke-dasharray=${c.toFixed(1)} stroke-dashoffset=${(c * (1 - percent / 100)).toFixed(1)} transform="rotate(-90 27 27)" />
    <text x="27" y="31.5" text-anchor="middle">${percent}%</text>
  </svg>`;
}

const Bar = ({ percent, color }) => html`<div class="rb-progress"><i style=${`width:${Math.max(0, Math.min(100, percent))}%;background:${color}`} /></div>`;

function CodeBlock({ code }) {
  // Comments (# …) show muted, as on the page.
  const lines = String(code).split('\n').map((line, i) => {
    const at = line.indexOf('#');
    if (/^\s*#/.test(line)) return html`<span key=${i} class="c">${line}</span>`;
    if (at > 0 && /\s{2,}#/.test(line)) return html`<span key=${i}>${line.slice(0, at)}<span class="c">${line.slice(at)}</span></span>`;
    return html`<span key=${i}>${line}</span>`;
  });
  return html`<pre class="rb-code">${lines.flatMap((l, i) => (i ? ['\n', l] : [l]))}</pre>`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return html`<button type="button" class="btn sm" onClick=${() => navigator.clipboard?.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  })}><${Icon} name=${copied ? 'check' : 'copy'} size=${14} />${copied ? 'Copied' : 'Copy'}</button>`;
}

function Command({ c, titles, highlight }) {
  const done = c.status === 'done';
  return html`<div class="rb-cmd ${highlight ? 'highlight' : ''}" id=${`rb-cmd-${c.id}`}>
    <div class="rb-cmd-head">
      <div><div class="rb-ttl"><${BoardText} text=${c.label} titles=${titles} /></div>${c.when && html`<div class="small muted">${c.when}</div>`}</div>
      <div class="rb-nowrap"><${Chip} status=${done ? 'done' : 'pending'} label=${done ? 'Done' : 'To do'} />${c.code && html`<${CopyButton} text=${c.code} />`}</div>
    </div>
    ${c.code && html`<${CodeBlock} code=${c.code} />`}
    ${c.expect && html`<div class="rb-expect"><b>Expect:</b> <${BoardText} text=${c.expect} titles=${titles} /></div>`}
    ${c.if_not && html`<div class="rb-expect"><b>If not:</b> <${BoardText} text=${c.if_not} titles=${titles} /></div>`}
    ${c.item && html`<div class="rb-expect">Source: <${ItemLink} id=${c.item} titles=${titles} /></div>`}
  </div>`;
}

function KeyValues({ rows }) {
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return html`<dl class="rb-kv">${shown.map(([k, v]) => html`<dt key=${`k${k}`}>${k}</dt><dd key=${`v${k}`}>${v}</dd>`)}</dl>`;
}

function Steps({ steps, titles }) {
  if (!steps?.length) return html`<p class="muted small">No steps listed.</p>`;
  return html`<ol class="rb-steps">${steps.map((s, i) => html`<li key=${i} class=${s?.done ? 'done' : ''}>
    <span class="rb-tick" aria-label=${s?.done ? 'done' : 'to do'}>${s?.done ? html`<${Icon} name="check" size=${13} />` : ''}</span>
    <div><div><${BoardText} text=${typeof s === 'string' ? s : s?.label} titles=${titles} /></div>
    ${(s?.date || s?.by || s?.item) && html`<div class="small muted">${[boardDay(s.date), s.by].filter(Boolean).join(' · ')} ${s.item ? html`<${ItemLink} id=${s.item} titles=${titles} />` : ''}</div>`}</div>
  </li>`)}</ol>`;
}

const Empty = ({ children }) => html`<p class="rb-empty">${children}</p>`;

// ---- The drawer ---------------------------------------------------------------------------------

function Drawer({ board, open, onOpen, onBack, onClose, titles, canBack }) {
  const ref = useRef(null);
  useEffect(() => {
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
    const color = r.color || statusVar(r.status);
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
      <h4>Steps</h4><${Steps} steps=${r.steps} titles=${titles} />`;
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
    body.commands = commands.length ? commands.map((c) => html`<${Command} key=${c.id || c.label} c=${c} titles=${titles} highlight=${open.command && c.id === open.command} />`) : html`<${Empty}>No commands for this release.</${Empty}>`;
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
      ${f.blockers && html`<h4>Waiting on</h4><div class="rb-callout"><${BoardText} text=${f.blockers} titles=${titles} /></div>`}`;
  } else if (open.type === 'test') {
    const t = byId('tests').get(open.id);
    if (!t) return null;
    head = html`<div class="rb-kicker">Test</div><h2 class="rb-dr-title"><${BoardText} text=${t.title} titles=${titles} /></h2>
      <div class="rb-dr-meta"><${Chip} status=${t.status} />${t.release && release(t.release)}<${ItemLink} id=${t.item} titles=${titles} /></div>`;
    body.overview = html`${t.note && html`<p><${BoardText} text=${t.note} titles=${titles} /></p>`}<${KeyValues} rows=${[['Status', statusLabel(t.status)], ['When', boardDay(t.date)], ['Owner', t.owner]]} />`;
  } else if (open.type === 'decision') {
    const d = byId('decisions').get(open.id);
    if (!d) return null;
    head = html`<div class="rb-kicker">Decision${d.code ? ` ${d.code}` : ''}</div><h2 class="rb-dr-title"><${BoardText} text=${d.title} titles=${titles} /></h2>
      <div class="rb-dr-meta"><${Chip} status=${d.status} />${d.release && release(d.release)}<${ItemLink} id=${d.item} titles=${titles} /></div>`;
    body.overview = html`<p><${BoardText} text=${d.choice} titles=${titles} /></p><${KeyValues} rows=${[['Date', boardDay(d.date)], ['Status', statusLabel(d.status)]]} />`;
  } else if (open.type === 'event') {
    const e = byId('events').get(open.id);
    if (!e) return null;
    head = html`<div class="rb-kicker">${e.kind ? `Event · ${e.kind}` : 'Event'}</div><h2 class="rb-dr-title"><${BoardText} text=${e.title} titles=${titles} /></h2>
      <div class="rb-dr-meta"><${Chip} status=${e.status} />${e.release && release(e.release)}<${ItemLink} id=${e.item} titles=${titles} /></div>`;
    body.overview = html`${e.detail && html`<p><${BoardText} text=${e.detail} titles=${titles} /></p>`}<${KeyValues} rows=${[['When', boardDay(e.date)], ['Status', statusLabel(e.status)]]} />
      ${(e.steps ?? []).length > 0 && html`<h4>Steps</h4><${Steps} steps=${e.steps} titles=${titles} />`}`;
  }
  const tab = tabs.some(([id]) => id === open.tab) ? open.tab : 'overview';
  return html`<div class="rb-scrim" onClick=${onClose} />
    <aside class="rb-drawer" role="dialog" aria-modal="true" aria-label="Release board details" tabindex="-1" ref=${ref}>
      <div class="rb-dr-head">
        <div class="rb-dr-bar">
          ${canBack && html`<button type="button" class="icon-btn" aria-label="Back" title="Back" onClick=${onBack}><${Icon} name="arrowLeft" size=${18} /></button>`}
          <span class="spacer" />
          <button type="button" class="icon-btn" aria-label="Close" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${18} /></button>
        </div>
        ${head}
      </div>
      ${tabs.length > 1 && html`<div class="rb-dr-tabs" role="tablist">${tabs.map(([id, label, n]) => html`<button type="button" key=${id} role="tab" aria-selected=${tab === id} class=${tab === id ? 'on' : ''} onClick=${() => onOpen({ ...open, tab: id, command: '' }, { replace: true })}>${label}${n != null && html`<span class="n">${n}</span>`}</button>`)}</div>`}
      <div class="rb-dr-body">${body[tab]}</div>
    </aside>`;
}

function DecisionCard({ d, titles, onOpen }) {
  return html`<button type="button" class="rb-panel rb-dcard ${d.status === 'open' ? 'open' : ''}" onClick=${() => onOpen({ type: 'decision', id: d.id })}>
    <div class="rb-top-line"><span class="rb-mono small">${[d.code, boardDay(d.date)].filter(Boolean).join(' · ')}</span><${Chip} status=${d.status} /></div>
    <div class="rb-ttl"><${BoardText} text=${d.title} titles=${titles} /></div>
    <div class="rb-desc"><${BoardText} text=${d.choice} titles=${titles} /></div>
  </button>`;
}

// ---- The Overview ------------------------------------------------------------------------------

function Overview({ board, titles, onOpen, now }) {
  const s = boardSummary(board, now);
  const releases = liveRecords(board, 'releases');
  const features = liveRecords(board, 'features');
  const actions = liveRecords(board, 'actions');
  const log = board.log.filter((l) => !l.deleted).slice(0, 9);
  const [next, after] = s.next;
  const pct = (n, t) => (t ? (n * 100) / t : 0);
  const kpi = (n, total, label, percent, color) => html`<div class="rb-panel rb-kpi"><div class="n">${n}${total != null && html` <small>/ ${total}</small>`}</div><div class="t">${label}</div><${Bar} percent=${percent} color=${color} /></div>`;
  const openNext = (n) => (n.kind === 'event' ? onOpen({ type: 'event', id: n.id }) : onOpen({ type: 'release', id: n.id }));
  const missing = new Map();
  for (const f of features) if (!isLive(f.status)) missing.set(f.release || '', [...(missing.get(f.release || '') ?? []), f]);
  const order = [...releases.map((r) => r.id), ''];
  const relOf = new Map(releases.map((r) => [r.id, r]));
  const cardOf = new Map(s.cards.map((c) => [c.id, c]));
  return html`
    <div class="rb-hero">
      <div class="rb-hero-main">
        <h1><${BoardText} text=${board.now?.headline || `${board.project} releases`} titles=${titles} /></h1>
        ${board.now?.summary && html`<p><${BoardText} text=${board.now.summary} titles=${titles} /></p>`}
        ${releases.length > 0 && html`<div class="rb-pills">${releases.map((r) => html`<button type="button" key=${r.id} class="rb-pill" onClick=${() => onOpen({ type: 'release', id: r.id })}>${r.id} · ${r.short_status || statusLabel(r.status)}</button>`)}</div>`}
      </div>
      <div class="rb-panel rb-countdown">
        <div class="label">Next milestone</div>
        ${next
          ? html`<button type="button" class="link-btn what" onClick=${() => openNext(next)}><${BoardText} text=${next.title} titles=${titles} /></button>
              <div class="big">${untilText(next.date, now)}</div>
              <div class="small muted">${boardDay(next.date.toISOString().slice(0, 16).replace('T', ' '))}</div>
              ${after && html`<div class="after">Then: <${BoardText} text=${after.title} titles=${titles} /> · ${untilText(after.date, now)}</div>`}`
          : html`<div class="what">Nothing scheduled</div>`}
      </div>
    </div>
    <div class="rb-kpis">
      ${kpi(s.releases.out, s.releases.total, 'releases deployed (fully or partly)', pct(s.releases.out, s.releases.total), 'var(--st-live)')}
      ${kpi(s.features.live, s.features.total, 'features live', pct(s.features.live, s.features.total), 'var(--st-deploying)')}
      ${kpi(s.tests.passed, s.tests.total, 'tests passed', pct(s.tests.passed, s.tests.total), 'var(--st-testing)')}
      ${kpi(s.actions, null, 'steps waiting on you', s.actions ? 100 : 0, 'var(--st-waiting)')}
      ${kpi(s.openDecisions, null, 'decisions still open', s.openDecisions ? 100 : 0, 'var(--st-open)')}
    </div>
    ${releases.length > 0 && html`<div class="rb-section-title"><h2>Releases</h2><span class="sub">A card opens its features, merges, commands, tests, decisions and recommendations</span></div>
      <div class="rb-releases">${releases.map((r) => {
        const c = cardOf.get(r.id);
        const color = r.color || statusVar(r.status);
        return html`<button type="button" key=${r.id} class="rb-panel rb-rcard" style=${`--c:${color}`} onClick=${() => onOpen({ type: 'release', id: r.id })}>
          <div class="rb-rcard-head"><div><div class="rb-rname">${r.id}</div><${Chip} status=${r.status} label=${r.short_status} /></div><${Ring} percent=${c.progress.percent} color=${color} /></div>
          <div class="rb-rtitle"><${BoardText} text=${r.title} titles=${titles} /></div>
          <${Bar} percent=${c.progress.percent} color=${color} />
          <div class="rb-rmeta"><span>${c.progress.done} of ${c.progress.total} steps</span><b>${r.ship_label || ''}</b></div>
          <div class="rb-counts"><span>${c.features.total} features${c.features.total ? ` · ${c.features.live} live` : ''}</span><span>${c.tests.total} tests${c.tests.total ? ` · ${c.tests.passed} passed` : ''}</span><span>${c.merges} merges</span></div>
        </button>`;
      })}</div>`}
    <div class="rb-cols2">
      <div><div class="rb-section-title"><h2>Waiting on you</h2><span class="sub">in order</span></div>
        <div class="rb-panel rb-pad">${actions.length
          ? html`<ol class="rb-list rb-numbered">${actions.map((a, i) => html`<li key=${a.id}><span class="rb-num">${i + 1}</span><div>
              <div class="rb-ttl"><${BoardText} text=${a.text} titles=${titles} /></div>
              ${a.detail && html`<div class="rb-desc"><${BoardText} text=${a.detail} titles=${titles} /></div>`}
              <div class="rb-links">${a.when && html`<span class="rb-tag">${a.when}</span>`}${a.release && html`<button type="button" class="link-btn" onClick=${() => onOpen({ type: 'release', id: a.release })}>${a.release}</button>`}<${ItemLink} id=${a.item} titles=${titles} />
                ${a.command && a.release && html`<button type="button" class="link-btn" onClick=${() => onOpen({ type: 'release', id: a.release, tab: 'commands', command: a.command })}>commands</button>`}</div>
            </div></li>`)}</ol>`
          : html`<${Empty}>Nothing waits on you.</${Empty}>`}</div></div>
      <div><div class="rb-section-title"><h2>Latest advancements</h2></div>
        <div class="rb-panel rb-pad">${log.length
          ? html`<ul class="rb-list rb-log">${log.map((l) => html`<li key=${l.id}><span class="rb-when">${boardDay(l.time)}</span><div>
              <div><${BoardText} text=${l.text} titles=${titles} /></div>
              <div class="rb-links">${l.release && html`<button type="button" class="link-btn" onClick=${() => onOpen({ type: 'release', id: l.release })}>${l.release}</button>`}<${ItemLink} id=${l.item} titles=${titles} />${l.by && html`<span class="muted small">${l.by}</span>`}</div>
            </div></li>`)}</ul>`
          : html`<${Empty}>No entries yet.</${Empty}>`}</div></div>
    </div>
    ${missing.size > 0 && html`<div class="rb-section-title"><h2>Still missing</h2><span class="sub">features not live yet, by the release they are expected in</span></div>
      <div class="rb-cards">${order.filter((id) => missing.get(id)?.length).map((id) => {
        const r = relOf.get(id);
        return html`<div class="rb-panel rb-dcard" key=${id || 'none'}>
          <div class="rb-top-line"><b>${r ? `${r.id}${r.ship_label ? ` · ${r.ship_label}` : ''}` : 'Not planned in a release yet'}</b>${r ? html`<${Chip} status=${r.status} label=${r.short_status} />` : html`<${Chip} status="planned" label="No release" />`}</div>
          <ul class="rb-list">${missing.get(id).map((f) => html`<li key=${f.id}><button type="button" class="link-btn" onClick=${() => onOpen({ type: 'feature', id: f.id })}>${f.name}</button> <${Chip} status=${f.status} />
            ${f.blockers && html`<div class="rb-desc small"><${BoardText} text=${f.blockers} titles=${titles} /></div>`}</li>`)}</ul>
        </div>`;
      })}</div>`}`;
}

// ---- Import --------------------------------------------------------------------------------------

function pickText(accept, onText) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) onText(await file.text(), file.name);
  });
  input.click();
}

function ImportCard({ projects, project: fixed, actions, onDone }) {
  const [project, setProject] = useState(fixed ?? '');
  const [busy, setBusy] = useState(false);
  const run = () =>
    pickText('.html,.htm,.js,.json,text/html,application/json,text/javascript', async (text, fileName) => {
      setBusy(true);
      try {
        const { slug, project: name, counts } = await importBoardFile(text, project);
        actions.toast(`Imported ${fileName} into ${name}'s release board: ${counts.releases} releases, ${counts.features} features, ${counts.tests} tests, ${counts.decisions} decisions.`);
        onDone?.(slug);
      } catch (err) {
        actions.toast(err.message, { kind: 'error' });
      } finally {
        setBusy(false);
      }
    });
  return html`<section class="rb-panel rb-pad rb-import">
    <h3>${fixed ? 'Import a newer board file' : 'Import a release board file'}</h3>
    <p class="muted small">The standalone page (.html), its data script (.js) or its JSON. Its releases, features, tests, decisions, sessions and log go into ${fixed ? 'this' : 'the project’s'} board; nothing on the board is deleted. Claude keeps it current from then on (update_board).</p>
    <div class="rb-import-row">
      ${!fixed && html`<label class="field rb-grow"><span>Project</span><input list="rb-projects" value=${project} placeholder="The project it belongs to" onInput=${(e) => setProject(e.currentTarget.value)} />
        <datalist id="rb-projects">${projects.map((p) => html`<option key=${p.key} value=${p.name} />`)}</datalist></label>`}
      <button type="button" class="btn ${fixed ? '' : 'primary'}" disabled=${busy || !project.trim()} onClick=${run}><${Icon} name="upload" size=${16} />${busy ? 'Importing…' : 'Choose the file…'}</button>
    </div>
  </section>`;
}

// ---- The view ----------------------------------------------------------------------------------

export function ReleaseBoardView({ slug, items, projects, actions }) {
  const list = useBoards();
  const now = useNow();
  const board = slug ? cachedBoard(slug) : null;
  const titles = useMemo(() => new Map(items.map((i) => [i.id, i.title])), [items]);
  const [stack, setStack] = useState([]);
  useEffect(() => setStack([]), [slug]);
  const open = stack.at(-1);
  const onOpen = (target, { replace = false } = {}) => setStack((s) => (replace ? [...s.slice(0, -1), target] : [...s, target]));
  const color = projects.find((p) => p.key === board?.project?.toLowerCase())?.color;

  if (!slug || !board) {
    return html`<div class="rb rb-index">
      ${slug && !board && html`<div class="rb-panel rb-pad"><p>${list.length ? 'That release board is not here.' : 'Reading the release boards…'}</p></div>`}
      ${list.length > 0 && html`<div class="rb-section-title"><h2>Release boards</h2><span class="sub">one per project; Claude keeps them current</span></div>
        <div class="rb-cards">${list.map((b) => {
          const kept = cachedBoard(b.slug);
          const updated = kept ? boardUpdated(kept) : null;
          return html`<a key=${b.slug} class="rb-panel rb-dcard rb-board-link" href=${`#/release-board/${b.slug}`}>
            <div class="rb-top-line"><b>${b.project}</b><${Icon} name="rocket" size=${16} /></div>
            ${kept?.now?.headline && html`<div class="rb-desc"><${BoardText} text=${kept.now.headline} titles=${titles} /></div>`}
            ${updated?.at && html`<div class="small muted">Updated ${boardDay(updated.at.slice(0, 16).replace('T', ' '))}${updated.by ? ` by ${updated.by}` : ''}</div>`}
          </a>`;
        })}</div>`}
      <${ImportCard} projects=${projects} actions=${actions} onDone=${(s) => (location.hash = `#/release-board/${s}`)} />
    </div>`;
  }

  const updated = boardUpdated(board);
  const download = async () => {
    try {
      const { name, text } = exportBoardFile(slug);
      await saveToDevice(name, new Blob([text], { type: 'text/javascript' }));
    } catch (err) {
      actions.toast(err.message, { kind: 'error' });
    }
  };
  return html`<div class="rb" style=${color ? `--rb-hero: ${color}` : ''}>
    <div class="rb-head">
      <div class="rb-head-title"><${Icon} name="rocket" size=${18} /><span>${board.project}</span>
        ${updated.at && html`<span class="rb-updated">Updated ${boardDay(updated.at.slice(0, 16).replace('T', ' '))}${updated.by ? ` by ${updated.by}` : ''}</span>`}</div>
      <div class="rb-head-tools">
        <button type="button" class="btn sm" title="The board as its standalone page's data file" onClick=${download}><${Icon} name="download" size=${15} />Data file</button>
      </div>
    </div>
    <${Overview} board=${board} titles=${titles} onOpen=${onOpen} now=${now} />
    <${ImportCard} projects=${projects} project=${board.project} actions=${actions} />
    ${open && html`<${Drawer} key=${`${open.type}:${open.id}`} board=${board} open=${open} onOpen=${onOpen} titles=${titles} canBack=${stack.length > 1}
      onBack=${() => setStack((s) => s.slice(0, -1))} onClose=${() => setStack([])} />`}
  </div>`;
}
