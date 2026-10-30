// Copied from Tracker Editor (github.com/divaor/tracker-editor, test/speech.test.js); keep the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeVoice, detectLanguage, isNaturalVoice, kokoroVoice, naturalize, passageAt, PAUSES, rankVoices, serverVoiceFor, speakableMarkdown, speechPassages } from '../app/js/speech.js';

test('turns Markdown into words to say', () => {
  assert.equal(speakableMarkdown('## The **setup** today ##'), 'The setup today');
  assert.equal(speakableMarkdown('- [x] Read the [guide](https://example.com/guide) first'), 'Read the guide first');
  assert.equal(speakableMarkdown('1. Run `npm test`, then _ship_ it'), 'Run npm test, then ship it');
  assert.equal(speakableMarkdown('| #7 | OOR\\_JSD | dba\\_agent\\_ro |'), '#7, OOR_JSD, dba_agent_ro');
  assert.equal(speakableMarkdown('> See https://github.com/divaor/tracking_app for more'), 'See link for more');
  assert.equal(speakableMarkdown('![Board view](docs/board.png)'), 'Board view');
});

test('splits a Markdown file into passages that point back into the text', () => {
  const text = [
    '# Database override guide',
    '',
    'A report can pick, per request, which database it reads.',
    'It falls back to the default.',
    '',
    '```sql',
    'select * from [OOR].[dbo].[kbn_dim_assign_lines]',
    '```',
    '',
    '| Connection | Database |',
    '|---|---|',
    '| #7 | OOR |',
    '',
    '- first step',
    '- [ ] second step',
    '',
    '---',
  ].join('\n');
  const passages = speechPassages(text, { markdown: true });
  assert.deepEqual(
    passages.map((p) => [p.kind, p.text]),
    [
      ['heading', 'Database override guide.'],
      ['paragraph', 'A report can pick, per request, which database it reads. It falls back to the default.'],
      ['code', 'Code block skipped.'],
      ['row', 'Connection, Database.'],
      ['row', 'number 7, OOR.'],
      ['item', 'first step.'],
      ['item', 'second step.'],
    ],
  );
  for (const p of passages) assert.ok(p.to > p.from && p.from >= 0 && p.to <= text.length);
  assert.equal(text.slice(passages[0].from, passages[0].to), '# Database override guide');
  assert.ok(text.slice(passages[2].from, passages[2].to).startsWith('```sql') && text.slice(passages[2].from, passages[2].to).endsWith('```'));
});

test('pauses like a reader: longer after headings and paragraphs, and before a new section', () => {
  const text = '# Plan\n\nFirst we build the whole thing on the work PC. Then we ship it to everyone who asked, which takes a while because there are many servers and every one of them needs a restart.\n\n## Rollout\n\n- Monday\n- Tuesday\n';
  const passages = speechPassages(text, { markdown: true, maxPassage: 60 });
  assert.deepEqual(passages.map((p) => [p.kind, p.pause]), [
    ['heading', PAUSES.heading],
    ['sentence', PAUSES.sentence],
    ['paragraph', PAUSES.heading],
    ['heading', PAUSES.heading],
    ['item', PAUSES.item],
    ['item', PAUSES.item],
  ]);
});

test('says dates, abbreviations and symbols the way a person would', () => {
  assert.equal(naturalize('Decided 2026-10-21 (below) — phases 0, 1 and 2 built.'), 'Decided October 21, 2026, below, phases 0, 1 and 2 built.');
  assert.equal(naturalize('Use tools, e.g. the broker / the toolkit, etc.'), 'Use tools, for example, the broker, the toolkit, et cetera.');
  assert.equal(naturalize('R&D vs. ops & support → done 🎉'), 'R&D versus ops and support, done');
  assert.equal(naturalize('Ticket #23 needs v2.1 of dba_agent_ro'), 'Ticket number 23 needs version 2.1 of dba agent ro');
  assert.equal(naturalize('Entrega el 2026-03-05, p. ej. mañana', 'es'), 'Entrega el 5 de marzo de 2026, por ejemplo, mañana');
  assert.equal(naturalize('Entrega em 2026-03-05 & depois', 'pt'), 'Entrega em 5 de março de 2026 e depois');
  assert.equal(naturalize('Rendez-vous 2026-03-05 & après', 'fr'), 'Rendez-vous 2026-03-05 & après', 'no word list for French');
  assert.equal(naturalize('10-20 users, -5 degrees, a-b test'), '10-20 users, -5 degrees, a-b test', 'hyphens without spaces stay');
});

test('picks natural-sounding voices for the language first', () => {
  const voices = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true, default: true },
    { name: 'Google US English', lang: 'en-US', localService: false },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', localService: false },
    { name: 'Microsoft Elvira Online (Natural) - Spanish (Spain)', lang: 'es-ES', localService: false },
    { name: 'Google español', lang: 'es-ES', localService: false },
  ];
  assert.ok(isNaturalVoice(voices[2]) && !isNaturalVoice(voices[0]));
  assert.deepEqual(rankVoices(voices, 'en').slice(0, 3).map((v) => v.name.split(' ')[1]), ['Aria', 'US', 'David']);
  assert.equal(rankVoices(voices, 'es')[0].name, 'Microsoft Elvira Online (Natural) - Spanish (Spain)');
});

test('long paragraphs are read sentence by sentence', () => {
  const sentence = (i) => `Sentence number ${i} explains one more detail of the plan in plain words.`;
  const text = Array.from({ length: 8 }, (_, i) => sentence(i + 1)).join(' ');
  const passages = speechPassages(text);
  assert.ok(passages.length >= 3, `${passages.length} passages`);
  assert.equal(passages.map((p) => p.text).join(' '), text);
  assert.deepEqual([...new Set(passages.map((p) => p.kind))], ['sentence', 'paragraph']);
  assert.ok(speechPassages(text, { maxPassage: 1000 }).length === 1, 'a speech server reads whole paragraphs');
  assert.ok(passages.every((p) => p.to - p.from <= 320));
  const unpunctuated = 'word '.repeat(400);
  assert.ok(speechPassages(unpunctuated).every((p) => p.to - p.from <= 320));
});

test('plain text keeps its symbols, but not URLs', () => {
  const passages = speechPassages('# not a heading here\nx = a * b  # see https://example.com\n');
  assert.deepEqual(passages.map((p) => p.text), ['# not a heading here x = a * b # see link']);
});

test('voices told apart: Kokoro and Piper names made readable, accents and genders', () => {
  assert.deepEqual(kokoroVoice('af_heart'), { key: 'af_heart', name: 'Heart', accent: 'American English', gender: 'female' });
  // An engine that lists them by name: the language tells Hindi's Alpha from Japanese's.
  assert.equal(kokoroVoice('Alpha (Kokoro)', 'hi').key, 'hf_alpha');
  assert.equal(kokoroVoice('Alpha (Kokoro)', 'ja').key, 'jf_alpha');
  assert.equal(kokoroVoice('Santa (Kokoro)', 'pt-BR').key, 'pm_santa');
  assert.equal(kokoroVoice('Samantha'), null);
  const d = (v) => describeVoice(v);
  assert.deepEqual(d({ name: 'Heart (Kokoro)', lang: 'en' }), { title: 'Heart', detail: 'American English · female · Kokoro' });
  assert.deepEqual(d({ name: 'George (Kokoro)', lang: 'en' }), { title: 'George', detail: 'British English · male · Kokoro' });
  assert.deepEqual(d({ name: 'es_MX-claude-high', lang: 'es' }), { title: 'Claude', detail: 'Mexican Spanish · Piper, high quality' });
  assert.deepEqual(d({ name: 'en-us-x-tpf-local', lang: 'en-US', localService: true }), { title: 'Voice TPF', detail: 'American English · offline' });
  assert.deepEqual(d({ name: 'en-gb-x-gbd-network', lang: 'en-GB', localService: false }), { title: 'Voice GBD', detail: 'British English · needs internet' });
  assert.deepEqual(d({ name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', localService: false }), { title: 'Microsoft Aria Online (Natural)', detail: 'American English · needs internet' });
  assert.deepEqual(d({ name: 'Samantha', lang: 'en-US', localService: true }), { title: 'Samantha', detail: 'American English' });
  assert.ok(isNaturalVoice({ name: 'Heart (Kokoro)' }), 'Kokoro counts as natural');
});

test('a speech server reads each language with its own voice', () => {
  const server = { voice: 'af_heart', otherVoices: 'es=ef_dora, PT = pf_dora' };
  assert.equal(serverVoiceFor(server, 'en'), 'af_heart');
  assert.equal(serverVoiceFor(server, 'es'), 'ef_dora');
  assert.equal(serverVoiceFor(server, 'pt'), 'pf_dora');
  assert.equal(serverVoiceFor(server, 'fr'), 'af_heart');
  assert.equal(serverVoiceFor({ voice: 'coral' }, 'es'), 'coral');
});

test('starts from the passage at the cursor', () => {
  const passages = [{ from: 0, to: 10 }, { from: 12, to: 30 }, { from: 32, to: 40 }];
  assert.equal(passageAt(passages, 0), 0);
  assert.equal(passageAt(passages, 11), 1);
  assert.equal(passageAt(passages, 35), 2);
  assert.equal(passageAt(passages, 99), 0, 'after the end: from the top');
});

test('guesses the language for picking a voice', () => {
  assert.equal(detectLanguage('This is the plan for the release, and it is not done yet but we have a draft of it.'), 'en');
  assert.equal(detectLanguage('Este es el plan para la entrega y no está listo, pero tenemos un borrador de lo que se hará.'), 'es');
  assert.equal(detectLanguage('Este é o plano para a entrega e não está pronto, mas temos um rascunho do que será feito com os dados.'), 'pt');
  assert.equal(detectLanguage('select * from dbo.table'), '');
});
