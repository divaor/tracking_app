import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EDITOR_URL, editorLink, parseEditorLink } from '../app/js/editorLinks.js';

test('recognizes links to an editor file', () => {
  assert.deepEqual(parseEditorLink(`${DEFAULT_EDITOR_URL}#/file/m1abc-x9`), { kind: 'file', id: 'm1abc-x9' });
  assert.deepEqual(parseEditorLink('https://divaor.github.io/tracker-editor#/file/a1'), { kind: 'file', id: 'a1' });
  assert.deepEqual(parseEditorLink('https://divaor.github.io/tracker-editor/index.html#/file/a1'), null);
  assert.deepEqual(parseEditorLink('tracker-editor://file/a1'), { kind: 'file', id: 'a1' });
  assert.deepEqual(parseEditorLink('tracker-editor://repo/files/2026-10-21-plan-abc123/plan%20v2.md'), { kind: 'repo', path: 'files/2026-10-21-plan-abc123/plan v2.md' });
});

test('uses the configured editor address as well as the default', () => {
  const own = 'https://notes.example.com/editor/';
  assert.deepEqual(parseEditorLink('https://notes.example.com/editor/#/file/a1', own), { kind: 'file', id: 'a1' });
  assert.deepEqual(parseEditorLink(`${DEFAULT_EDITOR_URL}#/file/a1`, own), { kind: 'file', id: 'a1' });
  assert.equal(parseEditorLink('https://notes.example.com/editor/#/file/a1'), null);
});

test('ignores other links', () => {
  for (const url of ['', 'not a url', 'https://github.com/divaor/tracking_app/pull/1', `${DEFAULT_EDITOR_URL}`, `${DEFAULT_EDITOR_URL}#/settings`, `${DEFAULT_EDITOR_URL}#/file/`, 'https://example.com/#/file/a1', `${DEFAULT_EDITOR_URL}#/file/%E0%A4%A`]) {
    assert.equal(parseEditorLink(url), null, url);
  }
});

test('builds web and desktop links that round-trip', () => {
  const file = { kind: 'file', id: 'm1abc-x9' };
  const repo = { kind: 'repo', path: 'files/2026-10-21-plan-abc123/plan v2#.md' };
  assert.equal(editorLink(file), `${DEFAULT_EDITOR_URL}#/file/m1abc-x9`);
  assert.equal(editorLink(repo), `${DEFAULT_EDITOR_URL}#/repo/files/2026-10-21-plan-abc123/plan%20v2%23.md`);
  assert.equal(editorLink(file, { editorUrl: 'https://notes.example.com/editor' }), 'https://notes.example.com/editor/#/file/m1abc-x9');
  assert.equal(editorLink(repo, { desktop: true }), 'tracker-editor://repo/files/2026-10-21-plan-abc123/plan%20v2%23.md');
  for (const route of [file, repo]) {
    assert.deepEqual(parseEditorLink(editorLink(route)), route);
    assert.deepEqual(parseEditorLink(editorLink(route, { desktop: true })), route);
  }
});
