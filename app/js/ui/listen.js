// Listening (as in Tracker Editor's read aloud): what a view shows is read as it is shown
// (ui/readAlong.js), the block being read and its sentence marked and followed. An open item
// reads its title, notes, the document open in it and the comments; a plan or review, its text;
// a document's reader, the document. One reading at a time (reader.js); it stops when its view goes.
import { html, useEffect } from '../../vendor/preact-htm.js';
import { getReaderState, onReaderState, startReading, stopReading, toggleReading } from '../reader.js';
import { Icon } from './icons.js';
import { pageSource, readAlong } from './readAlong.js';
import { ReadAloudBar, useReader } from './readAloud.js';

// What an open item does not read: its bar, controls and labels, fields and buttons, the file
// list and toolbars, the review form, the model's panel, the comments' times and box, the dates.
export const ITEM_NOT_READ = [
  '.modal-head', '.item-controls', '.item-labels', '.item-id', '.find-bar', '.props', '.open-doc', '.no-notes',
  '.files-head', '.file-pictures', '.file-list', '.file-toolbar', '.file-message', '.review-panel',
  '.comment-head .muted', '.comments-n', '.comment-new', '.comment-foot', '.item-assist', '.timestamps', '.drop-files-hint',
  'button', 'input', 'textarea', 'select', 'label', 'iframe', '.sr-only',
].join(', ');
// Code is announced, not read; a plain text file shown as it is (`.file-source`) is read.
const CODE = 'pre:not(.file-source)';

let notice = () => {};
/** `fn(message)` tells the person why reading could not start (the app's toast). */
export const setListenNotice = (fn) => (notice = fn);

/** The element `el` scrolls in (the page's own scroller when nothing nearer does). */
export function scrollerOf(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

/**
 * The reading of `root` (shown in `scroller`): from the top of the screen, or the selection; from
 * the start with `fromStart`, or when `scroller` is at its top (then what is above it, a title, too).
 */
export function sourceOf(root, { scroller = scrollerOf(root), notRead = '', fromStart = false } = {}) {
  const source = pageSource(root, scroller, { notRead, skip: CODE });
  if (source && source.last == null && (fromStart || scroller.scrollTop < 8)) source.first = 0;
  return source;
}

/** Reads `source()` aloud as `readKey` (`name` on the player); again on the same key pauses or goes on. */
export function listen(readKey, name, source) {
  const now = getReaderState();
  if (now.status !== 'idle' && now.key === readKey) return toggleReading();
  try {
    const found = source();
    if (!found) throw new Error('There is nothing to read here.');
    startReading({ key: readKey, name, ...readAlong(found) });
  } catch (err) {
    notice(err.message);
  }
}

/** Whether `readKey` is being read (playing or paused). */
export const readingKey = (reader, readKey) => reader.status !== 'idle' && reader.key === readKey;

/** Stops reading `readKey` when the view showing it goes (what it marks is gone). */
export function useStopReading(readKey) {
  useEffect(() => () => getReaderState().key === readKey && stopReading(), [readKey]);
}

/**
 * Listen / Pause / Resume for `readKey`. `source()` gives what to read (sourceOf); `label`
 * shows the word next to the icon; `title` explains it; `before()` runs first (shows it all).
 */
export function ListenButton({ readKey, name, source, label = true, className = 'btn ghost sm', title = 'Listen', size = 15, before = null }) {
  const reader = useReader();
  useStopReading(readKey);
  const mine = readingKey(reader, readKey);
  const playing = mine && reader.status === 'playing';
  const word = mine ? (playing ? 'Pause' : 'Resume') : 'Listen';
  return html`<button type="button" class="${className} listen-btn ${mine ? 'on' : ''}" aria-pressed=${playing} aria-label=${word}
    title=${mine ? (playing ? 'Pause reading' : 'Go on reading') : title} onClick=${() => (before?.(), listen(readKey, name, source))}>
    <${Icon} name=${playing ? 'pause' : 'volume'} size=${size} />${label && html`<span class="label">${word}</span>`}
  </button>`;
}

/**
 * The player while something is read (readAloud.js's bar: back, play/pause, forward, speed, voice,
 * stop), over everything at the bottom of the window; `reading-aloud` on the root makes room for it.
 */
export function ListenBar() {
  const reader = useReader();
  const on = reader.status !== 'idle';
  useEffect(() => {
    document.documentElement.classList.toggle('reading-aloud', on);
  }, [on]);
  // Why a reading stopped (no voice, the speech server not reachable…).
  useEffect(() => onReaderState((s) => s.status === 'idle' && s.error && notice(s.error)), []);
  return on ? html`<div class="listen-bar"><${ReadAloudBar} /></div>` : null;
}
