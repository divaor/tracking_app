import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatLink, chatPreview, chatRow, chatTitle, filterChats, filterCounts, fitMessages, linkLabel, pruneIndex, settledTurns, shrinkChat, withRow } from '../app/js/assistantChats.js';
import { createChatStore } from '../app/js/assistantChatStore.js';

const row = (id, o = {}) => ({ id, title: id, updatedAt: `2026-11-0${o.day ?? 1}T10:00:00Z`, saved: false, link: null, preview: '', ...o });

test('a chat: its title from the first question, the last answer’s first words, what it is about', () => {
  assert.equal(chatTitle('  tag my   Deep Time tasks #layers  '), 'tag my Deep Time tasks #layers');
  assert.equal(chatTitle(''), 'New chat');
  assert.equal(chatTitle('x'.repeat(200)).length, 80);
  assert.equal(chatPreview('Done: **3 items** tagged.\n```tracker-steps\n[{"op":"find"}]\n```\nAnything else?'), 'Done: 3 items tagged. [steps] Anything else?');
  assert.deepEqual(chatLink({ open: { id: 'i1', title: 'Fix the parser', project: 'Deep Time' }, project: 'Globe' }), { project: 'Deep Time', item: { id: 'i1', title: 'Fix the parser' } });
  assert.deepEqual(chatLink({ project: 'Globe' }), { project: 'Globe', item: null });
  assert.equal(chatLink({}), null);
  assert.equal(linkLabel({ project: 'Deep Time', item: { id: 'i1', title: 'Fix the parser' } }), 'Fix the parser · Deep Time');
  assert.equal(linkLabel({ project: 'Globe', item: null }), 'Globe');
  assert.equal(linkLabel(null), '');
  assert.equal(chatRow({ id: 'a', state: { big: true } }).state, undefined);
});

test('the list: newest first, saved ones kept past the limit, filtered by item, project, saved and words', () => {
  let index = [];
  for (let d = 1; d <= 5; d++) index = withRow(index, row(`c${d}`, { day: d, saved: d === 1 }));
  assert.deepEqual(index.map((r) => r.id), ['c5', 'c4', 'c3', 'c2', 'c1']);
  const { index: kept, dropped } = pruneIndex(index, 3);
  assert.deepEqual(kept.map((r) => r.id), ['c5', 'c4', 'c1']);
  assert.deepEqual(dropped, ['c3', 'c2']);
  const rows = [
    row('a', { title: 'Tag the layers', link: { project: 'Deep Time', item: { id: 'i1', title: 'Layers' } } }),
    row('b', { title: 'Plan my week', link: { project: 'deep time', item: null }, saved: true }),
    row('c', { title: 'Release notes', preview: 'the globe board', link: { project: 'Globe', item: null } }),
  ];
  assert.deepEqual(filterChats(rows, { show: 'here', itemId: 'i1' }).map((r) => r.id), ['a']);
  assert.deepEqual(filterChats(rows, { show: 'project', project: 'Deep Time' }).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(filterChats(rows, { show: 'saved' }).map((r) => r.id), ['b']);
  assert.deepEqual(filterChats(rows, { query: 'GLOBE' }).map((r) => r.id), ['c']);
  assert.deepEqual(filterChats(rows, { query: 'layers deep' }).map((r) => r.id), ['a']);
  assert.deepEqual(filterCounts(rows, { itemId: 'i1', project: 'Deep Time' }), { here: 1, project: 2, all: 3, saved: 1 });
});

test('long chats: the oldest messages shortened first, the newest whole; a chat kept within its size', () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${'x'.repeat(5000)}` }));
  const fit = fitMessages(messages, 25000);
  assert.ok(fit[0].content.length < 2000 && /left out/.test(fit[0].content));
  assert.equal(fit.at(-1).content.length, messages.at(-1).content.length);
  assert.equal(messages[0].content.length, 5002, 'the messages given are not changed');
  const chat = { id: 'a', state: { turns: [], history: messages } };
  assert.ok(JSON.stringify(shrinkChat(chat, 20000)).length < JSON.stringify(chat).length);
  const small = { id: 'b', state: {} };
  assert.equal(shrinkChat(small, 10), small, 'nothing to shorten: kept as it is');
});

test('a chat taken up again: what waited or ran did not happen; Undo stays', () => {
  const turns = [{ question: 'q', parts: [{ text: 'a' }, { steps: [{ status: 'ok', undo: { kind: 'data', changes: [] } }, { status: 'waiting' }, { status: 'running' }, { status: 'undone' }] }] }];
  const settled = settledTurns(turns)[0].parts[1].steps;
  assert.deepEqual(settled.map((s) => s.status), ['ok', 'stopped', 'stopped', 'undone']);
  assert.ok(settled[0].undo, 'Undo stays: it puts back field by field what the step wrote');
});

test('the store: kept at once, the current chat, saved/renamed in place, deleted with Undo, pruned', async () => {
  const kv = new Map();
  let t = 0;
  const store = createChatStore({ get: async (k) => kv.get(k), set: async (k, v) => kv.set(k, v), del: async (k) => kv.delete(k), wait: 0, max: 2, now: () => `2026-11-10T10:00:0${t++}Z` });
  await store.ready();
  assert.equal(store.current(), undefined);
  store.save({ id: 'a', title: 'First', state: { turns: [{ question: 'q' }], history: [] } });
  store.setCurrent('a');
  await store.flush();
  assert.equal(kv.get('assistantChat:a').title, 'First');
  assert.equal(kv.get('assistantChats:current'), 'a');
  await store.setSaved('a', true);
  await store.rename('a', '  Kept   one ');
  assert.deepEqual(store.list().map((r) => [r.id, r.title, r.saved, r.named]), [['a', 'Kept one', true, true]]);
  store.save({ id: 'b', title: 'B' });
  store.save({ id: 'c', title: 'C' });
  await store.flush();
  assert.deepEqual(store.list().map((r) => r.id).sort(), ['a', 'c'], 'the saved one stays past the limit; the oldest other goes');
  assert.equal(kv.has('assistantChat:b'), false);
  const gone = await store.remove('a');
  assert.equal(store.current(), undefined, 'the current chat deleted: none');
  await store.restore(gone);
  assert.ok(store.list().some((r) => r.id === 'a' && r.saved));
  store.setCurrent(null);
  await store.flush();
  assert.equal(kv.get('assistantChats:current'), null, 'New chat asked for');
  // A fresh store reads what was kept.
  const again = createChatStore({ get: async (k) => kv.get(k), set: async (k, v) => kv.set(k, v), del: async (k) => kv.delete(k) });
  await again.ready();
  assert.equal(again.current(), null);
  assert.equal((await again.load('a')).title, 'Kept one');
  assert.equal(await again.removeAll({ keepSaved: true }), 1);
  assert.deepEqual(again.list().map((r) => r.id), ['a']);
});
