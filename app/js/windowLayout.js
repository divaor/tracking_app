// Where item windows go: their first place, keeping them reachable, side by side. Pure
// (rects are { x, y, w, h } in CSS pixels; `area` is the space they share).

export const MIN_W = 340;
export const MIN_H = 240;
// How much of a window stays on screen when it is dragged aside: its top bar, and this
// much of its width, so it can always be dragged back.
const KEEP_X = 140;
const HEAD = 44;
const CASCADE = 32;
const MARGIN = 16;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** A window kept reachable in `area`: no smaller than the minimum, its top bar inside, part of it on screen. */
export function clampRect(rect, area) {
  const w = Math.round(clamp(rect.w, Math.min(MIN_W, area.w), area.w));
  const h = Math.round(clamp(rect.h, Math.min(MIN_H, area.h), area.h));
  const keep = Math.min(KEEP_X, w);
  return {
    x: Math.round(clamp(rect.x, area.x - w + keep, area.x + area.w - keep)),
    y: Math.round(clamp(rect.y, area.y, area.y + area.h - HEAD)),
    w,
    h,
  };
}

/**
 * A new window's place: where it was asked for (`at`, e.g. the item it pops out of), else a
 * step down and right from the last window, else at the right of the area. `size` is the
 * window's preferred size.
 */
export function nextRect(windows, area, { w, h }, at = null) {
  const size = { w: Math.min(w, area.w - 2 * MARGIN), h: Math.min(h, area.h - 2 * MARGIN) };
  if (at) return clampRect({ ...size, ...at }, area);
  const last = windows.filter((win) => !win.min).at(-1);
  if (!last) return clampRect({ ...size, x: area.x + area.w - size.w - MARGIN, y: area.y + MARGIN }, area);
  let x = last.x + CASCADE;
  let y = last.y + CASCADE;
  // Past the edge: start again at the top, a step further left.
  if (x + size.w > area.x + area.w || y + size.h > area.y + area.h) {
    x = Math.max(area.x + MARGIN, last.x - CASCADE * 3);
    y = area.y + MARGIN;
  }
  return clampRect({ ...size, x, y }, area);
}

/** `n` windows side by side: as many columns as fit (each at least the minimum width), then rows. */
export function tileRects(n, area, gap = 12) {
  if (n <= 0) return [];
  const fit = Math.max(1, Math.floor((area.w - gap) / (MIN_W + gap)));
  const cols = Math.min(n, fit);
  const rows = Math.ceil(n / cols);
  const w = (area.w - gap * (cols + 1)) / cols;
  const h = Math.max(MIN_H, (area.h - gap * (rows + 1)) / rows);
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round(area.x + gap + (i % cols) * (w + gap)),
    y: Math.round(area.y + gap + Math.floor(i / cols) * (h + gap)),
    w: Math.round(w),
    h: Math.round(h),
  }));
}

/** The whole area, less a margin: a maximized window. */
export const fullRect = (area, gap = 12) => ({ x: area.x + gap, y: area.y + gap, w: area.w - 2 * gap, h: area.h - 2 * gap });
