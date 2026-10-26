// Comments on any item (model.js): kept only when there are some, one per id at its latest
// version, deleted ones as tombstones; merged comment by comment when two devices change the
// same item; read by search, notifications, the in-app model; synced without losing any.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCommentPatch,
  applyPatch,
  awaitsClaude,
  CLAUDE_AUTHOR,
  cleanComments,
  createItem,
  deleteCommentPatch,
  editCommentPatch,
  liveComments,
  matchesQuery,
  mergeItems,
  normalizeItem,
  parseDocument,
  restoreCommentPatch,
  serializeDocument,
  tombstone,
} from '../app/js/model.js';
import { describeChanges } from '../app/js/changes.js';
import { describeItem } from '../app/js/assist.js';
import { syncOnce } from '../app/js/sync.js';

const t = (minute) => `2026-10-25T10:${String(minute).padStart(2, '0')}:00.000Z`;
const comment = (item, text, by, minute) => applyPatch(item, addCommentPatch(item, text, by, t(minute)), t(minute));

test('an item has comments only when there are some; they are cleaned and ordered', () => {
  const item = createItem({ title: 'Fix login' }, t(0));
  assert.equal('comments' in item, false, 'older data files do not change');
  assert.equal('comments' in normalizeItem({ ...item, comments: [] }), false);
  assert.deepEqual(
    cleanComments([
      { id: 'b', by: 'Phone', at: t(2), text: 'second' },
      { id: 'a', by: ' Work PC ', at: t(1), text: 'first' },
      { id: 'b', by: 'Phone', at: t(2), text: 'second, edited', editedAt: t(5), edited: true },
      { id: 'b', by: 'Phone', at: t(2), text: 'second, older edit', editedAt: t(3), edited: true },
      { by: 'no id', at: t(1), text: 'x' },
      { id: 'c', by: 'x', text: 'no date' },
      null,
    ]),
    [
      { id: 'a', by: 'Work PC', at: t(1), text: 'first' },
      { id: 'b', by: 'Phone', at: t(2), text: 'second, edited', editedAt: t(5), edited: true },
    ],
  );
  // A data file keeps them through a round trip.
  const withOne = comment(item, 'Also handle SSO', 'Work PC', 1);
  const [back] = parseDocument(serializeDocument([withOne]));
  assert.deepEqual(back.comments, withOne.comments);
});

test('add, edit, delete and bring back a comment; who answered last', () => {
  let item = createItem({ title: 'Fix login' }, t(0));
  assert.equal(awaitsClaude(item), false);
  item = comment(item, '  Also handle **SSO**  ', 'Work PC', 1);
  assert.equal(item.comments[0].text, 'Also handle **SSO**');
  assert.equal(awaitsClaude(item), true, 'the person wrote last');
  item = comment(item, 'Done in PR 12.', CLAUDE_AUTHOR, 2);
  assert.equal(awaitsClaude(item), false, 'Claude answered');
  const [mine, claudes] = item.comments;
  item = applyPatch(item, editCommentPatch(item, mine.id, 'Also handle SSO and magic links', t(3)), t(3));
  assert.equal(item.comments[0].text, 'Also handle SSO and magic links');
  assert.equal(item.comments[0].editedAt, t(3));
  assert.equal(item.comments[0].edited, true);
  const before = item.comments[1];
  item = applyPatch(item, deleteCommentPatch(item, claudes.id, t(4)), t(4));
  assert.deepEqual(liveComments(item).map((c) => c.id), [mine.id]);
  assert.equal(item.comments[1].deleted, true);
  assert.equal(item.comments[1].text, undefined, 'a deleted comment keeps no text');
  assert.equal(awaitsClaude(item), true);
  item = applyPatch(item, restoreCommentPatch(item, before, t(5)), t(5));
  assert.deepEqual(liveComments(item).map((c) => c.text), ['Also handle SSO and magic links', 'Done in PR 12.']);
  assert.ok(item.comments[1].editedAt > t(4), 'newer than its tombstone');
  assert.equal(item.comments[1].edited, undefined, 'brought back, not edited');
  // Search finds words in comments, not in deleted ones.
  assert.ok(matchesQuery(item, 'magic'));
  const gone = applyPatch(item, deleteCommentPatch(item, mine.id, t(6)), t(6));
  assert.ok(!matchesQuery(gone, 'magic'));
});

test('two devices changing the same item keep every comment', () => {
  const base = createItem({ title: 'Fix login' }, t(0));
  // The phone comments; meanwhile the computer renames the item (a later edit, so it wins).
  const phone = comment(base, 'Also handle SSO', 'Phone', 1);
  const desk = applyPatch(base, { title: 'Fix the login page' }, t(2));
  for (const merged of [mergeItems([phone], [desk]), mergeItems([desk], [phone])]) {
    assert.equal(merged[0].title, 'Fix the login page');
    assert.deepEqual(liveComments(merged[0]).map((c) => c.text), ['Also handle SSO']);
  }
  // Comments added in the same millisecond keep the order they were written in.
  let quick = base;
  for (const n of [1, 2, 3, 4, 5]) quick = applyPatch(quick, addCommentPatch(quick, `n${n}`, 'Phone', t(9)), t(9));
  assert.deepEqual(liveComments(quick).map((c) => c.text), ['n1', 'n2', 'n3', 'n4', 'n5']);
  assert.ok(liveComments(quick).every((c, i, all) => !i || c.at > all[i - 1].at));
  // Both comment at the same time: both stay, in order.
  const fromPhone = comment(base, 'From the phone', 'Phone', 3);
  const fromClaude = comment(base, 'From Claude', CLAUDE_AUTHOR, 4);
  assert.deepEqual(liveComments(mergeItems([fromPhone], [fromClaude])[0]).map((c) => c.text), ['From the phone', 'From Claude']);
  // A deletion wins over the older copy, and an edit over the older text.
  const deleted = applyPatch(phone, deleteCommentPatch(phone, phone.comments[0].id, t(5)), t(5));
  assert.deepEqual(liveComments(mergeItems([deleted], [phone, desk])[0]), []);
  const edited = applyPatch(phone, editCommentPatch(phone, phone.comments[0].id, 'Also SSO, please', t(6)), t(6));
  assert.equal(liveComments(mergeItems([phone], [edited])[0])[0].text, 'Also SSO, please');
  // A deleted item stays deleted, without its comments; the same versions merge to the same object.
  assert.equal(mergeItems([phone], [tombstone(phone, t(7))])[0].deleted, true);
  assert.equal(mergeItems([phone], [phone])[0], phone);
});

test('a sync round keeps a comment written meanwhile on another device', async () => {
  const base = createItem({ title: 'Fix login' }, t(0));
  const remoteVersion = comment(base, 'Written on the phone', 'Phone', 1);
  const localVersion = applyPatch(base, { status: 'in_progress' }, t(2));
  let text = serializeDocument([remoteVersion]);
  const client = {
    getFile: async () => ({ text, sha: 'sha1' }),
    putFile: async (path, { text: next }) => ((text = next), { sha: 'sha2' }),
  };
  const result = await syncOnce({ client, path: 'tracker.json', localItems: [localVersion], now: () => t(3) });
  assert.equal(result.pushed, true);
  const [saved] = parseDocument(text);
  assert.equal(saved.status, 'in_progress');
  assert.deepEqual(liveComments(saved).map((c) => c.text), ['Written on the phone']);
});

test('notifications say who commented and what; the model reads the comments', () => {
  const base = createItem({ title: 'Fix login', notes: 'Broken on Safari' }, t(0));
  const mine = comment(base, 'Also handle SSO', 'Work PC', 1);
  const answered = { ...comment(mine, 'Done:\n\nSSO users land on the dashboard now.', CLAUDE_AUTHOR, 2), updatedBy: CLAUDE_AUTHOR };
  const [event] = describeChanges([mine], [answered]);
  assert.equal(event.title, 'Claude commented on “Fix login”');
  assert.equal(event.body, 'Done: SSO users land on the dashboard now.');
  assert.equal(event.fromClaude, true);
  assert.equal(event.itemId, base.id);
  // Deleting a comment is just an update.
  const removed = { ...applyPatch(answered, deleteCommentPatch(answered, answered.comments[1].id, t(3)), t(3)), updatedBy: 'Work PC' };
  assert.equal(describeChanges([answered], [removed])[0].title, 'Work PC updated a task');

  const text = describeItem(answered);
  assert.match(text, /Comments, oldest first:\n- Me \(2026-10-25\): Also handle SSO\n- Claude \(2026-10-25\): Done: \/ SSO users land on the dashboard now\./);
  // Long threads: the latest comments fit.
  let long = base;
  for (let n = 0; n < 80; n++) {
    const at = new Date(Date.parse(t(0)) + n * 60000).toISOString();
    long = applyPatch(long, addCommentPatch(long, `Comment ${n} ${'x'.repeat(120)}`, 'Phone', at), at);
  }
  const read = describeItem(long);
  assert.match(read, /Comment 79/);
  assert.doesNotMatch(read, /Comment 0 /);
  // A doc's review goes too.
  assert.match(describeItem({ ...base, decision: 'changes', feedback: 'Add error codes.' }), /My review: changes\nAdd error codes\./);
});
