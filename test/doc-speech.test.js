// Copied from Tracker Editor (github.com/divaor/tracker-editor, test/doc-speech.test.js); keep the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockAt, firstBelow, joinBlocks, passageInBlock, pdfSpeechText, readsAloud, tidyBlock } from '../app/js/docSpeech.js';
import { speechPassages } from '../app/js/speech.js';

test('blocks become one text, each passage traced to its block', () => {
  const { text, starts, ends } = joinBlocks(['Chapter 1', '  First   paragraph,\n  over two lines. ', '', 'Second one.', 'Page one.\n\n\n\nPage two.']);
  assert.equal(text, 'Chapter 1\n\nFirst paragraph,\nover two lines.\n\nSecond one.\n\nPage one.\n\nPage two.');
  assert.deepEqual(starts, [0, 11, 45, 45, 58]);
  assert.deepEqual(ends, [9, 43, 45, 56, 78]);
  assert.equal(text.slice(starts[1], ends[1]), 'First paragraph,\nover two lines.');
  assert.equal(blockAt(starts, 0), 0);
  assert.equal(blockAt(starts, 12), 1);
  // An empty block shares its place with the next: the next is the one shown.
  assert.equal(blockAt(starts, 45), 3);
  assert.equal(blockAt(starts, 70), 4);
  assert.equal(blockAt([], 5), 0);
  const passages = speechPassages(text, { lang: 'en' });
  assert.deepEqual(
    passages.map((p) => blockAt(starts, p.from)),
    [0, 1, 3, 4, 4],
  );
  assert.equal(joinBlocks([]).text, '');
});

test('each tidied character points back to where it was', () => {
  const raw = '  Hello,\t  world.\r\n  Next line.\n \n\nAfter a gap. ';
  const { text, map } = tidyBlock(raw);
  assert.equal(text, 'Hello, world.\nNext line.\n\nAfter a gap.');
  assert.equal(map.length, text.length);
  // Letters map to themselves; a collapsed run maps to where it began.
  for (let i = 0; i < text.length; i++) if (/\S/.test(text[i])) assert.equal(raw[map[i]], text[i]);
  assert.equal(map[text.indexOf(' world')], raw.indexOf(',') + 1);
  assert.deepEqual(tidyBlock(' \n '), { text: '', map: [] });
});

test('a passage is found again in its block', () => {
  const texts = ['Title', '  The first sentence is long enough to stand alone.   The second   one follows it, also long. ', '', 'Last.'];
  const joined = joinBlocks(texts);
  const passages = speechPassages(joined.text, { maxPassage: 60 });
  const found = passages.map((p) => passageInBlock(joined, p)).map((r) => r && { block: r.block, text: texts[r.block].slice(r.from, r.to) });
  assert.deepEqual(found, [
    { block: 0, text: 'Title' },
    { block: 1, text: 'The first sentence is long enough to stand alone.' },
    { block: 1, text: 'The second   one follows it, also long.' },
    { block: 3, text: 'Last.' },
  ]);
  assert.equal(passageInBlock({ ...joined, maps: null }, passages[0]), null);
});

test('the first block below the top of the screen', () => {
  assert.equal(firstBelow([100, 200, 300], 0), 0);
  assert.equal(firstBelow([100, 200, 300], 150), 1);
  assert.equal(firstBelow([100, 200, 300], 200), 2);
  assert.equal(firstBelow([100, 200, 300], 999), 0);
});

test('a PDF page reads as paragraphs', () => {
  const page = 'Report\nThis line goes on\nto the next one, and a word is bro-\nken here.\nNext paragraph starts\n12\n';
  assert.equal(pdfSpeechText(page), 'Report\n\nThis line goes on to the next one, and a word is broken here.\n\nNext paragraph starts');
  // A short line before a capital ends its paragraph; one ending in a comma does not.
  const wide = 'A line that is about as wide as the column of the page is\nwide, then a short one,\nAnd more text that keeps going along the whole width here\nEnd here\nNew paragraph';
  assert.equal(pdfSpeechText(wide), 'A line that is about as wide as the column of the page is wide, then a short one, And more text that keeps going along the whole width here End here\n\nNew paragraph');
  assert.equal(pdfSpeechText('Año: 2026\n\nFin.'), 'Año: 2026 Fin.');
  assert.equal(pdfSpeechText(''), '');
});

test('which documents are read aloud', () => {
  for (const kind of ['pdf', 'epub', 'fb2', 'docx', 'odt', 'rtf', 'pptx', 'odp']) assert.ok(readsAloud(kind), kind);
  for (const kind of ['xlsx', 'ods', '', undefined]) assert.ok(!readsAloud(kind), String(kind));
});
