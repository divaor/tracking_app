// The release board's timeline (boards.js timelineLayout): each release's phases as bars (striped
// when planned), its milestones as diamonds, its features as chips on the day they shipped or are
// expected (dashed: not live yet), the events in a lane of their own, and now as a line. The days
// scroll sideways under the labels, which stay in view; it opens scrolled to now. Anything opens in
// the drawer; a pointer over it says what it is (the page's tooltip, as text).
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { statusLabel, timelineLayout } from '../boards.js';
import { boardDay, releaseColor, statusVar } from './boardParts.js';

export const TIMELINE_ZOOMS = [
  ['Compact', 44],
  ['Normal', 64],
  ['Wide', 96],
];

function useNarrow(query) {
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

// The tooltip: one element, filled from the hovered part's data-tip, data-tip-line and data-tip-more.
function useTip() {
  const ref = useRef(null);
  const hide = () => ref.current && (ref.current.hidden = true);
  const place = (e) => {
    const tip = ref.current;
    if (!tip || tip.hidden) return;
    let x = e.clientX + 14;
    let y = e.clientY + 14;
    if (x + 330 > innerWidth) x = e.clientX - 330;
    if (y + tip.offsetHeight + 10 > innerHeight) y = e.clientY - tip.offsetHeight - 10;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  };
  const over = (e) => {
    const tip = ref.current;
    const t = e.target.closest?.('[data-tip]');
    if (!tip) return;
    if (!t || !matchMedia('(hover: hover)').matches) return hide();
    const [title, line, more] = tip.children;
    title.textContent = t.dataset.tip;
    line.textContent = t.dataset.tipLine ?? '';
    more.textContent = t.dataset.tipMore ?? '';
    more.hidden = !t.dataset.tipMore;
    tip.hidden = false;
    place(e);
  };
  const el = html`<div class="rb-tip" ref=${ref} hidden aria-hidden="true"><b /><span /><span class="more" /></div>`;
  return { el, handlers: { onMouseOver: over, onMouseMove: place, onMouseLeave: hide, onClick: hide, onScroll: hide } };
}

const px = (n) => `${Math.round(n * 10) / 10}px`;

export function Timeline({ board, now, features = true, dayW = 64, onOpen }) {
  const labelW = useNarrow('(max-width: 600px)') ? 104 : 170;
  const layout = useMemo(() => timelineLayout(board, { now, dayW, features }), [board, now, dayW, features]);
  const wrap = useRef(null);
  const tip = useTip();
  // Opens with now a little left of the middle (again when the zoom changes).
  useLayoutEffect(() => {
    const el = wrap.current;
    if (el && layout.now != null) el.scrollLeft = Math.max(0, layout.now - (el.clientWidth - labelW) * 0.45);
  }, [dayW, features, labelW, board.project]);
  const W = layout.width;
  const lane = (row, inner) => html`<div class="rb-tl-lane" style=${`width:${W}px;height:${row.height}px`}>${inner}</div>`;
  const release = (id, tab) => () => onOpen({ type: 'release', id, tab });
  const rows = layout.rows.map((row, i) => {
    if (row.kind === 'release') {
      const r = row.release;
      const c = releaseColor(r);
      return html`<div class="rb-tl-row" key=${`r${r.id}`}>
        <button type="button" class="rb-tl-label" onClick=${release(r.id)}><b>${r.id}</b><span class="muted">${r.short_status || statusLabel(r.status)}</span></button>
        ${lane(row, [
          ...row.segs.map((s, k) => html`<button type="button" key=${`s${k}`} class="rb-seg ${s.state === 'planned' ? 'planned' : ''} ${s.state === 'now' ? 'now' : ''}" style=${`--c:${c};left:${px(s.left)};width:${px(s.width)};top:12px`}
            data-tip=${`${r.id}: ${s.label}`} data-tip-line=${`${boardDay(s.from)} → ${boardDay(s.to)}${s.state === 'planned' ? ' (planned)' : ''}`} aria-label=${`${r.id}: ${s.label}`} onClick=${release(r.id)}>${s.width >= 34 ? s.label : ''}</button>`),
          ...row.milestones.flatMap((m, k) => [
            html`<button type="button" key=${`m${k}`} class="rb-ms ${m.done ? '' : 'planned'}" style=${`--c:${c};left:${px(m.left - 7)};top:42px`}
              data-tip=${`${r.id}: ${m.label}`} data-tip-line=${`${boardDay(m.date)} · ${m.done ? 'done' : 'planned'}`} aria-label=${`${r.id}: ${m.label}`} onClick=${release(r.id)} />`,
            m.short && html`<span key=${`ml${k}`} class="rb-ms-label" style=${`left:${px(m.left + 10)};top:40px`}>${m.short}</span>`,
          ]),
        ])}
      </div>`;
    }
    if (row.kind === 'features') {
      const r = row.release;
      return html`<div class="rb-tl-row" key=${`f${r.id}`}>
        <button type="button" class="rb-tl-label" onClick=${release(r.id, 'features')}><span class="muted">${r.id} features</span><span class="muted">${row.count}</span></button>
        ${lane(row, row.chips.map((chip, k) => {
          if (chip.more) {
            return html`<button type="button" key="more" class="rb-fchip" style=${`--c:var(--text-3);left:${px(chip.left)};top:${chip.top}px`}
              data-tip=${`${chip.label} features`} data-tip-line="Open the release to see every feature" onClick=${release(r.id, 'features')}>${chip.label}</button>`;
          }
          const f = chip.feature;
          const when = f.shipped ? `shipped ${boardDay(f.shipped)}` : f.expected ? `expected ${boardDay(f.expected)}` : 'not dated';
          return html`<button type="button" key=${`c${k}`} class="rb-fchip ${chip.missing ? 'pending' : ''}" style=${`--c:${statusVar(f.status)};left:${px(chip.left)};top:${chip.top}px`}
            data-tip=${f.name} data-tip-line=${`${statusLabel(f.status)} · ${when}`} data-tip-more=${f.what || ''} onClick=${() => onOpen({ type: 'feature', id: f.id })}>${f.name}</button>`;
        }))}
      </div>`;
    }
    return html`<div class="rb-tl-row" key=${`e${i}`}>
      <div class="rb-tl-label"><b>Events</b><span class="muted">infra, ops and other dates</span></div>
      ${lane(row, row.marks.flatMap((m, k) => {
        const c = statusVar(m.done ? 'done' : 'scheduled');
        return [
          html`<button type="button" key=${`e${k}`} class="rb-ms ${m.done ? '' : 'planned'}" style=${`--c:${c};left:${px(m.left - 7)};top:${m.top}px`}
            data-tip=${m.event.title} data-tip-line=${`${boardDay(m.event.date)} · ${statusLabel(m.event.status)}`} aria-label=${m.event.title} onClick=${() => onOpen({ type: 'event', id: m.event.id })} />`,
          html`<span key=${`el${k}`} class="rb-ms-label" style=${`left:${px(m.left + 11)};top:${m.top - 2}px`}>${m.event.title}</span>`,
        ];
      }))}
    </div>`;
  });
  return html`<div class="rb-tl-wrap" ref=${wrap} ...${tip.handlers}>
    <div class="rb-tl" style=${`width:${W + labelW}px;--label-w:${labelW}px`}>
      <div class="rb-tl-head">
        <div class="rb-tl-corner" />
        <div class="rb-tl-days" style=${`width:${W}px`}>${layout.days.map((d) => html`<div key=${d.left} class="rb-tl-day ${d.weekend ? 'we' : ''} ${d.today ? 'today' : ''}" style=${`left:${d.left}px;width:${dayW}px`}><b>${d.label}</b>${d.weekday}</div>`)}</div>
      </div>
      <div class="rb-tl-body">
        <div class="rb-tl-grid" style=${`width:${W}px`}>${layout.days.map((d) => html`<i key=${d.left} class=${d.weekend ? 'we' : ''} style=${`left:${d.left}px;width:${dayW}px`} />`)}</div>
        ${layout.now != null && html`<div class="rb-tl-today" style=${`left:${px(labelW + layout.now)}`}><span>now</span></div>`}
        ${rows}
      </div>
    </div>
    ${tip.el}
  </div>`;
}

export function TimelineLegend() {
  const items = [
    ['live', 'Live / done'],
    ['deploying', 'Deploying'],
    ['testing', 'Testing'],
    ['merged', 'Merged'],
    ['built', 'Built'],
    ['planned', 'Planned'],
    ['blocked', 'Blocked'],
  ];
  return html`<div class="rb-tl-legend">
    ${items.map(([s, label]) => html`<span key=${s}><i style=${`background:${statusVar(s)}`} />${label}</span>`)}
    <span><i class="phase" />Planned phase</span>
    <span><i class="diamond" />Milestone</span>
    <span><i class="now" />Now</span>
  </div>`;
}

