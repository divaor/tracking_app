// One sync round against the data file in GitHub: pull, merge, push.
import { diffCounts, mergeItems, mergeProjects, nowIso, parseData, pruneTombstones, serializeDocument } from './model.js';

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
export async function syncOnce({ client, path, branch, localItems, localProjects = [], device = 'unknown device', now = nowIso, maxAttempts = 4 }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remote = await client.getFile(path, branch || undefined);
    const data = remote ? parseData(remote.text) : { items: [], projects: [], extra: {} };
    const remoteItems = data.items;
    const merged = pruneTombstones(mergeItems(remoteItems, localItems), now());
    const projects = pruneTombstones(mergeProjects(data.projects, localProjects), now());
    const textOut = serializeDocument(merged, projects, data.extra);

    if (remote && textOut === serializeDocument(remoteItems, data.projects, data.extra)) {
      return { items: merged, projects, sha: remote.sha, pushed: false, counts: { added: 0, updated: 0, deleted: 0 } };
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
      return { items: merged, projects, sha: res.sha, pushed: true, counts };
    } catch (err) {
      if (!isWriteConflict(err) || attempt === maxAttempts) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
