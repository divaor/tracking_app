// Files on items: bytes in both stores (GitHub, the data on this device), moved between them
// unchanged, and what kind each file is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFakeGitHub } from './helpers/fake-git-data.js';
import { base64ToBytes, bytesToBase64, createGitHubClient, decodeBase64, encodeBase64 } from '../app/js/github.js';
import { blobSha, createLocalRepo, memoryBackend } from '../app/js/localRepo.js';
import { moveData } from '../app/js/moveData.js';
import { attachmentKind, cleanFiles, createItem, filesFolder, freeFilePath, isTextAttachment, mimeOf, parseData, serializeDocument } from '../app/js/model.js';

// Bytes no text decoder keeps: a PNG's signature, NULs, invalid UTF-8.
const PICTURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x81]);
const gitSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
let clock = Date.parse('2026-10-30T09:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

test('base64 both ways: bytes, and text through them', () => {
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(PICTURE))), Array.from(PICTURE));
  assert.equal(decodeBase64(encodeBase64('canción ✓')), 'canción ✓');
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big, 'longer than one chunk');
});

test('blobSha of bytes is git’s', async () => {
  assert.equal(await blobSha(PICTURE), gitSha(PICTURE));
  assert.equal(await blobSha('hello'), gitSha(Buffer.from('hello')));
});

test('the data on this device keeps bytes as they are (bin/), and text as before', async () => {
  const backend = memoryBackend();
  const repo = createLocalRepo(backend, { now: tick });
  const put = await repo.putFileBytes('files/2026-10-30-leak-abcdef/leak.png', { bytes: PICTURE, message: 'attach' });
  assert.equal(put.sha, gitSha(PICTURE), 'the same sha as GitHub gives');
  assert.ok(await backend.get(`bin/${put.sha}`), 'kept under bin/');
  assert.equal(await backend.get(`blob/${put.sha}`), null);
  assert.deepEqual(Array.from((await repo.getFileBytes('files/2026-10-30-leak-abcdef/leak.png')).bytes), Array.from(PICTURE));
  assert.deepEqual(Array.from(await repo.getBlobBytes(put.sha)), Array.from(PICTURE));
  // A text file's bytes too, and a picture already there is not written twice.
  await repo.putFile('files/a.md', { text: '# A ✓', message: 'doc' });
  assert.equal(new TextDecoder().decode((await repo.getFileBytes('files/a.md')).bytes), '# A ✓');
  assert.equal(await repo.getFileBytes('files/missing.png'), null);
  // Replacing needs the sha it replaces.
  await assert.rejects(repo.putFileBytes('files/2026-10-30-leak-abcdef/leak.png', { bytes: PICTURE, message: 'again' }), (e) => e.status === 422);
  // Trees can point at a picture's version (as the editor's sync does when it carries files along).
  const sha = await repo.createBlobBytes(PICTURE);
  const tree = await repo.createTree(null, [{ path: 'copy.png', sha }]);
  assert.ok(tree);
  // Pruning keeps what is in use, bin/ included.
  const { removed } = await repo.prune({ nowMs: Date.parse('2027-12-01T00:00:00Z') });
  assert.ok(removed >= 0);
  assert.deepEqual(Array.from((await repo.getFileBytes('files/2026-10-30-leak-abcdef/leak.png')).bytes), Array.from(PICTURE));
});

test('pruning lets go of pictures no version uses any more', async () => {
  const backend = memoryBackend(() => Date.parse('2026-01-01T00:00:00Z'));
  const repo = createLocalRepo(backend, { now: () => '2026-01-01T00:00:00.000Z' });
  const orphan = await repo.createBlobBytes(Uint8Array.from([1, 2, 3, 0, 255]));
  assert.ok(await backend.get(`bin/${orphan}`));
  await repo.putFile('tracker.json', { text: '{}', message: 'data' });
  await repo.prune({ nowMs: Date.parse('2026-06-01T00:00:00Z') });
  assert.equal(await backend.get(`bin/${orphan}`), null);
});

test('GitHub: bytes up and down (Contents API and blobs)', async () => {
  const fake = createFakeGitHub();
  const github = createGitHubClient({ token: 'good-token', owner: 'me', repo: 'data', fetchImpl: fake.fetch, cacheMode: '' });
  const { sha } = await github.putFileBytes('files/x/leak.png', { bytes: PICTURE, message: 'attach' });
  assert.equal(sha, gitSha(PICTURE));
  assert.deepEqual(Array.from(fake.readBytes('files/x/leak.png')), Array.from(PICTURE));
  assert.deepEqual(Array.from(await github.getBlobBytes(sha)), Array.from(PICTURE));
  const file = await github.getFileBytes('files/x/leak.png');
  assert.equal(file.sha, sha);
  assert.deepEqual(Array.from(file.bytes), Array.from(PICTURE));
  assert.equal(await github.getFileBytes('files/x/missing.png'), null);
});

test('moving the data copies pictures as bytes, both ways', async () => {
  const mergeTracker = (theirs, ours) => {
    const a = parseData(theirs);
    const b = parseData(ours);
    return serializeDocument([...a.items, ...b.items.filter((i) => !a.items.some((x) => x.id === i.id))], []);
  };
  const local = createLocalRepo(memoryBackend(), { now: tick });
  await local.putFile('tracker.json', { text: serializeDocument([createItem({ title: 'Leak' }, tick())], []), message: 'data' });
  await local.putFileBytes('files/2026-10-30-leak-abcdef/leak.png', { bytes: PICTURE, message: 'attach' });
  await local.putFile('files/2026-10-30-leak-abcdef/notes.md', { text: '﻿# Notes with a BOM', message: 'doc' });
  const fake = createFakeGitHub();
  const github = createGitHubClient({ token: 'good-token', owner: 'me', repo: 'data', fetchImpl: fake.fetch, cacheMode: '' });
  const moved = await moveData({ from: local, to: github, mergeTracker });
  assert.equal(moved.copied, 2);
  assert.deepEqual(Array.from(fake.readBytes('files/2026-10-30-leak-abcdef/leak.png')), Array.from(PICTURE), 'the picture unchanged');
  assert.equal(fake.read('files/2026-10-30-leak-abcdef/notes.md'), '﻿# Notes with a BOM', 'text as it was, its BOM kept');
  // And back to a new device, through trees (the local store takes them).
  const other = createLocalRepo(memoryBackend(), { now: tick });
  await moveData({ from: github, to: other, mergeTracker });
  assert.deepEqual(Array.from((await other.getFileBytes('files/2026-10-30-leak-abcdef/leak.png')).bytes), Array.from(PICTURE));
  assert.equal((await other.getFile('files/2026-10-30-leak-abcdef/notes.md')).text, '﻿# Notes with a BOM');
});

test('what kind a file is, its type, and that text stays text', () => {
  assert.equal(attachmentKind({ name: 'Leak.JPG' }), 'image');
  assert.equal(attachmentKind({ name: 'quote.pdf' }), 'pdf');
  assert.equal(attachmentKind({ name: 'budget.xlsx' }), 'document');
  assert.equal(attachmentKind({ name: 'call.m4a' }), 'media');
  assert.equal(attachmentKind({ name: 'site.zip' }), 'archive');
  assert.equal(attachmentKind({ name: 'setup.exe' }), 'binary');
  assert.equal(attachmentKind({ name: 'proposal.md' }), 'text');
  assert.equal(attachmentKind({ name: 'data.bin2', binary: true }), 'binary', 'bytes that are not text, whatever the name');
  assert.equal(attachmentKind({ path: 'files/x/README' }), 'text');
  assert.ok(isTextAttachment({ name: 'logo.svg' }), 'an SVG picture is text too');
  assert.ok(!isTextAttachment({ name: 'leak.png' }));
  assert.equal(mimeOf({ name: 'leak.png' }), 'image/png');
  assert.equal(mimeOf({ name: 'x.heic', type: 'image/heic' }), 'image/heic');
  assert.equal(mimeOf({ name: 'notes.txt' }), 'text/plain');
  assert.equal(mimeOf({ name: 'thing.qqq', binary: true }), 'application/octet-stream');
});

test('file records keep their type and binary mark (and only when set)', () => {
  const [a, b] = cleanFiles([
    { path: 'files/x/a.png', name: 'a.png', size: 3, sha: 'abc', type: 'image/png' },
    { path: 'files/x/b.dat', name: 'b.dat', size: 3, sha: 'def', binary: true, type: 'not a type' },
  ]);
  assert.equal(a.type, 'image/png');
  assert.equal('binary' in a, false);
  assert.equal(b.binary, true);
  assert.equal('type' in b, false, 'a type that is not a MIME type is dropped');
});

test('where an item’s files go: its folder, names that do not clash', () => {
  const item = { id: 'mvu8fw93-7ddb8811a897aa77', title: 'Kitchen leak!', files: [] };
  assert.equal(filesFolder(item, 'files', '2026-10-30'), 'files/2026-10-30-kitchen-leak-97aa77');
  const withFiles = { ...item, files: [{ path: 'files/2026-10-01-older-folder-97aa77/report.md' }] };
  assert.equal(filesFolder(withFiles, 'files', '2026-10-30'), 'files/2026-10-01-older-folder-97aa77', 'where it has some');
  const taken = new Set(['files/f/photo.jpg', 'files/f/photo-2.jpg']);
  assert.equal(freeFilePath('files/f', 'photo.jpg', taken), 'files/f/photo-3.jpg');
  assert.equal(freeFilePath('files/f', 'My photo (1).jpg', new Set()), 'files/f/My-photo-1.jpg');
  assert.equal(freeFilePath('files/f', '../../etc/passwd', new Set()), 'files/f/passwd', 'never out of the folder');
});
