import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { findWords, matchRanges } from '../model.js';
import { Icon } from './icons.js';

// Finding words in an open item: the matches are marked with the CSS Custom Highlight API
// (`::highlight(item-find)` and `::highlight(item-find-current)` in styles.css), so the
// item's content is not changed. Every open item (the dialog, the windows) keeps its own
// matches here, and they are painted together.
const panels = new Map(); // a FindBar's key → { all: Range[], current: Range | null }
const canHighlight = () => typeof CSS !== 'undefined' && Boolean(CSS.highlights) && typeof Highlight === 'function';

function paint() {
  if (!canHighlight()) return;
  const all = [];
  const current = [];
  for (const panel of panels.values()) {
    all.push(...panel.all);
    if (panel.current) current.push(panel.current);
  }
  if (all.length) CSS.highlights.set('item-find', new Highlight(...all));
  else CSS.highlights.delete('item-find');
  if (current.length) CSS.highlights.set('item-find-current', new Highlight(...current));
  else CSS.highlights.delete('item-find-current');
}

// Text in fields, buttons and the find bar itself is not searched; nor is text that does not show.
const SKIP = 'textarea, input, select, button, script, style, .find-bar';
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dd, dt, header, section, article, div';

/** The ranges of `words` (folded, `findWords`) in the text shown inside `root`, in reading order. */
export function findRanges(root, words) {
  if (!root || !words.length) return [];
  const nodes = [];
  let joined = '';
  let lastBlock = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      !node.data.trim() || node.parentElement?.closest(SKIP) || !node.parentElement?.getClientRects().length ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Text from two paragraphs never makes one match.
    const block = node.parentElement.closest(BLOCK);
    if (lastBlock && block !== lastBlock) joined += '\u0001';
    lastBlock = block;
    nodes.push({ node, at: joined.length });
    joined += node.data;
  }
  const place = (offset, isEnd) => {
    let i = nodes.length - 1;
    while (i > 0 && (isEnd ? nodes[i].at >= offset : nodes[i].at > offset)) i--;
    const { node, at } = nodes[i];
    return [node, Math.min(node.data.length, offset - at)];
  };
  return matchRanges(joined, words).map(([from, to]) => {
    const range = document.createRange();
    range.setStart(...place(from, false));
    range.setEnd(...place(to, true));
    return range;
  });
}

// The match in the middle of the item's content (and of a box that scrolls inside it, like a long code block).
function reveal(range, scroller) {
  range.startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  if (r.top < box.top + 8 || r.bottom > box.bottom - 8) scroller.scrollTop += r.top - box.top - box.height / 3;
}

/**
 * The find bar of an open item: what is typed is found in its content (notes, the file shown,
 * comments…), each word apart or "a phrase" in quotes, ignoring case and accents. Enter goes to
 * the next match, Shift+Enter to the one before, Escape closes the bar.
 */
export function FindBar({ bodyRef, value, onInput, onClose, inputRef, focus = true }) {
  const key = useRef(Symbol('find')).current;
  const ranges = useRef([]);
  const [state, setState] = useState({ count: 0, index: -1 });
  const indexRef = useRef(-1);

  const show = (index, scroll = true) => {
    const list = ranges.current;
    const at = list.length ? ((index % list.length) + list.length) % list.length : -1;
    indexRef.current = at;
    panels.set(key, { all: list, current: list[at] ?? null });
    paint();
    if (scroll && list[at]) reveal(list[at], bodyRef.current);
    setState({ count: list.length, index: at });
  };
  // Found again: when the words change (from the first match), and when the content does
  // (a file loaded, a comment added: the place is kept).
  const search = (keepPlace) => {
    ranges.current = findRanges(bodyRef.current, findWords(value));
    show(keepPlace ? Math.max(0, Math.min(indexRef.current, ranges.current.length - 1)) : 0, !keepPlace);
  };
  useEffect(() => search(false), [value]);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return undefined;
    let timer = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      // With no match yet (the file still loading), the first one that comes is shown.
      timer = setTimeout(() => search(indexRef.current >= 0), 150);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [value, bodyRef.current]);
  useEffect(
    () => () => {
      panels.delete(key);
      paint();
    },
    [],
  );
  useLayoutEffect(() => {
    if (!focus) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const step = (by) => state.count && show(indexRef.current + by);
  const onKeyDown = (e) => {
    // The bar's keys stay here: Escape closes the bar, not the item.
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'F3') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.currentTarget.select();
    }
  };
  const words = findWords(value).length > 0;
  return html`<div class="find-bar" role="search">
    <${Icon} name="search" size=${15} />
    <input ref=${inputRef} value=${value} onInput=${(e) => onInput(e.currentTarget.value)} onKeyDown=${onKeyDown}
      placeholder="Find in this item" aria-label="Find in this item" spellcheck="false" autocomplete="off" />
    <span class="find-count ${words && !state.count ? 'none' : ''}" aria-live="polite">${words ? (state.count ? `${state.index + 1} of ${state.count}` : 'No matches') : ''}</span>
    <button type="button" class="icon-btn sm" aria-label="Previous match" title="Previous (Shift+Enter)" disabled=${state.count < 2} onClick=${() => step(-1)}><${Icon} name="chevronUp" size=${16} /></button>
    <button type="button" class="icon-btn sm" aria-label="Next match" title="Next (Enter)" disabled=${state.count < 2} onClick=${() => step(1)}><${Icon} name="chevronDown" size=${16} /></button>
    <button type="button" class="icon-btn sm" aria-label="Close find" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${15} /></button>
  </div>`;
}
