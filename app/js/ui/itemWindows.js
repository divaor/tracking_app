import { html, useRef } from '../../vendor/preact-htm.js';
import { clampRect, MIN_W } from '../windowLayout.js';
import { Icon } from './icons.js';
import { ItemPanel } from './itemModal.js';

const EDGES = ['e', 's', 'se', 'w', 'sw'];
const viewport = () => ({ x: 0, y: 0, w: innerWidth, h: innerHeight });

/**
 * An item in a window of its own over the app (desktop): several can be open, the same item
 * more than once. Its top bar drags it (double-click maximizes), its edges resize it; while
 * dragging, the element moves at once and the place is kept (`onChange`) when let go.
 */
export function ItemWindow({ win, item, z, front, actions, projects, tagSuggestions, today, onChange, onFocus, onClose, onMinimize, onMaximize }) {
  const ref = useRef(null);

  const drag = (e, edge) => {
    if (e.button !== 0) return;
    if (!edge && e.target.closest('button, a, input, select, textarea, label')) return;
    // The bar keeps its clicks (double-click maximizes, a click focuses); an edge only resizes.
    if (edge) e.preventDefault();
    const el = ref.current;
    // A maximized window dragged by its bar comes back to its own size under the pointer.
    const base = !edge && win.max && win.restore ? { ...win.restore, x: e.clientX - win.restore.w / 2, y: win.y } : { x: win.x, y: win.y, w: win.w, h: win.h };
    const start = { px: e.clientX, py: e.clientY };
    let next = base;
    let moved = false;
    // Captured only once it is a drag, so a click and a double-click still reach the bar.
    if (edge) el.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      // A click (or the first of a double-click) is not a drag.
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) {
        document.body.classList.add('window-dragging');
        el.setPointerCapture?.(ev.pointerId);
      }
      moved = true;
      let r = { ...base };
      if (!edge) r = { ...r, x: base.x + dx, y: base.y + dy };
      if (edge?.includes('e')) r.w = base.w + dx;
      if (edge?.includes('s')) r.h = base.h + dy;
      if (edge?.includes('w')) {
        r.w = Math.max(MIN_W, base.w - dx);
        r.x = base.x + base.w - r.w;
      }
      next = clampRect(r, viewport());
      Object.assign(el.style, { left: `${next.x}px`, top: `${next.y}px`, width: `${next.w}px`, height: `${next.h}px` });
    };
    // On the page, not the window: the pointer can leave it before the drag captures it.
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      document.body.classList.remove('window-dragging');
      if (moved) onChange({ ...next, max: false, restore: null });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };

  const tools = html`<button type="button" class="icon-btn win-min" title="Minimize: keep it in the bar below" aria-label="Minimize"
      onClick=${onMinimize}><${Icon} name="minimize" /></button>
    <button type="button" class="icon-btn win-max" title=${win.max ? 'Restore' : 'Maximize'} aria-label=${win.max ? 'Restore' : 'Maximize'}
      onClick=${onMaximize}><${Icon} name=${win.max ? 'restore' : 'maximize'} /></button>`;

  return html`<${ItemPanel} frame="window" item=${item} actions=${actions} projects=${projects} tagSuggestions=${tagSuggestions} today=${today}
    rootRef=${ref} initialScroll=${win.scroll} find=${win.find} onClose=${onClose} tools=${tools}
    rootProps=${{
      class: `${front ? 'front' : ''} ${win.min ? 'minimized' : ''} ${win.max ? 'maximized' : ''}`,
      style: { left: `${win.x}px`, top: `${win.y}px`, width: `${win.w}px`, height: `${win.h}px`, zIndex: z },
      inert: win.min,
      'data-window': win.wid,
      onPointerDownCapture: onFocus,
    }}
    onHeadPointerDown=${(e) => drag(e)}
    onHeadDoubleClick=${(e) => !e.target.closest('button') && onMaximize()}>
    ${!win.max && EDGES.map((edge) => html`<div key=${edge} class="win-edge edge-${edge}" onPointerDown=${(e) => drag(e, edge)} />`)}
  </${ItemPanel}>`;
}

/**
 * The bar of item windows: one button per window (a minimized one comes back, the front one
 * is minimized, another comes to the front), then Side by side, Minimize all and Close all.
 */
export function WindowDock({ windows, items, front, onPick, onClose, onTile, onMinimizeAll, onCloseAll }) {
  const shown = windows.filter((w) => !w.min).length;
  return html`<div class="window-dock" role="toolbar" aria-label="Item windows">
    <div class="dock-inner">
      ${windows.map((w) => {
        const item = items.get(w.id);
        if (!item) return null;
        const title = item.title || 'Untitled';
        return html`<div key=${w.wid} class="dock-chip type-${item.type} ${w.min ? 'min' : ''} ${w.wid === front ? 'front' : ''}">
          <button type="button" class="dock-open" title=${w.min ? `${title}: show it` : w.wid === front ? `${title}: minimize it` : `${title}: bring it to the front`}
            onClick=${() => onPick(w)}><${Icon} name=${item.type} size=${14} /><span>${title}</span></button>
          <button type="button" class="dock-close" aria-label=${`Close ${title}`} title="Close" onClick=${() => onClose(w)}><${Icon} name="x" size=${13} /></button>
        </div>`;
      })}
      <span class="dock-sep" />
      ${shown >= 2 &&
      html`<button type="button" class="icon-btn sm" title="Side by side" aria-label="Side by side" onClick=${onTile}><${Icon} name="columns" size=${16} /></button>`}
      ${shown >= 1 &&
      html`<button type="button" class="icon-btn sm" title="Minimize all (out of the way)" aria-label="Minimize all" onClick=${onMinimizeAll}><${Icon} name="minimize" size=${16} /></button>`}
      <button type="button" class="icon-btn sm" title="Close all" aria-label="Close all windows" onClick=${onCloseAll}><${Icon} name="x" size=${16} /></button>
    </div>
  </div>`;
}
