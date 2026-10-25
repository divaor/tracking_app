import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRect, fullRect, MIN_H, MIN_W, nextRect, tileRects } from '../app/js/windowLayout.js';

const area = { x: 252, y: 66, w: 1188, h: 780 };
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('a window stays reachable: its bar inside, part of it on screen, not too small', () => {
  const screen = { x: 0, y: 0, w: 1440, h: 900 };
  assert.deepEqual(clampRect({ x: 100, y: 100, w: 500, h: 400 }, screen), { x: 100, y: 100, w: 500, h: 400 });
  // Dragged aside: most of it may go past an edge, never all of it, and never above the top.
  const aside = clampRect({ x: 1400, y: -50, w: 500, h: 400 }, screen);
  assert.equal(aside.y, 0);
  assert.ok(aside.x <= 1440 - 140, 'a strip stays on screen');
  assert.ok(clampRect({ x: -900, y: 100, w: 500, h: 400 }, screen).x >= -500 + 140);
  // Its bar never under the bottom edge.
  assert.ok(clampRect({ x: 10, y: 2000, w: 500, h: 400 }, screen).y <= 900 - 44);
  const tiny = clampRect({ x: 10, y: 10, w: 50, h: 20 }, screen);
  assert.deepEqual([tiny.w, tiny.h], [MIN_W, MIN_H]);
  // Larger than the screen: as large as the screen.
  const huge = clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, screen);
  assert.deepEqual([huge.w, huge.h], [1440, 900]);
});

test('new windows: at the right first, then a step down and right, starting over past the edge', () => {
  const first = nextRect([], area, { w: 580, h: 700 });
  assert.equal(first.x + first.w, area.x + area.w - 16);
  assert.equal(first.y, area.y + 16);
  const wins = [{ ...first, min: false }];
  const second = nextRect(wins, area, { w: 580, h: 700 });
  // Past the right edge: back to the top, further left.
  assert.ok(second.x < first.x && second.y === area.y + 16, JSON.stringify(second));
  const third = nextRect([{ x: 400, y: 80, w: 580, h: 600, min: false }], area, { w: 580, h: 600 });
  assert.deepEqual([third.x, third.y], [432, 112]);
  // Minimized windows do not count.
  assert.deepEqual(nextRect([{ x: 400, y: 80, w: 580, h: 600, min: true }], area, { w: 580, h: 700 }), first);
  // Asked for a place: that place (kept reachable), at the preferred size.
  assert.deepEqual(nextRect([], area, { w: 580, h: 700 }, { x: 300, y: 100 }), { x: 300, y: 100, w: 580, h: 700 });
  // A small area: the window fits it.
  const small = nextRect([], { x: 0, y: 0, w: 500, h: 400 }, { w: 760, h: 700 });
  assert.ok(small.w <= 500 && small.h <= 400);
});

test('side by side: as many columns as fit, then rows, none covering another', () => {
  for (const n of [1, 2, 3, 4, 5, 7]) {
    const rects = tileRects(n, area);
    assert.equal(rects.length, n);
    for (const r of rects) {
      assert.ok(r.w >= MIN_W - 1 && r.x >= area.x && r.x + r.w <= area.x + area.w + 1, `${n}: ${JSON.stringify(r)}`);
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(!overlaps(rects[i], rects[j]), `${n}: ${i} and ${j} overlap`);
  }
  // Two: halves of the width, the whole height.
  const [a, b] = tileRects(2, area, 12);
  assert.equal(a.y, b.y);
  assert.ok(Math.abs(a.w - b.w) <= 1 && a.h === area.h - 24);
  // Four in 1188px: three columns of at least the minimum, then a second row.
  const four = tileRects(4, area);
  assert.equal(new Set(four.map((r) => r.y)).size, 2);
  assert.deepEqual(tileRects(0, area), []);
});

test('maximized: the whole area less a margin', () => {
  assert.deepEqual(fullRect(area), { x: 264, y: 78, w: 1164, h: 756 });
});
