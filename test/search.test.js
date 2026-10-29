import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCommentPatch, CLAUDE_AUTHOR, findWords, foldSearch, matchesQuery, matchRanges, matchSnippet, normalizeItem, queryTerms, searchWordsOf } from '../app/js/model.js';

const item = (fields) => normalizeItem({ id: 'mvt1', title: 'Untitled', ...fields });

test('search ignores case and accents', () => {
  assert.equal(foldSearch('Canción MIGRACIÓN\tÑandú'), 'cancion migracion nandu');
  const it = item({ title: 'Deploy', notes: 'La canción del verano' });
  assert.ok(matchesQuery(it, 'cancion'));
  assert.ok(matchesQuery(it, 'CANCIÓN deploy'));
  assert.ok(matchesQuery(item({ title: 'cancion' }), 'canción'), 'either side may have the accent');
  assert.ok(!matchesQuery(it, 'cantar'));
});

test('a search: words, "phrases", #tags and +projects', () => {
  assert.deepEqual(queryTerms('Foo "the  Server" #Back +Tracker App'), { words: ['foo', 'the server', 'app'], tags: ['back'], projects: ['tracker'] });
  assert.deepEqual(queryTerms('"open phrase'), { words: ['open phrase'], tags: [], projects: [] }, 'a phrase still being typed');
  assert.deepEqual(queryTerms('# +'), { words: ['#', '+'], tags: [], projects: [] });
  const it = item({ title: 'Ship', notes: 'goes to the server', tags: ['backend'], project: 'Tracker App' });
  assert.ok(matchesQuery(it, '"to the server"'));
  assert.ok(!matchesQuery(it, '"server the"'));
  assert.ok(matchesQuery(it, 'server #back +tracker'));
  assert.ok(!matchesQuery(it, 'server #front'));
  assert.ok(matchesQuery(it, 'server #front', { tags: false }), 'pinned items past #tags');
  assert.ok(!matchesQuery(it, 'server +home'));
  assert.equal(searchWordsOf('#back "the server" +tr foo'), '"the server" foo');
  assert.deepEqual(findWords('#back "The Server" foo'), ['#back', 'the server', 'foo']);
});

test('a phrase never runs from one field into the next', () => {
  const it = item({ title: 'Alpha', notes: 'beta' });
  assert.ok(matchesQuery(it, 'alpha beta'));
  assert.ok(!matchesQuery(it, '"alpha beta"'));
});

test('comments, file names, tags and the id are searched', () => {
  let it = item({ title: 'Plan', tags: ['ops'], files: [{ path: 'f/report.md', name: 'report.md' }] });
  it = normalizeItem({ ...it, ...addCommentPatch(it, 'Rolled back', CLAUDE_AUTHOR) });
  for (const q of ['rolled', 'report', 'ops', 'mvt1']) assert.ok(matchesQuery(it, q), q);
});

test('where the words are, in the text as written', () => {
  const text = 'Then the **canción** goes; CANCION again';
  assert.deepEqual(matchRanges(text, ['cancion']), [[11, 18], [27, 34]]);
  assert.equal(text.slice(11, 18), 'canción');
  assert.deepEqual(matchRanges('abcabc', ['abc', 'bca']), [[0, 6]], 'overlaps join');
  assert.deepEqual(matchRanges('anything', []), []);
  // Characters that fold to fewer or more keep their place.
  assert.deepEqual(matchRanges('İstanbul', ['istanbul']), [[0, 8]]);
});

test('a result shows the passage that matched, unless the title holds every word', () => {
  const long = `${'word '.repeat(60)}then the **canción** plays ${'after '.repeat(40)}`;
  const it = item({ title: 'Song list', notes: long });
  const s = matchSnippet(it, 'cancion');
  assert.equal(s.where, 'Notes');
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'), s.text);
  assert.ok(!s.text.includes('**'), 'Markdown marks are left out');
  assert.equal(s.text.slice(...s.ranges[0]), 'canción');
  assert.ok(s.text.length < 140);
  assert.equal(matchSnippet(it, 'song'), null, 'in the title');
  assert.equal(matchSnippet(it, ''), null);
  assert.equal(matchSnippet(it, '#tag'), null);
  // The field with more of the words wins.
  let two = item({ title: 'x', notes: 'alpha only', feedback: 'alpha and beta' });
  assert.equal(matchSnippet(two, 'alpha beta').where, 'Feedback');
  two = normalizeItem({ ...two, ...addCommentPatch(two, 'alpha beta here', 'Phone') });
  assert.equal(matchSnippet(two, 'alpha beta').where, 'Comment');
});
