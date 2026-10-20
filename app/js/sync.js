// One sync round against the data file in GitHub: pull, merge, push.
import { diffCounts, mergeItems, nowIso, parseDocument, pruneTombstones, serializeDocument } from './model.js';

function commitMessage(device, counts, created) {
  if (created) return `Tracker: create data file (from ${device})`;
  const parts = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  return `Tracker: sync from ${device}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const isWriteConflict = (err) => err?.status === 409 || err?.status === 422;

/**
 * Merges `localItems` with the file at `path` and writes the result back when
 * it differs. Retries when another device wrote in between (sha mismatch).
 * Never overwrites a remote file it cannot parse.
 */
export async function syncOnce({ client, path, branch, localItems, device = 'unknown device', now = nowIso, maxAttempts = 4 }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remote = await client.getFile(path, branch || undefined);
    const remoteItems = remote ? parseDocument(remote.text) : [];
    const merged = pruneTombstones(mergeItems(remoteItems, localItems), now());
    const textOut = serializeDocument(merged);

    if (remote && textOut === serializeDocument(remoteItems)) {
      return { items: merged, sha: remote.sha, pushed: false, counts: { added: 0, updated: 0, deleted: 0 } };
    }

    if (!remote && branch) await client.ensureBranch(branch);
    const counts = diffCounts(remoteItems, merged);
    try {
      const res = await client.putFile(path, {
        text: textOut,
        sha: remote?.sha,
        branch: branch || undefined,
        message: commitMessage(device, counts, !remote),
      });
      return { items: merged, sha: res.sha, pushed: true, counts };
    } catch (err) {
      if (!isWriteConflict(err) || attempt === maxAttempts) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
