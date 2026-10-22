import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMMAND_GROUPS, COMMAND_LIST, findCommands, groupsOf, keysFor } from '../app/js/commands.js';

test('every command in Help runs something the app has', async () => {
  const app = await readFile(new URL('../app/js/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const commands = {');
  const block = app.slice(start, app.indexOf('\n  };', start));
  const handled = new Set([...block.matchAll(/^\s{4}(?:'([\w-]+)'|(\w+)): /gm)].map((m) => m[1] ?? m[2]));
  for (const c of COMMAND_LIST.filter((x) => x.run !== false)) assert.ok(handled.has(c.id), `${c.id} is not handled`);
  // The desktop menu's commands go through the same map.
  const main = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  for (const [, id] of main.matchAll(/send\('([\w-]+)'\)/g)) assert.ok(handled.has(id), `the menu's ${id} is not handled`);
  assert.equal(new Set(COMMAND_LIST.map((c) => c.id)).size, COMMAND_LIST.length, 'ids are unique');
  assert.ok(COMMAND_LIST.every((c) => COMMAND_GROUPS.includes(c.group)));
  // Rows that only explain something say what to press, type or do.
  assert.ok(COMMAND_LIST.filter((c) => c.run === false).every((c) => c.keys || c.code || c.how));
});

test('keys as this computer shows them', () => {
  const save = COMMAND_LIST.find((c) => c.id === 'item-save');
  assert.equal(keysFor(save), 'Ctrl+Enter');
  assert.equal(keysFor(save, { mac: true }), 'Cmd+Enter');
  const sync = COMMAND_LIST.find((c) => c.id === 'sync');
  assert.equal(keysFor(sync), '');
  assert.equal(keysFor(sync, { desktop: true }), 'Ctrl+Shift+S');
  const quick = COMMAND_LIST.find((c) => c.id === 'quick-add-window');
  assert.equal(keysFor(quick, { mac: true, desktop: true }), 'Cmd+Option+T');
  assert.equal(keysFor(COMMAND_LIST.find((c) => c.id === 'new-item'), { desktop: true }), 'N · Ctrl+N');
});

test('finding commands by words, keys or syntax; desktop ones only there', () => {
  assert.deepEqual(findCommands('plan my day').map((c) => c.id), ['plan-day']);
  assert.ok(findCommands('ctrl+enter').some((c) => c.id === 'item-save'));
  assert.ok(findCommands('@tomorrow').some((c) => c.id === 'qa-due'));
  assert.ok(!findCommands('any app').some((c) => c.id === 'quick-add-window'));
  assert.ok(findCommands('any app', { desktop: true }).some((c) => c.id === 'quick-add-window'));
});

test('while searching, label matches come first, and their group with them', () => {
  // "settings" is also in the quick add window's hint; Enter should still go to Settings.
  const found = findCommands('settings', { desktop: true });
  assert.equal(found[0].id, 'settings');
  assert.deepEqual(groupsOf(found, true)[0], 'Go to');
  assert.equal(findCommands('new')[0].id, 'new-item');
  assert.deepEqual(groupsOf(findCommands(''), false), COMMAND_GROUPS);
});
