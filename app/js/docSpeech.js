// Copied from Tracker Editor (github.com/divaor/tracker-editor, app/js/docSpeech.js); keep the two in step.
// Reading a document aloud (ui/documentView.js): the text of its blocks (paragraphs, headings,
// list items, table cells; a PDF's pages) joined into one text the reader (reader.js) splits
// into passages, and which block each passage is in, to show it and follow it. Pure.

/** Kinds the reader reads: not spreadsheets (cells one by one read badly). */
export const readsAloud = (kind) => Boolean(kind) && kind !== 'xlsx' && kind !== 'ods';

/**
 * A block's text as it is read: runs of spaces become one, a line break stays (two or more
 * become a blank line), the ends are trimmed. `map[i]` is where the i-th character came from
 * in `raw`, so a passage can be found again in the page.
 */
export function tidyBlock(raw) {
  const s = String(raw ?? '');
  let text = '';
  const map = [];
  for (let i = 0; i < s.length; ) {
    if (!/\s/.test(s[i])) {
      text += s[i];
      map.push(i++);
      continue;
    }
    let j = i;
    let breaks = 0;
    for (; j < s.length && /\s/.test(s[j]); j++) if (s[j] === '\n') breaks++;
    if (text && j < s.length) {
      for (const c of breaks >= 2 ? '\n\n' : breaks ? '\n' : ' ') {
        text += c;
        map.push(i);
      }
    }
    i = j;
  }
  return { text, map };
}

/**
 * { text, starts, ends, maps }: the blocks' texts (tidied by tidyBlock; a blank line inside one,
 * as between a PDF page's paragraphs, kept), a blank line apart; block i is
 * text.slice(starts[i], ends[i]), and maps[i] its tidyBlock map.
 */
export function joinBlocks(texts) {
  let text = '';
  const starts = [];
  const ends = [];
  const maps = [];
  for (const raw of texts) {
    const { text: t, map } = tidyBlock(raw);
    if (t && text) text += '\n\n';
    // An empty block starts where the next one will (it is never read).
    starts.push(t || !text ? text.length : text.length + 2);
    text += t;
    ends.push(t ? text.length : starts.at(-1));
    maps.push(map);
  }
  return { text, starts, ends, maps };
}

/**
 * Where a passage ({ from, to } in joinBlocks' text) is in its block's own text:
 * { block, from, to } with from/to in the block's raw text, or null when it reads nothing there.
 */
export function passageInBlock(joined, passage) {
  const block = blockAt(joined.starts, passage.from);
  const start = joined.starts[block];
  const a = Math.max(0, passage.from - start);
  let b = Math.min(passage.to, joined.ends[block]) - start;
  while (b > a && /\s/.test(joined.text[start + b - 1])) b--; // not the space after a sentence
  const map = joined.maps?.[block];
  if (!map || b <= a || a >= map.length) return null;
  return { block, from: map[a], to: map[Math.min(b, map.length) - 1] + 1 };
}

/** The block that `offset` (in joinBlocks' text) is in. */
export function blockAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

/** The first block that reaches below `top`, from the blocks' bottoms (pixels, in page order). */
export function firstBelow(bottoms, top) {
  const i = bottoms.findIndex((b) => b > top + 1);
  return i === -1 ? 0 : i;
}

/**
 * A PDF page's text (pdf.js's lines) as it reads: the lines of a paragraph joined, a word broken
 * at a line's end mended, a page number alone on its line left out, and a new paragraph after a
 * line that ends a sentence, or a short one (a heading, a paragraph's last line) before a capital.
 */
export function pdfSpeechText(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\d{1,4}$/.test(l));
  const short = 0.6 * Math.max(0, ...lines.map((l) => l.length));
  let out = '';
  let last = '';
  for (const line of lines) {
    if (!out) out = line;
    else if (/[a-zà-ÿ]-$/.test(out) && /^[a-zà-ÿ]/.test(line)) out = out.slice(0, -1) + line;
    else if (/[.!?:;"”»)]$/.test(out) || (last.length < short && !/[,-]$/.test(last) && /^[A-ZÀ-Þ0-9¿¡"“«]/.test(line))) out += `\n\n${line}`;
    else out += ` ${line}`;
    last = line;
  }
  return out;
}
