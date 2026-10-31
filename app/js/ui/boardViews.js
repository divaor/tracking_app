// The release board's views (ui/releaseBoard.js shows one at a time): the Overview, the Timeline,
// Releases (cards, what runs where, workstreams, sessions), Features (filters by release, repo,
// status, words, missing only), Tests and Commands by release, Decisions (all, open, decided), the
// Log (with the older months the connector archived) and the board's search. Tables become one
// card per row on phones (`data-label` on each cell).
import { html, useContext, useEffect, useState } from '../../vendor/preact-htm.js';
import { boardDate, boardSummary, commandGroups, featureView, isLive, liveRecords, searchBoard, statusLabel, STATUSES, testGroups, waitingActions } from '../boards.js';
import { olderLog, olderLogMonths } from '../boardStore.js';
import { Bar, BoardEdit, BoardText, boardDay, Chip, Command, DecisionCard, Empty, ItemLink, opensRow, ReleaseCards, RelLink, SectionTitle, untilText, useIsNew } from './boardParts.js';
import { Icon } from './icons.js';
import { Timeline, TimelineLegend, TIMELINE_ZOOMS } from './boardTimeline.js';

const releaseName = (r, id) => (r ? `${r.id} · ${r.title ?? ''}` : id || '');

/** What waits on the person, in order, each ticked done here (`project` names the board, on Home). */
export function ActionList({ actions, titles, onOpen, project = '' }) {
  const edit = useContext(BoardEdit);
  const isNew = useIsNew();
  const [busy, setBusy] = useState('');
  if (!actions.length) return html`<${Empty}>Nothing waits on you.</${Empty}>`;
  const tick = async (a) => {
    setBusy(a.id);
    await edit.tick({ kind: 'action', id: a.id }, true, String(a.text ?? ''), a);
    setBusy('');
  };
  return html`<ol class="rb-list rb-numbered">${actions.map((a, i) => html`<li key=${a.id} class=${isNew(a) ? 'rb-new' : ''}>
    ${edit
      ? html`<button type="button" class="rb-check" role="checkbox" aria-checked="false" aria-label=${`Done: ${a.text}`} title="Mark as done" disabled=${busy === a.id} onClick=${() => tick(a)}><${Icon} name="check" size=${13} /></button>`
      : html`<span class="rb-num">${i + 1}</span>`}<div>
    <div class="rb-ttl"><${BoardText} text=${a.text} titles=${titles} /></div>
    ${a.detail && html`<div class="rb-desc"><${BoardText} text=${a.detail} titles=${titles} /></div>`}
    <div class="rb-links">${project && html`<span class="rb-tag rb-project-tag">${project}</span>`}${a.when && html`<span class="rb-tag">${a.when}</span>`}<${RelLink} id=${a.release} onOpen=${onOpen} /><${ItemLink} id=${a.item} titles=${titles} />
      ${a.command && a.release && html`<button type="button" class="link-btn" onClick=${() => onOpen({ type: 'release', id: a.release, tab: 'commands', command: a.command })}>commands</button>`}</div>
  </div></li>`)}</ol>`;
}

function LogList({ log, titles, onOpen }) {
  const isNew = useIsNew();
  if (!log.length) return html`<${Empty}>No entries yet.</${Empty}>`;
  return html`<ul class="rb-list rb-log">${log.map((l, i) => html`<li key=${l.id ?? i} class=${isNew(l) ? 'rb-new' : ''}><span class="rb-when">${boardDay(l.time)}</span><div>
    <div><${BoardText} text=${l.text} titles=${titles} /></div>
    ${(l.release || l.item || l.by) && html`<div class="rb-links"><${RelLink} id=${l.release} onOpen=${onOpen} /><${ItemLink} id=${l.item} titles=${titles} />${l.by && html`<span class="muted small">${l.by}</span>`}</div>`}
  </div></li>`)}</ul>`;
}

// ---- Overview -----------------------------------------------------------------------------------

export function Overview({ board, titles, onOpen, now, tabs, href }) {
  const s = boardSummary(board, now);
  const releases = liveRecords(board, 'releases');
  const features = liveRecords(board, 'features');
  const actions = waitingActions(board);
  const log = board.log.filter((l) => !l.deleted).slice(0, 9);
  const [next, after] = s.next;
  const pct = (n, t) => (t ? (n * 100) / t : 0);
  const kpi = (n, total, label, percent, color, tab) => {
    const body = html`<div class="n">${n}${total != null && html` <small>/ ${total}</small>`}</div><div class="t">${label}</div><${Bar} percent=${percent} color=${color} />`;
    return tabs.includes(tab) ? html`<a class="rb-panel rb-kpi" href=${href(tab)}>${body}</a>` : html`<div class="rb-panel rb-kpi">${body}</div>`;
  };
  const openNext = (n) => (n.kind === 'event' ? onOpen({ type: 'event', id: n.id }) : onOpen({ type: 'release', id: n.id }));
  const missing = new Map();
  for (const f of features) if (!isLive(f.status)) missing.set(f.release || '', [...(missing.get(f.release || '') ?? []), f]);
  const order = [...releases.map((r) => r.id), ...[...missing.keys()].filter((id) => id && !releases.some((r) => r.id === id)), ''];
  const relOf = new Map(releases.map((r) => [r.id, r]));
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
      ${kpi(s.releases.out, s.releases.total, 'releases deployed (fully or partly)', pct(s.releases.out, s.releases.total), 'var(--st-live)', 'releases')}
      ${kpi(s.features.live, s.features.total, 'features live', pct(s.features.live, s.features.total), 'var(--st-deploying)', 'features')}
      ${kpi(s.tests.passed, s.tests.total, 'tests passed', pct(s.tests.passed, s.tests.total), 'var(--st-testing)', 'tests')}
      ${kpi(s.actions, null, 'steps waiting on you', s.actions ? 100 : 0, 'var(--st-waiting)', 'overview')}
      ${kpi(s.openDecisions, null, 'decisions still open', s.openDecisions ? 100 : 0, 'var(--st-open)', 'decisions')}
    </div>
    ${releases.length > 0 && html`<${SectionTitle} title="Releases" sub="A card opens its features, merges, commands, tests, decisions and recommendations" />
      <${ReleaseCards} releases=${releases} cards=${s.cards} titles=${titles} onOpen=${onOpen} />`}
    ${tabs.includes('timeline') && html`<${SectionTitle} title="Timeline"><a class="sub" href=${href('timeline')}>Full timeline with every feature →</a></${SectionTitle}>
      <div class="rb-panel"><${Timeline} board=${board} now=${now} features=${false} dayW=${58} onOpen=${onOpen} /></div>
      <${TimelineLegend} />`}
    <div class="rb-cols2">
      <div><${SectionTitle} title="Waiting on you" sub="in order" />
        <div class="rb-panel rb-pad"><${ActionList} actions=${actions} titles=${titles} onOpen=${onOpen} /></div></div>
      <div><${SectionTitle} title="Latest advancements">${tabs.includes('log') && html`<a class="sub" href=${href('log')}>All →</a>`}</${SectionTitle}>
        <div class="rb-panel rb-pad"><${LogList} log=${log} titles=${titles} onOpen=${onOpen} /></div></div>
    </div>
    ${missing.size > 0 && html`<${SectionTitle} title="Still missing" sub="features not live yet, by the release they are expected in"><a class="sub" href=${href('features', 'missing')}>table →</a></${SectionTitle}>
      <div class="rb-cards">${order.filter((id) => missing.get(id)?.length).map((id) => {
        const r = relOf.get(id);
        return html`<div class="rb-panel rb-dcard" key=${id || 'none'}>
          <div class="rb-top-line"><b>${r ? `${r.id}${r.ship_label ? ` · ${r.ship_label}` : ''}` : id || 'Not planned in a release yet'}</b>${r ? html`<${Chip} status=${r.status} label=${r.short_status} />` : html`<${Chip} status="planned" label="No release" />`}</div>
          <ul class="rb-list">${missing.get(id).map((f) => html`<li key=${f.id}><button type="button" class="link-btn" onClick=${() => onOpen({ type: 'feature', id: f.id })}>${f.name}</button> <${Chip} status=${f.status} />
            ${f.blockers && html`<div class="rb-desc small"><${BoardText} text=${f.blockers} titles=${titles} /></div>`}</li>`)}</ul>
        </div>`;
      })}</div>`}`;
}

// ---- Timeline -----------------------------------------------------------------------------------

export function TimelineView({ board, now, onOpen, state, setState }) {
  const { features = true, dayW = 64 } = state ?? {};
  return html`<${SectionTitle} title="Timeline of releases and features">
      <div class="rb-controls">
        <label class="rb-toggle"><input type="checkbox" checked=${features} onChange=${(e) => setState({ ...state, features: e.currentTarget.checked })} /> Features</label>
        <div class="rb-seg-group" role="group" aria-label="Zoom">${TIMELINE_ZOOMS.map(([label, w]) => html`<button type="button" key=${w} class="rb-seg-btn ${dayW === w ? 'on' : ''}" aria-pressed=${dayW === w} onClick=${() => setState({ ...state, dayW: w })}>${label}</button>`)}</div>
      </div>
    </${SectionTitle}>
    <div class="rb-panel"><${Timeline} board=${board} now=${now} features=${features} dayW=${dayW} onOpen=${onOpen} /></div>
    <${TimelineLegend} />
    <p class="small muted rb-note">Bars are each release's phases (striped = planned). Diamonds are milestones. Chips are features, placed on the day they shipped or are expected; dashed chips are not live yet. Anything opens its details. Times are UTC.</p>`;
}

// ---- Releases -----------------------------------------------------------------------------------

// Workstream (brief) statuses as the page writes them.
const BRIEF_STATUS = { done: 'done', 'in progress': 'in_progress', waiting: 'waiting', 'not started': 'planned', blocked: 'blocked' };
const briefStatus = (s) => BRIEF_STATUS[String(s ?? '').toLowerCase()] ?? (STATUSES.includes(s) ? s : 'planned');
const briefLabel = (s) => (STATUSES.includes(s) ? statusLabel(s) : s);

export function ReleasesView({ board, titles, onOpen, now }) {
  const s = boardSummary(board, now);
  const releases = liveRecords(board, 'releases');
  const repos = liveRecords(board, 'repos');
  const briefs = liveRecords(board, 'briefs');
  const sessions = liveRecords(board, 'sessions');
  const meta = board.meta ?? {};
  return html`
    ${releases.length > 0 && html`<${SectionTitle} title="Releases" sub=${meta.master_order ? `Order: ${meta.master_order}` : ''} />
      <${ReleaseCards} releases=${releases} cards=${s.cards} titles=${titles} onOpen=${onOpen} />`}
    ${repos.length > 0 && html`<${SectionTitle} title="What runs where" sub=${meta.repos_checked || ''} />
      <div class="rb-panel rb-table-scroll"><table class="rb-table rb-stack">
        <thead><tr><th>Repo</th><th>Live</th><th>master</th><th>dev</th><th>Notes</th></tr></thead>
        <tbody>${repos.map((r) => html`<tr key=${r.id}><td data-label="Repo"><b>${r.repo ?? r.id}</b></td><td data-label="Live"><${BoardText} text=${r.live} titles=${titles} /></td>
          <td data-label="master"><${BoardText} text=${r.master} titles=${titles} /></td><td data-label="dev"><${BoardText} text=${r.dev} titles=${titles} /></td>
          <td data-label="Notes" class="rb-desc"><${BoardText} text=${r.note} titles=${titles} /></td></tr>`)}</tbody>
      </table></div>`}
    ${briefs.length > 0 && html`<${SectionTitle} title="Workstreams" sub="each session's work packages" />
      <div class="rb-panel rb-table-scroll"><table class="rb-table rb-stack">
        <thead><tr><th>Brief</th><th class="w30">Workstream</th><th>Status</th><th>Release</th><th class="w34">Latest</th><th>Tracker</th></tr></thead>
        <tbody>${briefs.map((b) => html`<tr key=${b.id}><td data-label="Brief"><b>${b.code ?? b.id}</b></td>
          <td data-label="Workstream"><div class="rb-ttl"><${BoardText} text=${b.title} titles=${titles} /></div>${b.owner && html`<div class="rb-desc">${b.owner}</div>`}</td>
          <td data-label="Status"><${Chip} status=${briefStatus(b.status)} label=${briefLabel(b.status)} /></td>
          <td data-label="Release" class="small">${b.release && (liveRecords(board, 'releases').some((r) => r.id === b.release) ? html`<${RelLink} id=${b.release} onOpen=${onOpen} />` : b.release)}</td>
          <td data-label="Latest" class="rb-desc"><${BoardText} text=${b.detail} titles=${titles} /></td>
          <td data-label="Tracker">${(b.item || (b.items ?? []).length > 0) && html`<div class="rb-links"><${ItemLink} id=${b.item} titles=${titles} />${(b.items ?? []).slice(0, 2).map((i) => html`<${ItemLink} key=${i} id=${i} titles=${titles} />`)}</div>`}</td></tr>`)}</tbody>
      </table></div>`}
    ${sessions.length > 0 && html`<${SectionTitle} title="Sessions" sub="who works on what" />
      <div class="rb-panel rb-table-scroll"><table class="rb-table rb-stack">
        <thead><tr><th>Session</th><th>State</th><th>Now</th><th>Tracker</th></tr></thead>
        <tbody>${sessions.map((x) => {
          const reported = boardDate(x.reported);
          return html`<tr key=${x.id}><td data-label="Session"><b>${x.name ?? x.id}</b>${reported && html`<div class="small muted" title=${x.reported}>reported ${untilText(reported, now)}</div>`}</td>
            <td data-label="State"><${Chip} status=${x.status || 'waiting'} label=${x.state} /></td>
            <td data-label="Now" class="rb-desc"><${BoardText} text=${x.now} titles=${titles} /></td>
            <td data-label="Tracker"><${ItemLink} id=${x.item} titles=${titles} /></td></tr>`;
        })}</tbody>
      </table></div>`}
    ${!releases.length && !repos.length && !briefs.length && !sessions.length && html`<${Empty}>No releases on this board yet.</${Empty}>`}`;
}

// ---- Features -----------------------------------------------------------------------------------

export function FeaturesView({ board, titles, onOpen, state, setState }) {
  const isNew = useIsNew();
  const filter = { release: '', repo: '', query: '', missing: false, statuses: [], ...state };
  const v = featureView(board, filter);
  const set = (patch) => setState({ ...filter, ...patch });
  const releases = liveRecords(board, 'releases');
  const all = liveRecords(board, 'features');
  const has = { repos: all.some((f) => (f.repos ?? []).length), session: all.some((f) => f.session), items: all.some((f) => (f.items ?? []).length) };
  const columns = 3 + has.repos + has.session + has.items;
  const toggle = (s) => set({ statuses: filter.statuses.includes(s) ? filter.statuses.filter((x) => x !== s) : [...filter.statuses, s] });
  return html`<${SectionTitle} title="Features" sub=${`${v.total} tracked · ${v.missing} not live yet`} />
    <div class="rb-filters">
      <select aria-label="Release" value=${filter.release} onChange=${(e) => set({ release: e.currentTarget.value })}>
        <option value="">All releases</option>
        ${releases.map((r) => html`<option key=${r.id} value=${r.id}>${r.id}</option>`)}
        <option value="none">Not in a release</option>
      </select>
      ${v.repos.length > 0 && html`<select aria-label="Repo" value=${filter.repo} onChange=${(e) => set({ repo: e.currentTarget.value })}>
        <option value="">All repos</option>${v.repos.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}</select>`}
      <input type="search" placeholder="Filter features" aria-label="Filter features" value=${filter.query} onInput=${(e) => set({ query: e.currentTarget.value })} />
      <label class="rb-toggle"><input type="checkbox" checked=${filter.missing} onChange=${(e) => set({ missing: e.currentTarget.checked })} /> Missing only</label>
      <span class="rb-fstats">${v.statuses.map((s) => {
        const on = !filter.statuses.length || filter.statuses.includes(s);
        return html`<button type="button" key=${s} class="rb-fstat ${on ? 'on' : ''}" aria-pressed=${filter.statuses.includes(s)} title=${`Only ${statusLabel(s)} (again: all)`} onClick=${() => toggle(s)}><${Chip} status=${s} /></button>`;
      })}</span>
    </div>
    <div class="rb-panel rb-table-scroll"><table class="rb-table rb-stack">
      <thead><tr><th class="w34">Feature</th><th>Status</th>${has.repos && html`<th>Repos</th>`}${has.session && html`<th>Session</th>`}<th>Shipped / expected</th>${has.items && html`<th>Tracker</th>`}</tr></thead>
      <tbody>
        ${v.groups.map((g) => [
          html`<tr key=${`g${g.id}`} class="rb-group-row"><td colspan=${columns}>${g.id ? releaseName(g.release, g.id) : 'Not in a release yet'} <span class="muted small">(${g.records.length})</span></td></tr>`,
          ...g.records.map((f) => html`<tr key=${f.id} class="click ${isNew(f) ? 'rb-new' : ''}" onClick=${opensRow(() => onOpen({ type: 'feature', id: f.id }))}>
            <td data-label="Feature"><button type="button" class="rb-row-open rb-ttl">${f.name}</button><div class="rb-desc"><${BoardText} text=${f.what} titles=${titles} /></div></td>
            <td data-label="Status"><${Chip} status=${f.status} /></td>
            ${has.repos && html`<td data-label="Repos">${(f.repos ?? []).length > 0 && html`<div class="rb-links">${f.repos.map((x) => html`<span class="rb-tag" key=${x}>${x}</span>`)}</div>`}</td>`}
            ${has.session && html`<td data-label="Session" class="small">${f.session || null}</td>`}
            <td data-label="When" class="small rb-nowrap-cell">${f.shipped ? `shipped ${boardDay(f.shipped)}` : f.expected ? `expected ${boardDay(f.expected)}` : html`<span class="muted">not dated</span>`}</td>
            ${has.items && html`<td data-label="Tracker">${(f.items ?? []).length > 0 && html`<div class="rb-links">${f.items.slice(0, 2).map((i) => html`<${ItemLink} key=${i} id=${i} titles=${titles} />`)}</div>`}</td>`}
          </tr>`),
        ])}
        ${!v.shown && html`<tr><td colspan=${columns} class="rb-empty">No feature matches these filters.</td></tr>`}
      </tbody>
    </table></div>`;
}

// ---- Tests --------------------------------------------------------------------------------------

export function TestsView({ board, titles, onOpen }) {
  const isNew = useIsNew();
  const groups = testGroups(board);
  const all = liveRecords(board, 'tests');
  const has = { owner: all.some((t) => t.owner), item: all.some((t) => t.item) };
  if (!groups.length) return html`<${SectionTitle} title="Tests" /><${Empty}>No tests yet.</${Empty}>`;
  return html`<${SectionTitle} title="Tests" sub="by release" />
    ${groups.map((g) => html`<div key=${g.id || 'none'}>
      <${SectionTitle} title=${g.id ? releaseName(g.release, g.id) : 'Not tied to a release'} sub=${`${g.passed} of ${g.records.length} passed`} />
      <div class="rb-panel rb-table-scroll"><table class="rb-table rb-stack">
        <thead><tr><th class="w46">Test</th><th>Status</th><th>When</th>${has.owner && html`<th>Owner</th>`}${has.item && html`<th>Tracker</th>`}</tr></thead>
        <tbody>${g.records.map((t) => html`<tr key=${t.id} class="click ${isNew(t) ? 'rb-new' : ''}" onClick=${opensRow(() => onOpen({ type: 'test', id: t.id }))}>
          <td data-label="Test"><button type="button" class="rb-row-open rb-ttl"><${BoardText} text=${t.title} titles=${titles} /></button>${t.note && html`<div class="rb-desc"><${BoardText} text=${t.note} titles=${titles} /></div>`}</td>
          <td data-label="Status"><${Chip} status=${t.status} /></td>
          <td data-label="When" class="small rb-nowrap-cell">${boardDay(t.date)}</td>
          ${has.owner && html`<td data-label="Owner" class="small">${t.owner || null}</td>`}
          ${has.item && html`<td data-label="Tracker"><${ItemLink} id=${t.item} titles=${titles} /></td>`}
        </tr>`)}</tbody>
      </table></div>
    </div>`)}`;
}

// ---- Decisions ----------------------------------------------------------------------------------

export function DecisionsView({ board, titles, onOpen, state, setState }) {
  const which = state || 'all';
  const all = liveRecords(board, 'decisions');
  const list = all.filter((d) => which === 'all' || d.status === which).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const count = (w) => (w === 'all' ? all.length : all.filter((d) => d.status === w).length);
  return html`<${SectionTitle} title="Decisions">
      <div class="rb-seg-group" role="group" aria-label="Which decisions">${['all', 'open', 'decided'].map((w) => html`<button type="button" key=${w} class="rb-seg-btn ${which === w ? 'on' : ''}" aria-pressed=${which === w} onClick=${() => setState(w)}>${w[0].toUpperCase()}${w.slice(1)} <span class="n">${count(w)}</span></button>`)}</div>
    </${SectionTitle}>
    ${list.length ? html`<div class="rb-cards">${list.map((d) => html`<${DecisionCard} key=${d.id} d=${d} titles=${titles} onOpen=${onOpen} />`)}</div>` : html`<${Empty}>No decisions here.</${Empty}>`}`;
}

// ---- Commands -----------------------------------------------------------------------------------

export function CommandsView({ board, titles }) {
  const groups = commandGroups(board);
  return html`<${SectionTitle} title="Commands" sub="every command to run, per release" />
    <div class="rb-callout">Run each block from the folder it starts with. If a check prints something other than the <b>Expect</b> line, stop and follow <b>If not</b>.</div>
    ${groups.length
      ? groups.map((g) => html`<div key=${g.release.id}>
          <${SectionTitle} title=${releaseName(g.release)} sub=${`${g.pending.length} to do · ${g.done.length} done`} />
          <div class="rb-panel rb-pad">${[...g.pending, ...g.done].map((c, i) => html`<${Command} key=${c.id || i} c=${c} titles=${titles} release=${g.release} />`)}</div>
        </div>`)
      : html`<${Empty}>No commands on this board.</${Empty}>`}`;
}

// ---- Log ----------------------------------------------------------------------------------------

export function LogView({ board, slug, titles, onOpen }) {
  const log = board.log.filter((l) => !l.deleted);
  const [months, setMonths] = useState(null); // older months not shown yet
  const [older, setOlder] = useState([]); // [{ month, log }]
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setOlder([]);
    olderLogMonths(slug)
      .then((m) => live && setMonths(m))
      .catch(() => live && setMonths([]));
    return () => (live = false);
  }, [slug]);
  const more = async () => {
    const [month, ...rest] = months;
    setBusy(true);
    try {
      const entries = await olderLog(slug, month);
      setOlder((o) => [...o, { month, log: entries }]);
      setMonths(rest);
    } finally {
      setBusy(false);
    }
  };
  return html`<${SectionTitle} title="Advancement log" sub="newest first; every change fed into this board" />
    <div class="rb-panel rb-pad"><${LogList} log=${log} titles=${titles} onOpen=${onOpen} /></div>
    ${older.map((o) => html`<div key=${o.month}><${SectionTitle} title=${o.month} sub="kept apart once the log grew long" />
      <div class="rb-panel rb-pad"><${LogList} log=${o.log} titles=${titles} onOpen=${onOpen} /></div></div>`)}
    ${months?.length > 0 && html`<div><button type="button" class="btn" disabled=${busy} onClick=${more}>${busy ? 'Reading…' : `Show ${months[0]}`}</button></div>`}`;
}

// ---- Search -------------------------------------------------------------------------------------

function Hit({ hit, titles, onOpen }) {
  const r = hit.record;
  const row = (target, rest, onClick) => html`<li class="click" onClick=${opensRow(onClick)}><div>
    <button type="button" class="rb-row-open link-btn">${target}</button> ${rest}</div></li>`;
  switch (hit.part) {
    case 'releases':
      return row(releaseName(r), html`<${Chip} status=${r.status} label=${r.short_status} />`, () => onOpen({ type: 'release', id: r.id }));
    case 'features':
      return row(r.name, html`<${Chip} status=${r.status} />${r.release && html` <span class="muted small">${r.release}</span>`}<div class="rb-desc"><${BoardText} text=${r.what} titles=${titles} /></div>`, () => onOpen({ type: 'feature', id: r.id }));
    case 'tests':
      return row(html`<${BoardText} text=${r.title} titles=${titles} />`, html`<${Chip} status=${r.status} />${r.release && html` <span class="muted small">${r.release}</span>`}`, () => onOpen({ type: 'test', id: r.id }));
    case 'decisions':
      return row(html`${r.code ? `${r.code}: ` : ''}<${BoardText} text=${r.title} titles=${titles} />`, html`<${Chip} status=${r.status} /><div class="rb-desc"><${BoardText} text=${r.choice} titles=${titles} /></div>`, () => onOpen({ type: 'decision', id: r.id }));
    case 'events':
      return row(html`<${BoardText} text=${r.title} titles=${titles} />`, html`<${Chip} status=${r.status} /> <span class="muted small">${boardDay(r.date)}</span>`, () => onOpen({ type: 'event', id: r.id }));
    case 'commands':
      return row(html`<${BoardText} text=${r.label} titles=${titles} />`, html`<${Chip} status=${r.status === 'done' ? 'done' : 'pending'} label=${r.status === 'done' ? 'Done' : 'To do'} /> <span class="muted small">${hit.release}</span>`, () =>
        onOpen({ type: 'release', id: hit.release, tab: 'commands', command: r.id }),
      );
    case 'actions':
      return html`<li><div><div class="rb-ttl"><${BoardText} text=${r.text} titles=${titles} /></div><div class="rb-links">${r.when && html`<span class="rb-tag">${r.when}</span>`}<${RelLink} id=${r.release} onOpen=${onOpen} /><${ItemLink} id=${r.item} titles=${titles} /></div></div></li>`;
    case 'sessions':
      return html`<li><div><b>${r.name ?? r.id}</b> <${Chip} status=${r.status || 'waiting'} label=${r.state} /><div class="rb-desc"><${BoardText} text=${r.now} titles=${titles} /></div></div></li>`;
    case 'briefs':
      return html`<li><div><b>${r.code ?? r.id}</b> · <${BoardText} text=${r.title} titles=${titles} /> <${Chip} status=${briefStatus(r.status)} label=${briefLabel(r.status)} /><div class="rb-desc"><${BoardText} text=${r.detail} titles=${titles} /></div></div></li>`;
    case 'repos':
      return html`<li><div><b>${r.repo ?? r.id}</b><div class="rb-desc"><${BoardText} text=${r.note} titles=${titles} /></div></div></li>`;
    default:
      return html`<li class="rb-log-hit"><span class="rb-when">${boardDay(r.time)}</span><div><${BoardText} text=${r.text} titles=${titles} />${r.release && html` <${RelLink} id=${r.release} onOpen=${onOpen} />`}</div></li>`;
  }
}

export function SearchView({ board, query, titles, onOpen }) {
  const found = searchBoard(board, query);
  return html`<${SectionTitle} title=${`Search: ${query.trim()}`} sub=${found.total ? `${found.total} found` : ''} />
    ${found.total
      ? found.groups.map((g) => html`<div key=${g.part}>
          <${SectionTitle} title=${g.label} sub=${g.total > g.hits.length ? `${g.hits.length} of ${g.total} shown` : String(g.total)} />
          <div class="rb-panel rb-pad"><ul class="rb-list rb-hits">${g.hits.map((hit, i) => html`<${Hit} key=${`${hit.part}:${hit.id || i}`} hit=${hit} titles=${titles} onOpen=${onOpen} />`)}</ul></div>
        </div>`)
      : html`<${Empty}>Nothing on this board matches.</${Empty}>`}`;
}
