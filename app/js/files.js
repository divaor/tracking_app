// Loads files attached to items (stored in the data repo). Contents are
// cached by blob sha, so each version is downloaded once per device.
import { createGitHubClient } from './github.js';
import { kvGet, kvSet } from './kv.js';
import { getSettings, getToken, isSyncConfigured } from './settings.js';

export async function loadFileText(file) {
  const key = file.sha ? `file:${file.sha}` : '';
  if (key) {
    const cached = await kvGet(key);
    if (typeof cached === 'string') return cached;
  }
  const settings = getSettings();
  const token = await getToken();
  if (!isSyncConfigured(settings) || !token) throw new Error('Set up GitHub sync in Settings to open attached files.');
  const client = createGitHubClient({ token, owner: settings.owner, repo: settings.repo });
  const result = await client.getFile(file.path, settings.branch || undefined);
  if (!result) throw new Error(`${file.name} is not in ${settings.owner}/${settings.repo} (yet). Try syncing.`);
  kvSet(`file:${result.sha}`, result.text).catch(() => {});
  return result.text;
}

// Writes an edited file back (ticked checklists) and returns its new sha.
// Sending the sha it was loaded at means a version changed elsewhere in the
// meantime is never overwritten: GitHub answers 409 or 422 instead.
export async function saveFileText(file, text) {
  const settings = getSettings();
  const token = await getToken();
  if (!isSyncConfigured(settings) || !token) throw new Error('Set up GitHub sync in Settings to save changes to attached files.');
  const client = createGitHubClient({ token, owner: settings.owner, repo: settings.repo });
  const { sha } = await client.putFile(file.path, {
    text,
    sha: file.sha,
    branch: settings.branch || undefined,
    message: `Tracker: update ${file.name} (from ${settings.device || 'unknown device'})`,
  });
  kvSet(`file:${sha}`, text).catch(() => {});
  return sha;
}
