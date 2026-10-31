// The release board's small parts (ui/releaseBoard.js, its views, timeline and drawer): the board's
// way of writing dates, status chips, its text (`code`, **bold**, links and tracker ids), rings and
// bars, commands with Copy, steps, decision and release cards.
import { html, useState } from '../../vendor/preact-htm.js';
import { boardDate, statusLabel } from '../boards.js';
import { splitItemIds } from '../itemLinks.js';
import { Icon } from './icons.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n) => String(n).padStart(2, '0');
const DAY = 86400000;

/** "Mon 11-02" or "Mon 11-02 16:00 UTC", as the standalone page writes dates. */
export function boardDay(value) {
  if (!value) return '';
  const d = boardDate(value);
  if (!d) return String(value);
  const time = /\d{2}:\d{2}/.test(String(value)) ? ` ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC` : '';
  return `${WD[d.getUTCDay()]} ${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}${time}`;
}

/** An ISO time as the board writes one ("Sat 10-31 02:58 UTC"). */
export const boardStamp = (iso) => (iso ? boardDay(String(iso).slice(0, 16).replace('T', ' ')) : '');

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

/** The colour of a status (`--st-<status>`, planned's for others). */
export const statusVar = (status) => `var(--st-${/^[a-z_]+$/.test(status ?? '') ? status : 'planned'}, var(--st-planned))`;

// A colour the board names (a release's `color`) only when it is one: #hex, a name, rgb() or hsl().
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i;
/** A release's colour: its own, else its status's. */
export const releaseColor = (r) => (COLOR.test(String(r?.color ?? '').trim()) ? String(r.color).trim() : statusVar(r?.status));

export function Chip({ status, label }) {
  return html`<span class="rb-chip" style=${`--c: ${statusVar(status)}`}>${label || statusLabel(status) || 'Planned'}</span>`;
}

export function ItemLink({ id, titles, label }) {
  if (!id) return null;
  const title = titles?.get(id);
  return html`<a class="rb-trk" href=${`#/item/${encodeURIComponent(id)}`} title=${title ? `${title} (${id})` : `Open ${id}`}>${label || title || id.slice(0, 8)}</a>`;
}

/** A release's id as a link that opens it in the drawer. */
export function RelLink({ id, onOpen }) {
  if (!id) return null;
  return html`<button type="button" class="link-btn" onClick=${() => onOpen({ type: 'release', id })}>${id}</button>`;
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

export function Ring({ percent, color }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return html`<svg class="rb-ring" viewBox="0 0 54 54" role="img" aria-label=${`${percent}% done`}>
    <circle cx="27" cy="27" r=${r} fill="none" stroke="var(--rb-track)" stroke-width="6" />
    <circle cx="27" cy="27" r=${r} fill="none" stroke=${color} stroke-width="6" stroke-linecap="round" stroke-dasharray=${c.toFixed(1)} stroke-dashoffset=${(c * (1 - percent / 100)).toFixed(1)} transform="rotate(-90 27 27)" />
    <text x="27" y="31.5" text-anchor="middle">${percent}%</text>
  </svg>`;
}

export const Bar = ({ percent, color }) => html`<div class="rb-progress"><i style=${`width:${Math.max(0, Math.min(100, percent))}%;background:${color}`} /></div>`;

export function CodeBlock({ code }) {
  // Comments (# …) show muted, as on the page.
  const lines = String(code).split('\n').map((line, i) => {
    const at = line.indexOf('#');
    if (/^\s*#/.test(line)) return html`<span key=${i} class="c">${line}</span>`;
    if (at > 0 && /\s{2,}#/.test(line)) return html`<span key=${i}>${line.slice(0, at)}<span class="c">${line.slice(at)}</span></span>`;
    return html`<span key=${i}>${line}</span>`;
  });
  return html`<pre class="rb-code">${lines.flatMap((l, i) => (i ? ['\n', l] : [l]))}</pre>`;
}

export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return html`<button type="button" class="btn sm" onClick=${() => navigator.clipboard?.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  })}><${Icon} name=${copied ? 'check' : 'copy'} size=${14} />${copied ? 'Copied' : 'Copy'}</button>`;
}

export function Command({ c, titles, highlight }) {
  const done = c.status === 'done';
  return html`<div class="rb-cmd ${highlight ? 'highlight' : ''} ${done ? 'done' : ''}" id=${c.id ? `rb-cmd-${c.id}` : undefined}>
    <div class="rb-cmd-head">
      <div><div class="rb-ttl"><${BoardText} text=${c.label} titles=${titles} /></div>${c.when && html`<div class="small muted"><${BoardText} text=${c.when} titles=${titles} /></div>`}</div>
      <div class="rb-nowrap"><${Chip} status=${done ? 'done' : 'pending'} label=${done ? 'Done' : 'To do'} />${c.code && html`<${CopyButton} text=${c.code} />`}</div>
    </div>
    ${c.code && html`<${CodeBlock} code=${c.code} />`}
    ${c.expect && html`<div class="rb-expect"><b>Expect:</b> <${BoardText} text=${c.expect} titles=${titles} /></div>`}
    ${c.if_not && html`<div class="rb-expect"><b>If not:</b> <${BoardText} text=${c.if_not} titles=${titles} /></div>`}
    ${c.item && html`<div class="rb-expect">Source: <${ItemLink} id=${c.item} titles=${titles} /></div>`}
  </div>`;
}

export function KeyValues({ rows }) {
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return html`<dl class="rb-kv">${shown.map(([k, v]) => html`<dt key=${`k${k}`}>${k}</dt><dd key=${`v${k}`}>${v}</dd>`)}</dl>`;
}

export function Steps({ steps, titles }) {
  if (!steps?.length) return html`<p class="muted small">No steps listed.</p>`;
  return html`<ol class="rb-steps">${steps.map((s, i) => html`<li key=${i} class=${s?.done ? 'done' : ''}>
    <span class="rb-tick" aria-label=${s?.done ? 'done' : 'to do'}>${s?.done ? html`<${Icon} name="check" size=${13} />` : ''}</span>
    <div><div><${BoardText} text=${typeof s === 'string' ? s : s?.label} titles=${titles} /></div>
    ${(s?.date || s?.by || s?.item) && html`<div class="small muted">${[boardDay(s.date), s.by].filter(Boolean).join(' · ')} ${s.item ? html`<${ItemLink} id=${s.item} titles=${titles} />` : ''}</div>`}</div>
  </li>`)}</ol>`;
}

export const Empty = ({ children }) => html`<p class="rb-empty">${children}</p>`;

export function SectionTitle({ title, sub, children }) {
  return html`<div class="rb-section-title"><h2>${title}</h2>${sub && html`<span class="sub">${sub}</span>`}${children}</div>`;
}

// A click on a card or a table row opens what it shows, unless it was on a link or another button
// inside it (the row's own title button passes its click on, so the keyboard reaches it too).
export const opensRow = (open) => (e) => {
  const target = e.target.closest('a, button');
  if (!target || target.classList.contains('rb-row-open')) open();
};

export function DecisionCard({ d, titles, onOpen }) {
  return html`<div class="rb-panel rb-dcard clickable ${d.status === 'open' ? 'open' : ''}" onClick=${opensRow(() => onOpen({ type: 'decision', id: d.id }))}>
    <div class="rb-top-line"><span class="rb-mono small muted">${[d.code, boardDay(d.date)].filter(Boolean).join(' · ')}</span><${Chip} status=${d.status} /></div>
    <button type="button" class="rb-row-open rb-ttl"><${BoardText} text=${d.title} titles=${titles} /></button>
    <div class="rb-desc"><${BoardText} text=${d.choice} titles=${titles} /></div>
    ${(d.release || d.item) && html`<div class="rb-links"><${RelLink} id=${d.release} onOpen=${onOpen} /><${ItemLink} id=${d.item} titles=${titles} /></div>`}
  </div>`;
}

/** The releases' cards: ring, progress, steps, counts. `cards` is boardSummary's. */
export function ReleaseCards({ releases, cards, titles, onOpen }) {
  const cardOf = new Map(cards.map((c) => [c.id, c]));
  return html`<div class="rb-releases">${releases.map((r) => {
    const c = cardOf.get(r.id);
    const color = releaseColor(r);
    return html`<button type="button" key=${r.id} class="rb-panel rb-rcard" style=${`--c:${color}`} onClick=${() => onOpen({ type: 'release', id: r.id })}>
      <div class="rb-rcard-head"><div><div class="rb-rname">${r.id}</div><${Chip} status=${r.status} label=${r.short_status} /></div><${Ring} percent=${c.progress.percent} color=${color} /></div>
      <div class="rb-rtitle"><${BoardText} text=${r.title} titles=${titles} /></div>
      <${Bar} percent=${c.progress.percent} color=${color} />
      <div class="rb-rmeta"><span>${c.progress.done} of ${c.progress.total} steps</span><b>${r.ship_label || ''}</b></div>
      <div class="rb-counts"><span>${c.features.total} features${c.features.total ? ` · ${c.features.live} live` : ''}</span><span>${c.tests.total} tests${c.tests.total ? ` · ${c.tests.passed} passed` : ''}</span><span>${c.merges} merges</span></div>
    </button>`;
  })}</div>`;
}
