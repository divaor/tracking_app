// Moving the data between this device and GitHub ("Sync across your devices with
// GitHub…", and back): what the other side lacks is copied there first (files,
// tracker attachments, the encryption vault), and tracker.json is merged item by
// item; each app's own sync takes over after. Nothing is deleted on either side,
// so a move can be made again safely. Pure, so the Node tests can import it. The
// tracker and the editor keep the same copy of this file.

// Kept by each app's sync from its own records: never copied over the other side's.
const MERGED_BY_SYNC = ['editor/index.json'];

/**
 * Copies `from` into `to` (github.js or localRepo.js clients). `mergeTracker(theirs,
 * ours)` returns tracker.json's merged text (it throws when theirs cannot be read,
 * so it is never overwritten). Returns { copied, tracker } (what changed on `to`).
 */
export async function moveData({ from, to, fromBranch = '', toBranch = '', trackerPath = 'tracker.json', fromTrackerPath = trackerPath, toTrackerPath = trackerPath, mergeTracker, device = 'this device', onProgress = () => {} }) {
  const ours = await from.listTree(fromBranch || undefined);
  const theirs = new Map((await to.listTree(toBranch || undefined)).map((e) => [e.path, e.sha]));
  const changes = [];
  for (const { path, sha } of ours) {
    if (MERGED_BY_SYNC.includes(path) || path === fromTrackerPath || path === toTrackerPath) continue;
    // There already (the same text, or one changed there: its own history keeps both).
    if (theirs.has(path)) continue;
    changes.push({ path, content: await from.getBlobText(sha) });
    onProgress(changes.length);
  }
  let tracker = false;
  const local = ours.find((e) => e.path === fromTrackerPath);
  if (local) {
    const text = await from.getBlobText(local.sha);
    const there = theirs.has(toTrackerPath) ? await to.getFile(toTrackerPath, toBranch || undefined) : null;
    const merged = there ? mergeTracker(there.text, text) : text;
    if (!there || merged !== there.text) {
      changes.push({ path: toTrackerPath, content: merged, sha: there?.sha });
      tracker = true;
    }
  }
  if (changes.length) await write(to, toBranch, changes, `Moved here from ${from.local ? 'the data on' : 'GitHub, from'} ${device}`);
  return { copied: changes.length - (tracker ? 1 : 0), tracker };
}

// One commit when the target takes trees (Git Data API), else file by file.
async function write(client, branch, changes, message) {
  if (client.createTree) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const name = branch || (await client.getRepo()).default_branch;
      let tip = await client.getBranchHead(name);
      let rest = changes;
      if (!tip) {
        // An empty repository: its first commit goes through the Contents API.
        const [first, ...others] = changes;
        await client.putFile(first.path, { text: first.content, branch: branch || undefined, message });
        tip = await client.getBranchHead(name);
        rest = others;
        if (!rest.length) return;
      }
      const tree = await client.createTree(await client.getCommitTree(tip), rest.map(({ path, content }) => ({ path, content })));
      const commit = await client.createCommit(message, tree, [tip]);
      try {
        await client.updateBranch(name, commit);
        return;
      } catch (err) {
        if (err?.status !== 422 && err?.status !== 409) throw err;
      }
    }
    throw new Error('The data kept changing while it was being moved; try again.');
  }
  for (const { path, content, sha } of changes) await client.putFile(path, { text: content, sha, branch: branch || undefined, message });
}
