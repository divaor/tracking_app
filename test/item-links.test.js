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
