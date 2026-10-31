// Release boards: the file format, merging record by record, changes, the log, the standalone
// page's data file in and out, and what the board's tiles and cards count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLog,
  applyBoardChanges,
  boardData,
  boardFromData,
  boardPath,
  boardScript,
  boardSummary,
  changedSince,
  emptyBoard,
  liveRecords,
  mergeBoards,
  MAX_LOG,
  parseBoard,
  readBoardData,
  releaseProgress,
  serializeBoard,
  setNow,
  tidyBoard,
  upcoming,
} from '../app/js/boards.js';

import { DEMO } from './fixtures/board-demo.js';

const AT = '2026-10-31T09:00:00.000Z';
const page = (variable = 'DEMO_DATA') =>
  `<!doctype html><html><head><style>body{margin:0}</style><script>var x = { a: "}" };</script></head><body>\n<script>\nwindow.${variable} = ${JSON.stringify(DEMO, null, 1)};\n</script>\n<script>(function(){ var D = window.${variable}; if (!D) { return; } })();</script></body></html>`;

test('a board file of the standalone page comes in from its page, its script or plain JSON', () => {
  assert.equal(readBoardData(page()).variable, 'DEMO_DATA');
  assert.deepEqual(readBoardData(page()).data, DEMO);
  assert.deepEqual(readBoardData(`window.DEMO_DATA = ${JSON.stringify(DEMO)};`).data, DEMO);
  assert.deepEqual(readBoardData(JSON.stringify(DEMO)), { data: DEMO, variable: '' });
  assert.throws(() => readBoardData('<html>nothing here</html>'), /not a release board file/);
  assert.throws(() => readBoardData('window.X = { "a": 1 };'), /no releases, features/);
  assert.throws(() => readBoardData('window.X = { broken: true };'), /cannot be read/);
});

test('imported records keep their ids, get one where the file has none, and are stamped', () => {
  const board = boardFromData(page(), { project: 'Demo app', at: AT, by: 'Claude' });
  assert.equal(board.project, 'Demo app');
  assert.equal(board.meta.export_variable, 'DEMO_DATA');
  assert.deepEqual(board.releases.map((r) => r.id), ['R1', 'R2']);
  assert.deepEqual(board.sessions.map((s) => s.id), ['Reports', 'Release'], 'sessions by name');
  assert.deepEqual(board.repos.map((s) => s.id), ['web']);
  assert.deepEqual(board.briefs.map((s) => s.id), ['B1']);
  assert.ok(board.actions.every((a) => /^a-/.test(a.id)) && new Set(board.actions.map((a) => a.id)).size === 2);
  assert.ok(board.log.every((l) => /^l-/.test(l.id)));
  assert.ok(board.features.every((f) => f.updatedAt === AT && f.updatedBy === 'Claude'));
  assert.equal(board.now.headline, 'R2 goes out Monday');
});

test('exported, a board is the page\'s data file again', () => {
  const board = boardFromData(page(), { project: 'Demo app', at: AT, by: 'Claude' });
  assert.deepEqual(boardData(board), DEMO);
  const script = boardScript(board);
  assert.ok(script.startsWith('window.DEMO_DATA = {'));
  assert.deepEqual(readBoardData(script).data, DEMO, 'round trip');
  assert.ok(boardScript(board, 'OTHER').startsWith('window.OTHER = '));
  assert.throws(() => boardScript(board, 'not a name'), /cannot be a script variable/);
  // Unknown parts of a newer page come back out.
  const newer = boardFromData({ ...DEMO, roadmap: [{ q: 'Q1' }] }, { project: 'Demo app', at: AT });
  assert.deepEqual(boardData(newer).roadmap, [{ q: 'Q1' }]);
});

test('the board file: parsed safely, its path from the project name', () => {
  const board = boardFromData(DEMO, { project: 'Demo app', at: AT });
  assert.deepEqual(parseBoard(serializeBoard(board)), board);
  assert.equal(parseBoard('{ not json'), null);
  assert.equal(parseBoard('{"no":"version"}'), null);
  assert.equal(parseBoard('[1,2]'), null);
  const odd = parseBoard({ version: 1, releases: [{ id: 'R1' }, { id: 'R1' }, { title: 'no id' }, 'text'], features: 'nope' });
  assert.deepEqual(odd.releases, [{ id: 'R1' }]);
  assert.deepEqual(odd.features, []);
  assert.equal(boardPath('Demo App'), 'boards/demo-app.json');
  assert.equal(boardPath('Café / Ops'), 'boards/cafe-ops.json');
  assert.equal(emptyBoard('X').releases.length, 0);
});

test('changes: fields set (dotted paths too), records added, removed as tombstones', () => {
  const board = boardFromData(DEMO, { project: 'Demo app', at: AT });
  const later = '2026-10-31T10:00:00.000Z';
  const { board: next, changed } = applyBoardChanges(
    board,
    [
      { part: 'features', id: 'f-reports', set: { status: 'live', commit: 'fff111', shipped: '2026-10-31 10:00' } },
      { part: 'releases', id: 'R2', set: { 'steps.1.done': true, 'steps.1.date': '2026-10-31', 'dates.merged': '2026-10-31' } },
      { part: 'tests', id: 't-new', set: { title: 'Export test', release: 'R2', status: 'planned' } },
      { part: 'features', id: 'f-export', set: { blockers: null } },
      { part: 'decisions', id: 'd-1', remove: true },
    ],
    { at: later, by: 'Claude · Reports' },
  );
  assert.deepEqual(changed.map((c) => `${c.part}/${c.id}:${c.action}`), ['features/f-reports:changed', 'releases/R2:changed', 'tests/t-new:added', 'features/f-export:changed', 'decisions/d-1:removed']);
  const reports = next.features.find((f) => f.id === 'f-reports');
  assert.equal(reports.status, 'live');
  assert.equal(reports.what, 'Monthly reports.', 'other fields stay');
  assert.equal(reports.updatedBy, 'Claude · Reports');
  const r2 = next.releases.find((r) => r.id === 'R2');
  assert.deepEqual(r2.steps[1], { label: 'Merge', done: true, date: '2026-10-31' });
  assert.equal(r2.dates.merged, '2026-10-31');
  assert.equal(board.releases.find((r) => r.id === 'R2').steps[1].done, false, 'the board read is not changed');
  assert.equal(next.tests.at(-1).id, 't-new');
  assert.ok(!('blockers' in next.features.find((f) => f.id === 'f-export')), 'null removes a field');
  assert.deepEqual(Object.keys(next.decisions.find((d) => d.id === 'd-1')).sort(), ['deleted', 'id', 'updatedAt', 'updatedBy']);
  assert.deepEqual(liveRecords(next, 'decisions').map((d) => d.id), ['d-2']);
  assert.equal(applyBoardChanges(next, [{ part: 'decisions', id: 'd-1', remove: true }]).changed.length, 0, 'removing twice does nothing');
  // A removed record can come back.
  assert.equal(applyBoardChanges(next, [{ part: 'decisions', id: 'd-1', set: { title: 'Back' } }]).changed[0].action, 'added');

  assert.throws(() => applyBoardChanges(board, [{ part: 'nope', id: 'x', set: {} }]), /not a part of a board/);
  assert.throws(() => applyBoardChanges(board, [{ part: 'features', set: { name: 'no id' } }]), /needs an id/);
  assert.throws(() => applyBoardChanges(board, [{ part: 'features', id: 'x', set: { '__proto__.polluted': 1 } }]), /not a field name/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => applyBoardChanges(board, [{ part: 'features', id: 'x', set: { what: 'x'.repeat(70000) } }]), /too large/);
  // Sessions take their id from the name, as in the page's data.
  assert.equal(applyBoardChanges(board, [{ part: 'sessions', set: { name: 'Docs', state: 'working' } }]).changed[0].id, 'Docs');
});

test('two copies merge record by record; a tombstone wins over an older version', () => {
  const base = boardFromData(DEMO, { project: 'Demo app', at: AT });
  const one = applyBoardChanges(base, [{ part: 'features', id: 'f-reports', set: { status: 'live' } }], { at: '2026-10-31T10:00:00.000Z', by: 'A' }).board;
  const two = applyBoardChanges(base, [
    { part: 'features', id: 'f-export', set: { status: 'built' } },
    { part: 'tests', id: 't-x', set: { title: 'New' } },
    { part: 'decisions', id: 'd-2', remove: true },
  ], { at: '2026-10-31T10:05:00.000Z', by: 'B' }).board;
  const merged = mergeBoards(one, two);
  assert.equal(merged.features.find((f) => f.id === 'f-reports').status, 'live');
  assert.equal(merged.features.find((f) => f.id === 'f-export').status, 'built');
  assert.ok(merged.tests.some((t) => t.id === 't-x'));
  assert.ok(merged.decisions.find((d) => d.id === 'd-2').deleted);
  assert.deepEqual(mergeBoards(two, one), merged, 'the same either way round');
  const headline = setNow(one, { headline: 'New headline' }, { at: '2026-10-31T11:00:00.000Z', by: 'A' });
  assert.equal(mergeBoards(two, headline).now.headline, 'New headline');
});

test('the log: newest first, merged by entry, kept to its newest entries', () => {
  let board = boardFromData(DEMO, { project: 'Demo app', at: AT });
  board = addLog(board, { text: 'Reports merged', release: 'R2' }, { at: '2026-10-31T10:30:00.000Z', by: 'Claude' });
  assert.equal(board.log[0].text, 'Reports merged');
  assert.equal(board.log[0].time, '2026-10-31 10:30');
  assert.equal(addLog(board, { text: '  ' }), board);
  const other = addLog(boardFromData(DEMO, { project: 'Demo app', at: AT }), { text: 'Export started' }, { at: '2026-10-31T10:20:00.000Z' });
  assert.deepEqual(mergeBoards(board, other).log.map((l) => l.text), ['Reports merged', 'Export started', 'R2 cut', 'R1 live']);
  let big = board;
  for (let i = 0; i < MAX_LOG + 5; i++) big = addLog(big, { text: `entry ${i}` }, { at: new Date(Date.parse(AT) + i * 60000).toISOString() });
  const { board: tidy, older } = tidyBoard(big, AT);
  assert.equal(tidy.log.length, MAX_LOG);
  assert.equal(older.length, big.log.length - MAX_LOG);
  assert.ok(tidy.log[0].time >= older[0].time);
});

test('tombstones go after 180 days', () => {
  const january = boardFromData(DEMO, { project: 'Demo app', at: '2026-01-01T00:00:00.000Z' });
  const board = applyBoardChanges(january, [{ part: 'tests', id: 't-login', remove: true }], { at: '2026-01-02T00:00:00.000Z' }).board;
  assert.ok(board.tests.some((t) => t.id === 't-login'));
  assert.ok(!tidyBoard(board, AT).board.tests.some((t) => t.id === 't-login'));
});

test('what the tiles and cards count, and what comes next', () => {
  const board = boardFromData(DEMO, { project: 'Demo app', at: AT });
  const now = new Date('2026-10-31T09:00:00Z');
  const s = boardSummary(board, now);
  assert.deepEqual(s.releases, { out: 2, total: 2 });
  assert.deepEqual(s.features, { live: 2, total: 4 });
  assert.deepEqual(s.tests, { passed: 1, total: 2 });
  assert.equal(s.actions, 2);
  assert.equal(s.openDecisions, 1);
  assert.deepEqual(s.next.map((n) => n.title), ['Server swap', 'R2: go live']);
  assert.deepEqual(s.cards[1], { id: 'R2', progress: { done: 1, total: 3, percent: 33 }, features: { live: 0, total: 2 }, tests: { passed: 0, total: 1 }, merges: 0 });
  assert.deepEqual(releaseProgress({ status: 'live' }), { done: 0, total: 0, percent: 100 });
  assert.deepEqual(releaseProgress({ status: 'planned' }), { done: 0, total: 0, percent: 0 });
  assert.deepEqual(upcoming(board, new Date('2026-11-05T00:00:00Z')), []);
  const changed = changedSince(applyBoardChanges(board, [{ part: 'tests', id: 't-reports', set: { status: 'passed' } }], { at: '2026-10-31T12:00:00.000Z' }).board, AT);
  assert.deepEqual(changed.map((c) => `${c.part}/${c.id}`), ['tests/t-reports']);
});
