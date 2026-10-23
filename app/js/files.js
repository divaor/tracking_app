// Loads files attached to items (stored in the data repo, or in local mode in the
// data on this device). Contents are cached by blob sha, so each version is
// downloaded once per device.
import { kvGet, kvSet } from './kv.js';
import { getSettings } from './settings.js';
import { dataClient } from './syncManager.js';

export async function loadFileText(file) {
  const key = file.sha ? `file:${file.sha}` : '';
  if (key) {
    const cached = await kvGet(key);
    if (typeof cached === 'string') return cached;
  }
  const { client, branch, local } = await dataClient();
  const result = await client.getFile(file.path, branch || undefined);
  if (!result) {
    const settings = getSettings();
    throw new Error(local ? `${file.name} is not in the data on this computer (yet).` : `${file.name} is not in ${settings.owner}/${settings.repo} (yet). Try syncing.`);
  }
  kvSet(`file:${result.sha}`, result.text).catch(() => {});
  return result.text;
}

// Writes an edited file back (ticked checklists) and returns its new sha.
// Sending the sha it was loaded at means a version changed elsewhere in the
// meantime is never overwritten: the store answers 409 or 422 instead.
export async function saveFileText(file, text) {
  const settings = getSettings();
  const { client, branch } = await dataClient();
  const { sha } = await client.putFile(file.path, {
    text,
    sha: file.sha,
    branch: branch || undefined,
    message: `Tracker: update ${file.name} (from ${settings.device || 'unknown device'})`,
  });
  kvSet(`file:${sha}`, text).catch(() => {});
  return sha;
}
