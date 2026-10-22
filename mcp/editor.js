// Tracker Editor files for the connector. The editor keeps its files in the
// same data repo as the tracker: editor/index.json lists them, and the text of
// each is in editor/files/<id>/<name>. Kept in step with the editor's
// app/js/model.js (github.com/divaor/tracker-editor): same paths, record fields
// and merge rule (newest updatedAt wins; the text is tracked by its blob sha).
import { editorLink } from '../app/js/editorLinks.js';
import { bumpTime, cleanProjectName, cleanTags, formatBytes, newId, nowIso } from '../app/js/model.js';

export const EDITOR_DIR = 'editor';
export const EDITOR_INDEX = `${EDITOR_DIR}/index.json`;
const FILES_DIR = `${EDITOR_DIR}/files`;
// Files the editor encrypts end to end start with this line; the connector cannot read them.
export const ENCRYPTED_MARK = 'TRACKER-EDITOR-ENCRYPTED v1';
const SEARCH_FILES = 60; // files read per search, most recently changed first
const SEARCH_MAX_BYTES = 300 * 1024;
const SEARCH_MAX_MATCHES = 40;
const SEARCH_LINES_PER_FILE = 5;
const MAX_ATTEMPTS = 4;
const EPOCH = '1970-01-01T00:00:00.000Z';
const INDEX_KEYS = ['app', 'schema', 'updatedAt', 'files'];

export class EditorError extends Error {}

const isConflict = (err) => err?.status === 409 || err?.status === 422;
const byteLength = (s) => new TextEncoder().encode(s).length;
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Same as the editor's safeName: a name that is safe as the last part of a repo path. */
export function safeName(name, fallback = 'untitled.txt') {
  const clean = text(name)
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

export const contentPath = (file) => `${FILES_DIR}/${file.id}/${safeName(file.name)}`;

export function serializeEditorIndex(files, extra = {}) {
  const sorted = [...files].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const updatedAt = sorted.reduce((max, f) => (f.updatedAt > max ? f.updatedAt : max), EPOCH);
  const rest = Object.fromEntries(Object.entries(extra).filter(([k]) => !INDEX_KEYS.includes(k)));
  return `${JSON.stringify({ app: 'tracker-editor', schema: 1, updatedAt, ...rest, files: sorted }, null, 2)}\n`;
}

const isEncrypted = (record, content = '') => Boolean(record.encrypted) || content.startsWith(ENCRYPTED_MARK);
const encryptedMessage = (record) =>
  `“${record.name}” is end-to-end encrypted. Only the Tracker Editor app can read it, with the user's passphrase; open it there.`;

/**
 * `canonicalProject(name)` resolves a project name to the tracker's existing
 * spelling. `maxReadChars` pages long files like the tracker's read_file.
 * Links go to `editorUrl` (blank: the default address).
 */
export function createEditorFiles({ client, branch = '', device = 'Claude', editorUrl = '', now = nowIso, canonicalProject = async (n) => n, maxReadChars = 90_000, maxFileBytes = 2 * 1024 * 1024 }) {
  const ref = branch || undefined;
  const link = (id) => editorLink({ kind: 'file', id }, { editorUrl });

  async function loadIndex() {
    const file = await client.getFile(EDITOR_INDEX, ref);
    if (!file) return { sha: undefined, files: [], extra: {} };
    let data;
    try {
      data = JSON.parse(file.text);
    } catch (err) {
      throw new EditorError(`The editor's index (${EDITOR_INDEX}) is not valid JSON, so it was left alone (${err.message}).`);
    }
    if (!data || !Array.isArray(data.files)) throw new EditorError(`The editor's index (${EDITOR_INDEX}) has no "files" list, so it was left alone.`);
    return {
      sha: file.sha,
      files: data.files.filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && f.id),
      extra: Object.fromEntries(Object.entries(data).filter(([k]) => !INDEX_KEYS.includes(k))),
    };
  }

  const live = (files) => files.filter((f) => !f.deleted);
  const newest = (files) => [...files].sort((a, b) => cmp(b.modifiedAt ?? '', a.modifiedAt ?? '') || cmp(b.updatedAt ?? '', a.updatedAt ?? ''));

  const summary = (f) => {
    const out = { id: f.id, name: f.name };
    if (f.project) out.project = f.project;
    if (f.tags?.length) out.tags = f.tags;
    if (f.language) out.language = f.language;
    out.size = formatBytes(f.size ?? 0);
    out.modifiedAt = f.modifiedAt;
    if (f.modifiedBy) out.modifiedBy = f.modifiedBy;
    if (f.encrypted) out.encrypted = true;
    out.link = link(f.id);
    return out;
  };

  // A live file by id, or by its exact name (case-insensitive) when that is unambiguous.
  function resolve(files, key) {
    const wanted = text(key).trim();
    if (!wanted) throw new EditorError('An editor file id or name is required.');
    const byId = files.find((f) => f.id === wanted);
    if (byId?.deleted) throw new EditorError(`“${byId.name}” was deleted in the editor.`);
    if (byId) return byId;
    const byName = live(files).filter((f) => text(f.name).toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new EditorError(`Several editor files are named “${wanted}”; use the id instead (${byName.map((f) => f.id).join(', ')}).`);
    throw new EditorError(`No editor file with id or name “${wanted}”. Use list_editor_files to find it.`);
  }

  const notUploaded = (record) => new EditorError(`The text of “${record.name}” is not in the repo yet; the editor uploads it on its next sync.`);

  return {
    async list({ query = '', project, tag, limit = 50 } = {}) {
      const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
      const wantedTag = text(tag).replace(/^#/, '').toLowerCase();
      const wantedProject = text(project).trim().toLowerCase();
      const files = newest(live((await loadIndex()).files)).filter(
        (f) =>
          (!wantedProject || text(f.project).toLowerCase() === wantedProject) &&
          (!wantedTag || (f.tags ?? []).some((t) => t.toLowerCase() === wantedTag)) &&
          terms.every((term) => [f.name, f.project, ...(f.tags ?? [])].join('\n').toLowerCase().includes(term)),
      );
      const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return { total: files.length, shown: Math.min(max, files.length), files: files.slice(0, max).map(summary) };
    },

    async read(key, offset = 0) {
      const record = resolve((await loadIndex()).files, key);
      if (isEncrypted(record)) return { ...summary(record), encrypted: true, message: encryptedMessage(record) };
      const file = await client.getFile(contentPath(record), ref);
      if (!file) throw notUploaded(record);
      if (isEncrypted(record, file.text)) return { ...summary(record), encrypted: true, message: encryptedMessage(record) };
      const start = Math.min(Math.max(Number(offset) || 0, 0), file.text.length);
      const content = file.text.slice(start, start + maxReadChars);
      const end = start + content.length;
      return { ...summary(record), totalChars: file.text.length, offset: start, nextOffset: end < file.text.length ? end : undefined, content };
    },

    async search({ query, limit = SEARCH_MAX_MATCHES } = {}) {
      const needle = text(query).trim().toLowerCase();
      if (!needle) throw new EditorError('Give the words to search for.');
      const all = newest(live((await loadIndex()).files));
      const readable = all.filter((f) => !f.encrypted && (f.size ?? 0) <= SEARCH_MAX_BYTES);
      const scanned = readable.slice(0, SEARCH_FILES);
      const max = Math.min(Math.max(Number(limit) || SEARCH_MAX_MATCHES, 1), 100);
      const named = (f) => [f.name, f.project, ...(f.tags ?? [])].join(' ').toLowerCase().includes(needle);
      const matches = [];
      let lines = 0;
      for (let i = 0; i < scanned.length && lines < max; i += 6) {
        const batch = await Promise.all(scanned.slice(i, i + 6).map((f) => client.getFile(contentPath(f), ref).then((file) => [f, file], () => [f, null])));
        for (const [f, file] of batch) {
          if (lines >= max) break;
          if (!file || isEncrypted(f, file.text)) {
            if (named(f)) matches.push({ ...summary(f), lines: [] });
            continue;
          }
          const hits = [];
          file.text.split('\n').forEach((line, n) => {
            const at = line.toLowerCase().indexOf(needle);
            if (at === -1 || hits.length >= SEARCH_LINES_PER_FILE || lines + hits.length >= max) return;
            const from = Math.max(0, at - 60);
            hits.push({ line: n + 1, text: `${from ? '…' : ''}${line.slice(from, at + needle.length + 100).trim()}${at + needle.length + 100 < line.length ? '…' : ''}` });
          });
          if (hits.length || named(f)) {
            matches.push({ ...summary(f), lines: hits });
            lines += hits.length;
          }
        }
      }
      // Files whose text was not searched still show up when their name, project or tag matches.
      const covered = new Set(scanned.map((f) => f.id));
      for (const f of all) if (!covered.has(f.id) && matches.length < SEARCH_FILES && named(f)) matches.push({ ...summary(f), lines: [] });
      const skipped = all.length - readable.length;
      const notes = [];
      if (readable.length > scanned.length) notes.push(`Searched the ${scanned.length} most recently changed of ${readable.length} files; ask for something more specific, or use list_editor_files and read_editor_file for older ones.`);
      if (lines >= max) notes.push(`Stopped at ${max} matching lines.`);
      if (skipped) notes.push(`${skipped} file${skipped === 1 ? ' was' : 's were'} not searched (end-to-end encrypted or over ${formatBytes(SEARCH_MAX_BYTES)}).`);
      return { query: text(query), files: matches, searched: scanned.length, note: notes.join(' ') || undefined };
    },

    /**
     * Creates a file (no id: name and content required) or changes one: its
     * text, name, project or tags. The text goes in first, then the index,
     * which is retried when another device wrote it in between.
     */
    async save({ id, name, content, project, tags } = {}) {
      const hasContent = content !== undefined && content !== null;
      const body = hasContent ? text(content) : '';
      if (hasContent && byteLength(body) > maxFileBytes) throw new EditorError(`The text is ${formatBytes(byteLength(body))}; the limit is ${formatBytes(maxFileBytes)}.`);
      const newName = text(name).trim() ? safeName(name) : '';
      if (!id && !newName) throw new EditorError('A name (with an extension, e.g. notes.md) is required for a new editor file.');
      if (!id && !hasContent) throw new EditorError('content is required for a new editor file: pass its full text.');
      const projectName = project === undefined || project === null ? undefined : await canonicalProject(cleanProjectName(project));
      const tagList = tags === undefined || tags === null ? undefined : cleanTags(tags);
      const freshId = id ? '' : newId();
      let before; // the file's text when this save started (null: none)
      let written = null; // the text this save already put in the repo: { path, body, sha }

      for (let attempt = 1; ; attempt++) {
        const index = await loadIndex();
        const at = now();
        const current = id ? resolve(index.files, id) : null;
        if (!index.sha && branch && attempt === 1) await client.ensureBranch(branch);
        const refuse = () => new EditorError(`${encryptedMessage(current)} It was not changed.`);
        if (current && isEncrypted(current)) throw refuse();
        const rename = Boolean(current && newName && newName !== current.name);
        let record;
        if (!current) {
          record = { id: freshId, name: newName, project: projectName ?? '', tags: tagList ?? [], language: '', sha: '', size: 0, modifiedAt: at, modifiedBy: device, createdAt: at, updatedAt: at, updatedBy: device };
        } else {
          record = { ...current };
          if (rename || projectName !== undefined || tagList !== undefined) {
            if (rename) record.name = newName;
            if (projectName !== undefined) record.project = projectName;
            if (tagList !== undefined) record.tags = tagList;
            record.updatedAt = bumpTime(current.updatedAt, at);
            record.updatedBy = device;
          }
        }

        const path = contentPath(record);
        const old = current ? await client.getFile(contentPath(current), ref) : null;
        if (current && old && isEncrypted(current, old.text)) throw refuse();
        if (before === undefined) before = old ? old.text : null;
        // The text: new, changed, or moved to the renamed path.
        if (!current || hasContent || rename) {
          if (!old && !hasContent) throw notUploaded(current);
          const next = hasContent ? body : old.text;
          if (written?.path !== path || written.body !== next) {
            const there = current && path === contentPath(current) ? old : await client.getFile(path, ref);
            const sha =
              there && there.text === next
                ? there.sha
                : (await client.putFile(path, { text: next, sha: there?.sha, branch: ref, message: `Editor: ${current ? 'update' : 'add'} “${record.name}” (via ${device})` })).sha ?? '';
            written = { path, body: next, sha };
          }
          record.sha = written.sha;
          if (before !== next) {
            record.size = byteLength(next);
            record.modifiedAt = current ? bumpTime(current.modifiedAt ?? EPOCH, at) : at;
            record.modifiedBy = device;
          }
        }

        const files = current ? index.files.map((f) => (f.id === current.id ? record : f)) : [...index.files, record];
        try {
          await client.putFile(EDITOR_INDEX, { text: serializeEditorIndex(files, index.extra), sha: index.sha, branch: ref, message: `Editor: ${current ? 'update' : 'add'} “${record.name}” (via ${device})` });
        } catch (err) {
          if (!isConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
          continue;
        }
        if (rename) {
          const stale = await client.getFile(contentPath(current), ref);
          if (stale) await client.deleteFile(contentPath(current), { sha: stale.sha, branch: ref, message: `Editor: rename “${current.name}” to “${record.name}” (via ${device})` }).catch(() => {});
        }
        return { created: !current, file: summary(record), path };
      }
    },
  };
}
