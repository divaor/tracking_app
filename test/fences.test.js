// Fenced blocks in the model's answers read as CommonMark reads them (fences.js, a copy of Tracker
// Editor's), and the assistant's steps: a ``` inside an item's notes never ends a tracker-steps block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { codeFences, parseJsonLoose, wordsBefore } from '../app/js/fences.js';
import { parsePlan, wordsSoFar } from '../app/js/assistantSteps.js';

test('the editor and the tracker keep the same fences.js but for its header', () => {
  const editor = '../tracker-editor/app/js/fences.js';
  if (!fs.existsSync(editor)) return;
  const body = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
  assert.equal(body('app/js/fences.js'), body(editor));
});

test('an item whose notes hold a code block: the steps are read whole', () => {
  const notes = 'To deploy:\n\n```\nnpm run build\nnpm run deploy\n```\n';
  const steps = [{ op: 'add-items', items: [{ title: 'Deploy the site', notes }], why: 'as you asked' }];
  for (const fence of ['```', '````']) {
    const plan = parsePlan(`I'll add it.\n\n${fence}tracker-steps\n${JSON.stringify(steps, null, 2)}\n${fence}\n\nDone soon.`);
    assert.deepEqual(plan.problems, [], fence);
    assert.deepEqual(plan.steps.map((s) => s.op), ['add-items'], fence);
    assert.equal(plan.steps[0].step.items[0].notes, notes, fence);
    assert.equal(plan.text, "I'll add it.\n\nDone soon.", fence);
  }
});

test('while it streams, the words stop before the steps', () => {
  assert.equal(wordsSoFar("I'll add it.\n\n````tracker-steps\n[{ \"op\": \"add-items\", \"items\": [{ \"title\": \"x\", \"notes\": \"```"), "I'll add it.");
  assert.equal(wordsBefore('A\n```json\n{}', ['json']), 'A');
});

test('codeFences and parseJsonLoose in brief', () => {
  assert.deepEqual(codeFences('````md\n```\nin\n```\n````').map((b) => b.body), ['```\nin\n```']);
  assert.deepEqual(codeFences('```\nopen'), [{ lang: '', info: '', body: 'open', start: 0, end: 8, closed: false }]);
  assert.deepEqual(parseJsonLoose('[{"op": "add-items", "items": [{"title": "a\nb"},],}]'), [{ op: 'add-items', items: [{ title: 'a\nb' }] }]);
});
