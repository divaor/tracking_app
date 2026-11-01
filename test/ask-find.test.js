// Find by asking (askFind.js, the same in Tracker Editor and Tracker): the plan, safe patterns,
// measuring and ranking sources, the pick, the results, and which typed text is a question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  findResults,
  fold,
  looksLikeQuestion,
  measure,
  parseFindPlan,
  parsePick,
  patternProblem,
  pickMessages,
  plainPlan,
  planMessages,
  planWords,
  questionOf,
  questionWords,
  rankMeasured,
  rankSources,
  wantsPick,
} from '../app/js/askFind.js';

const today = '2026-11-01';
const now = '2026-11-01T12:00:00.000Z';
const picture = {
  today,
  projects: ['Deep Time', 'AION gateway', 'Kitchen'],
  tags: ['docker', 'sql', 'Layers'],
  kinds: [
    { id: 'synced', label: 'My files' },
    { id: 'disk', label: 'Files in the folders on this computer' },
    { id: 'item', label: 'Tracker items' },
  ],
  types: [
    { id: 'task', label: 'Tasks' },
    { id: 'idea', label: 'Ideas' },
  ],
  folders: ['tracker-editor', 'notes'],
};

const sources = [
  { id: 'f:1', kind: 'synced', name: 'new 3', place: 'My files', project: '', tags: [], date: '2026-10-30T10:00:00Z', untitled: true, text: 'Deploy notes\n\ndocker compose up -d\ndocker run -p 8080:80 nginx\n' },
  { id: 'f:2', kind: 'synced', name: 'kitchen plan.md', place: 'My files · Kitchen', project: 'Kitchen', tags: [], date: '2026-10-01T10:00:00Z', text: '# Kitchen\n\nFix the leak, call the plumber.\n' },
  { id: 'f:3', kind: 'synced', name: 'gateway.sql', place: 'My files · AION gateway', project: 'AION gateway', tags: ['sql'], date: '2026-10-15T10:00:00Z', text: 'SELECT id, name\nFROM gateways\nWHERE active = 1;\n' },
  { id: 'd:/code/Dockerfile', kind: 'disk', name: 'Dockerfile', place: 'tracker-editor', project: '', tags: [], date: '2026-09-01T10:00:00Z', text: 'FROM node:22\nRUN npm ci\n' },
  { id: 'f:4', kind: 'synced', name: 'passwords.md', place: 'My files', project: '', tags: [], date: '2026-10-20T10:00:00Z', encrypted: true, text: '' },
  { id: 'f:5', kind: 'synced', name: 'café notes', place: 'My files · Deep Time', project: 'Deep Time', tags: ['Layers'], date: '2026-10-25T10:00:00Z', text: 'The coal forest layer: Carboniferous swamps.\nMore about coal forests later.\n' },
  { id: 'i:9', kind: 'item', name: 'Docker cleanup', place: 'Tracker', project: 'Deep Time', tags: ['docker'], type: 'task', status: 'pending', date: '2026-10-28T10:00:00Z', text: 'Docker cleanup\nPrune old images with docker system prune.' },
];

test('the plan: what the model is told', () => {
  const [system, user] = planMessages('the file where I copied a docker command', picture);
  assert.match(system.content, /Reply with ONLY a JSON object/);
  assert.match(system.content, /"intent": "find" \| "list"/);
  assert.match(user.content, /^Question: the file where I copied a docker command\n\n/);
  assert.match(user.content, /Today: Sunday 2026-11-01/);
  assert.match(user.content, /Kinds: synced \(My files\); disk \(Files in the folders on this computer\); item \(Tracker items\)/);
  assert.match(user.content, /Types: task \(Tasks\); idea \(Ideas\)/);
  assert.match(user.content, /Projects: Deep Time, AION gateway, Kitchen/);
  assert.match(user.content, /Folders: tracker-editor, notes/);
  assert.equal(planMessages('x', picture)[0].content, system.content, 'the same system message each time');
});

test('the plan from the model is checked against what exists', () => {
  const reply = 'Here:\n```json\n{"intent": "find", "terms": ["docker", "Docker compose", "docker", "  "], "patterns": ["\\\\bdocker\\\\s+(run|compose)\\\\b", "(a+)+$", "(?<=x)y", "\\\\p{L}+"], "names": ["dockerfile"], "projects": ["deep time", "Mars"], "tags": ["DOCKER", "nope"], "kinds": ["synced", "web"], "types": ["task", "bug"], "status": "open", "since": "2026-10-01", "until": "2026-02-30", "sort": "recent", "encrypted": "yes", "limit": 500}\n```';
  const plan = parseFindPlan(reply, 'q', picture);
  assert.deepEqual(plan.terms, ['docker', 'Docker compose']);
  assert.deepEqual(plan.patterns, ['\\bdocker\\s+(run|compose)\\b'], 'runaway, look-behind and Unicode-class patterns are dropped');
  assert.deepEqual(plan.names, ['dockerfile']);
  assert.deepEqual(plan.projects, ['Deep Time'], 'their spelling; unknown ones dropped');
  assert.deepEqual(plan.tags, ['docker']);
  assert.deepEqual(plan.kinds, ['synced']);
  assert.deepEqual(plan.types, ['task']);
  assert.equal(plan.status, 'open');
  assert.equal(plan.since, '2026-10-01');
  assert.equal(plan.until, '', 'not a real date');
  assert.equal(plan.sort, 'recent');
  assert.equal(plan.encrypted, false, 'only true is true');
  assert.equal(plan.limit, 50);
  // Nothing to search by: filters make it a listing; nothing at all, the question's words.
  assert.equal(parseFindPlan('{"intent": "find", "terms": [], "projects": ["Kitchen"]}', 'q', picture).intent, 'list');
  assert.deepEqual(parseFindPlan('{"intent": "find"}', 'Where are my coal forest notes?', picture).terms, ['coal', 'forest']);
  assert.equal(parseFindPlan('no JSON at all', 'docker compose', picture).plain, true);
  const swapped = parseFindPlan('{"terms": ["x"], "since": "2026-10-31", "until": "2026-10-01"}', 'q', picture);
  assert.deepEqual([swapped.since, swapped.until], ['2026-10-01', '2026-10-31']);
});

test('patterns that could run away are refused', () => {
  assert.equal(patternProblem('\\bdocker(-compose)?\\s+(run|build)\\b'), '');
  assert.equal(patternProblem('SELECT\\s+.*\\s+FROM'), '');
  assert.equal(patternProblem('(a+)+'), 'nested repeats');
  assert.equal(patternProblem('((ab)*c)+'), 'nested repeats');
  assert.equal(patternProblem('(x|y){2,}'), '');
  assert.equal(patternProblem('(\\w+\\s?)*$'), 'nested repeats');
  assert.equal(patternProblem('[(]+x'), '', 'brackets inside a class are not groups');
  assert.equal(patternProblem('(a)\\1'), 'back references');
  assert.equal(patternProblem('(?!x)y'), 'look-arounds');
  assert.equal(patternProblem('('), 'unbalanced');
  assert.equal(patternProblem('x'.repeat(200)), 'too long');
  assert.equal(patternProblem('[z-a]'), 'not a valid pattern');
});

test('measuring: filters, counts, names and the lines that matched', () => {
  const plan = { ...plainPlan(''), terms: ['docker', 'docker compose'], patterns: ['\\bdocker\\s+run\\b'], names: ['dockerfile'] };
  const deploy = measure(sources[0], plan);
  assert.deepEqual(deploy.counts, [2, 1]);
  assert.deepEqual(deploy.patterns, [1]);
  assert.deepEqual(deploy.lines.map((l) => l.line), [4, 3], 'the pattern line, then the phrase');
  assert.equal(deploy.lines[1].text, 'docker compose up -d');
  assert.equal(deploy.text, undefined, 'the text does not travel');
  const dockerfile = measure(sources[3], plan);
  assert.deepEqual([dockerfile.inName, dockerfile.names], [[true, false], 1], '“docker” and “dockerfile” in its name');
  // Encrypted: matched by name only, never read.
  const secret = measure({ ...sources[4], text: 'docker password hunter2' }, plan);
  assert.deepEqual(secret.counts, [0, 0]);
  assert.deepEqual(secret.lines, []);
  // Filters leave sources out.
  assert.equal(measure(sources[1], { ...plan, projects: ['Deep Time'] }), null);
  assert.equal(measure(sources[2], { ...plan, since: '2026-10-20' }), null);
  assert.equal(measure(sources[6], { ...plan, types: ['idea'] }), null);
  assert.equal(measure(sources[0], { ...plan, types: ['task'] }), null, 'files have no type');
  assert.ok(measure(sources[6], { ...plan, status: 'open' }));
  assert.equal(measure({ ...sources[6], status: 'done' }, { ...plan, status: 'open' }), null);
  // Short words match whole words only; accents do not matter.
  assert.deepEqual(measure({ id: 'x', kind: 'synced', name: 'x', text: 'capital apis and an api' }, { ...plainPlan(''), terms: ['api'] }).counts, [1]);
  assert.deepEqual(measure(sources[5], { ...plainPlan(''), terms: ['cafe', 'coal forest'] }).counts[1], 2);
  assert.equal(measure(sources[5], { ...plainPlan(''), names: ['cafe'] }).names, 1);
  assert.equal(fold('Ünïcödé'), 'unicode');
});

test('ranking: rare words count more, then names, recency breaks ties; listings keep everything', () => {
  const plan = { ...plainPlan(''), terms: ['docker', 'docker compose'], patterns: ['\\bdocker\\s+(run|compose)\\b'], names: ['dockerfile'] };
  const ranked = rankSources(sources, plan, { now });
  assert.deepEqual(ranked.map((c) => c.id), ['f:1', 'i:9', 'd:/code/Dockerfile']);
  assert.ok(ranked.every((c) => c.score > 0));
  const recent = rankSources(sources, { ...plan, sort: 'recent' }, { now });
  assert.deepEqual(recent.map((c) => c.id), ['f:1', 'i:9', 'd:/code/Dockerfile']);
  const kitchen = rankSources(sources, { ...plainPlan(''), intent: 'list', terms: [], projects: ['Kitchen'] }, { now });
  assert.deepEqual(kitchen.map((c) => c.id), ['f:2'], 'a listing: what passes the filters');
  const untitled = rankSources(sources, { ...plainPlan(''), intent: 'list', terms: [], untitled: true }, { now });
  assert.deepEqual(untitled.map((c) => c.id), ['f:1']);
  const secrets = rankSources(sources, { ...plainPlan(''), intent: 'list', terms: [], encrypted: true }, { now });
  assert.deepEqual(secrets.map((c) => c.id), ['f:4']);
  // Measured elsewhere (the editor's main process): ranked with the others, by how many passed there too.
  const disk = measure(sources[3], plan);
  const merged = rankMeasured([measure(sources[0], plan), disk], plan, { total: 120, now });
  assert.deepEqual(merged.map((c) => c.id), ['f:1', 'd:/code/Dockerfile']);
});

test('the pick: candidates as c1, c2…, never the encrypted ones; the reply checked', () => {
  const plan = { ...plainPlan(''), terms: ['docker', 'password'] };
  const candidates = rankSources(sources, plan, { now });
  const withSecret = [{ ...measure(sources[4], { ...plan, terms: ['password'] }), score: 9, names: 1 }, ...candidates];
  const [system, user] = pickMessages('the file where I copied a docker command', withSecret);
  assert.match(system.content, /\{"results": \[\{"id": "c1", "why": "…"\}\]\}/);
  const sent = candidates.filter((c) => !c.encrypted);
  const deploy = sent.findIndex((c) => c.id === 'f:1') + 1;
  assert.match(user.content, new RegExp(`\\[c${deploy}\\] new 3 — My files · 2026-10-30\\n  3: docker compose up -d\\n  4: docker run -p 8080:80 nginx`));
  assert.match(user.content, /^Question: the file where I copied a docker command\n\nCandidates:\n\[c1\] /, 'c1 is the first one sent: the encrypted one never counts');
  assert.doesNotMatch(user.content, /passwords/, 'encrypted names never go');
  assert.doesNotMatch(pickMessages('q', candidates, { namesOnly: true })[1].content, /docker compose up/);
  const picked = parsePick('```json\n{"results": [{"id": "c2", "why": "the second"}, {"id": "c2", "why": "again"}, {"id": "c99", "why": "made up"}, {"id": "c1", "why": "has docker compose up -d at line 3"}]}\n```', withSecret);
  assert.deepEqual(picked.map((p) => [p.id, p.why]), [
    [sent[1].id, 'the second'],
    [sent[0].id, 'has docker compose up -d at line 3'],
  ]);
  assert.equal(parsePick('I think c1', candidates), null);
  assert.deepEqual(parsePick('{"results": []}', candidates), []);
  assert.equal(wantsPick(plan, candidates), true);
  assert.equal(wantsPick({ ...plan, intent: 'list' }, candidates), false);
  assert.equal(wantsPick({ ...plan, encrypted: true }, candidates), false);
  assert.equal(wantsPick(plan, candidates.slice(0, 1)), false);
});

test('the results: the pick or the ranking, encrypted ones apart', () => {
  const plan = { ...plainPlan(''), terms: ['docker'] };
  const candidates = [...rankSources(sources, plan, { now }), { id: 'f:4', name: 'docker keys', encrypted: true, score: 3 }];
  const shown = findResults(candidates, [{ ...candidates[1], why: 'x' }], plan);
  assert.deepEqual(shown.results.map((r) => r.id), [candidates[1].id]);
  assert.deepEqual(shown.encrypted.map((r) => r.id), ['f:4']);
  assert.deepEqual(shown.more.map((r) => r.id).sort(), candidates.filter((c) => !c.encrypted && c.id !== candidates[1].id).map((c) => c.id).sort());
  assert.equal(findResults(candidates, null, { ...plan, limit: 1 }).results.length, 1, 'no pick: the ranking');
  assert.deepEqual(findResults(candidates, null, { ...plan, encrypted: true }).results, [], 'encrypted files: only the group');
  assert.match(planWords({ ...plan, projects: ['Deep Time'], since: '2026-10-01', sort: 'recent' }), /^docker · in Deep Time · since 2026-10-01 · newest first$/);
});

test('what is a question to ask, rather than words to match', () => {
  for (const q of ['the file where I copied a docker command', 'show me the files of Deep Time', 'notes about the coal forest layer', 'What did Claude send me about language servers?', 'tasks about the kitchen due this week', 'the SQL I wrote for the gateway', '?docker', 'muestra mis notas de cocina'])
    assert.equal(looksLikeQuestion(q), true, q);
  for (const q of ['docker', 'kitchen plan', 'gateway.sql', '#docker +Kitchen', '?', 'fix the leak'])
    assert.equal(looksLikeQuestion(q), false, q);
  assert.equal(questionOf('? docker commands'), 'docker commands');
  assert.deepEqual(questionWords('Show me the files about the café on my Kitchen'), ['cafe', 'kitchen']);
});

test('no Unicode property escapes or Intl: the phone’s Node.js runs it without ICU', async () => {
  const source = await readFile(new URL('../app/js/askFind.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\\[pP]\{/);
  assert.doesNotMatch(source, /\bIntl\./);
  assert.doesNotMatch(source, /localeCompare\([^)]*,/, 'no locale options (they need ICU)');
});
