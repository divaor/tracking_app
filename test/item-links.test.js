import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appItemLink, itemIdIn, splitItemIds, webItemLink } from '../app/js/itemLinks.js';
import { matchesQuery, newId, normalizeItem } from '../app/js/model.js';

const ID = 'mvgtsb4u-146da3a5ae86da00';

test('the item a link or an id names', () => {
  assert.equal(itemIdIn(`https://divaor.github.io/tracking_app/#/item/${ID}`), ID);
  assert.equal(itemIdIn(`  https://divaor.github.io/tracking_app/#/item/${ID}  `), ID, 'pasted with spaces');
  assert.equal(itemIdIn(`http://localhost:8080/#/item/${ID}?x=1`), ID);
  assert.equal(itemIdIn(`#/item/${ID}`), ID);
  assert.equal(itemIdIn(`tracker-app://item/${ID}`), ID);
  assert.equal(itemIdIn(ID), ID);
  assert.equal(itemIdIn(ID.toUpperCase().replace('M', 'm')), null, 'ids are lower case');
  // Searches stay searches.
  for (const text of ['', 'launch plan', '#work', '+platform', 'mvgtsb4u', '146da3a5ae86da00', `${ID} notes`, 'https://example.com/page', '#/list']) {
    assert.equal(itemIdIn(text), null, text);
  }
  // Every id the app makes is recognized.
  for (let i = 0; i < 20; i++) {
    const id = newId();
    assert.equal(itemIdIn(id), id);
  }
});

test('links to an item, on the web and in the desktop app', () => {
  assert.equal(webItemLink(ID), `https://divaor.github.io/tracking_app/#/item/${ID}`);
  assert.equal(webItemLink(ID, 'http://localhost:8080/index.html#/list'), `http://localhost:8080/index.html#/item/${ID}`);
  assert.equal(webItemLink(ID, 'https://example.com/tracker'), `https://example.com/tracker/#/item/${ID}`);
  assert.equal(appItemLink(ID), `tracker-app://item/${ID}`);
  assert.equal(itemIdIn(webItemLink(ID)), ID);
  assert.equal(itemIdIn(appItemLink(ID)), ID);
});

test('ids in text, for links in notes', () => {
  assert.deepEqual(splitItemIds(`the plan doc (${ID}) and mvnxdag2-d61becbfb54dde49.`), [
    'the plan doc (',
    { id: ID },
    ') and ',
    { id: 'mvnxdag2-d61becbfb54dde49' },
    '.',
  ]);
  assert.deepEqual(splitItemIds('no ids here'), ['no ids here']);
  assert.deepEqual(splitItemIds(ID), [{ id: ID }]);
  // Part of a longer word is not an id.
  assert.deepEqual(splitItemIds(`x${ID}0`), [`x${ID}0`]);
});

test('search finds an item by its id, or part of it', () => {
  const item = normalizeItem({ id: ID, title: 'Plan' });
  assert.ok(matchesQuery(item, ID));
  assert.ok(matchesQuery(item, 'mvgtsb4u'));
  assert.ok(!matchesQuery(item, 'mvnxdag2'));
});

test('idFromFragment: part of an id opens the one item that holds it', async () => {
  const { idFromFragment } = await import('../app/js/itemLinks.js');
  const ids = ['mvtquqbr-27e83a7b66f4622d', 'mvu8fw93-7ddb8811a897aa77', 'mvt37e9v-37c2ac6e00e24b96'];
  assert.equal(idFromFragment('27e83a7b', ids), ids[0]);
  assert.equal(idFromFragment('  27E83A7B66F4  ', ids), ids[0], 'case and spaces');
  assert.equal(idFromFragment('mvtquqbr', ids), ids[0], 'the time half, letters only');
  assert.equal(idFromFragment('mvtquqbr-27e8…', ids), ids[0], 'cut off with an ellipsis');
  assert.equal(idFromFragment('`7ddb8811`', ids), ids[1], 'in backticks');
  assert.equal(idFromFragment('mvt', ids), null, 'too short');
  assert.equal(idFromFragment('mvt37e', ids), ids[2]);
  assert.equal(idFromFragment('37', ids), null);
  assert.equal(idFromFragment('ac6e00e2', ids), ids[2]);
  assert.equal(idFromFragment('e8', ids), null);
  assert.equal(idFromFragment('quqbr2', ids), null, 'in no id');
  assert.equal(idFromFragment('tquqbr', ids), null, 'letters only and not a whole half: a word, not an id');
  assert.equal(idFromFragment('7e', ['aaaaaa-7e0000', 'bbbbbb-7e1111']), null);
  assert.equal(idFromFragment('aa7e00', ['aa7e00-1', 'aa7e00-2']), null, 'several hold it');
  assert.equal(idFromFragment('two words', ids), null);
});
