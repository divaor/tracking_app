// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/ui/readAlong.js); keep the two in step.
// Reading a page aloud as it is shown (a converted document, a PDF's pages, a Markdown preview):
// the text of its blocks from the one at the top of the screen (or those a selection touches);
// while it is read, the block gets `doc-reading`, the sentence in it the `reading` highlight
// (CSS Custom Highlight API: nothing in the page changes), and both are kept in view.
import { blockAt, firstBelow, joinBlocks, passageInBlock } from '../docSpeech.js';
import { codeSkippedWords, detectLanguage } from '../speech.js';

// The blocks read one after another; text outside them goes with the nearest block around it.
export const READ_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, dt, dd, pre, blockquote, figcaption, caption, td, th';
const KINDS = { H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', LI: 'item', DT: 'item', DD: 'item', TD: 'row', TH: 'row', PRE: 'code' };

/**
 * { elements, texts, segments, skipped }: each block with text in `root`, in order, its own text
 * (not its inner blocks') and where each of its text nodes starts in that text. Text inside
 * `notRead` is left out; blocks matching `skip` (code) are listed in `skipped`, their text not read.
 */
export function readingBlocks(root, { notRead = '', skip = '' } = {}) {
  const elements = [];
  const texts = new Map();
  const segments = new Map();
  const skipped = new Set();
  if (!root) return { elements, texts: [], segments: [], skipped };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const blockOf = (el) => (skip && el.closest(skip)) || el.closest(READ_BLOCKS) || el.closest('div, section, article') || root;
  const add = (block, text, node) => {
    if (!texts.has(block)) {
      texts.set(block, '');
      segments.set(block, []);
      elements.push(block);
    }
    if (node) segments.get(block).push({ node, at: texts.get(block).length, len: text.length });
    texts.set(block, texts.get(block) + text);
  };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Lines broken inside a block still part their words.
      if (node.tagName === 'BR' && texts.has(blockOf(node))) add(blockOf(node), ' ');
      continue;
    }
    const parent = node.parentElement;
    if (!parent || !node.nodeValue.trim() || (notRead && parent.closest(notRead))) continue;
    const block = blockOf(parent);
    if (skip && block.matches(skip)) skipped.add(block);
    add(block, node.nodeValue, node);
  }
  return { elements, texts: elements.map((e) => texts.get(e)), segments: elements.map((e) => segments.get(e)), skipped };
}

/** [first, last]: the blocks a selection inside `root` starts and ends in, or null. */
export function selectedBlocks(elements, root) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !root?.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const index = new Map(elements.map((e, i) => [e, i]));
  const of = (node) => {
    for (let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
      if (index.has(el)) return index.get(el);
    }
    return -1;
  };
  const a = of(sel.anchorNode);
  const b = of(sel.focusNode);
  if (a < 0 || b < 0) return null;
  return [Math.min(a, b), Math.max(a, b)];
}

/** Scrolls `scroller` so `rect` (a block, or the sentence) is in view, a quarter down, unless it already is. */
export function keepInView(scroller, rect) {
  if (!scroller || !rect) return;
  const box = scroller.getBoundingClientRect();
  if (rect.top >= box.top && rect.bottom <= box.bottom) return;
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  scroller.scrollTo({ top: scroller.scrollTop + rect.top - box.top - scroller.clientHeight / 4, behavior: smooth ? 'smooth' : 'auto' });
}

/** What a page shown in `scroller` reads: its blocks under `root`, from the top of the screen or the selection. */
export function pageSource(root, scroller, options = {}) {
  const { elements, texts, segments, skipped } = readingBlocks(root, options);
  if (!scroller || !elements.length) return null;
  if (skipped.size) {
    // Code is announced, not read: in the language of the rest.
    const say = codeSkippedWords(detectLanguage(texts.filter((_, i) => !skipped.has(elements[i])).join('\n')));
    elements.forEach((e, i) => {
      if (!skipped.has(e)) return;
      texts[i] = say;
      segments[i] = null;
    });
  }
  const touched = selectedBlocks(elements, root);
  const top = scroller.getBoundingClientRect().top;
  return {
    elements,
    texts,
    segments,
    first: touched ? touched[0] : firstBelow(elements.map((e) => e.getBoundingClientRect().bottom - top), 0),
    last: touched?.[1],
    follow: (el, range) => keepInView(scroller, range?.getClientRects().length ? range.getBoundingClientRect() : el.getBoundingClientRect()),
  };
}

const marks = () => (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null);

// A DOM range over raw offsets [from, to) of a block whose text nodes are `segments`.
function rangeIn(segments, from, to) {
  const start = segments?.find((s) => from < s.at + s.len);
  const end = segments?.findLast((s) => to > s.at);
  if (!start || !end || !start.node.isConnected || !end.node.isConnected) return null;
  const range = document.createRange();
  range.setStart(start.node, Math.max(0, Math.min(start.len, from - start.at)));
  range.setEnd(end.node, Math.max(0, Math.min(end.len, to - end.at)));
  return range.collapsed ? null : range;
}

/**
 * The reader's arguments for a source ({ elements, texts, segments?, first, last, follow(el, range) }):
 * { text, from, to, kindOf, onPassage }. Without segments (a PDF's pages) only the block is shown.
 */
export function readAlong(source) {
  const joined = joinBlocks(source.texts);
  let shown = null;
  const onPassage = (_key, passage) => {
    const block = passage ? blockAt(joined.starts, passage.from) : -1;
    const el = source.elements[block] ?? null;
    if (el !== shown) {
      shown?.classList.remove('doc-reading');
      shown = el;
      el?.classList.add('doc-reading');
    }
    const found = passage && source.segments?.[block] ? passageInBlock(joined, passage) : null;
    const range = found ? rangeIn(source.segments[found.block], found.from, found.to) : null;
    if (range) marks()?.set('reading', new Highlight(range));
    else marks()?.delete('reading');
    if (el) source.follow(el, range);
  };
  const kindOf = (passage) => KINDS[source.elements[blockAt(joined.starts, passage.from)]?.tagName];
  return {
    text: joined.text,
    from: joined.starts[source.first] ?? 0,
    to: source.last != null ? (joined.ends[source.last] ?? joined.text.length) : 0,
    kindOf,
    onPassage,
  };
}
