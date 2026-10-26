// Tracker operations used by the MCP tools. Reads and writes the same data
// file as the app (through the shared model), plus attached files stored in
// the data repo. Every write is a commit; conflicting writes are retried.
import { describeChanges } from '../app/js/changes.js';
import { createEditorFiles } from './editor.js';
import {
  addCommentPatch,
  addDays,
  applyPatch,
  AREAS,
  awaitsClaude,
  CLAUDE_AUTHOR,
  cleanProjectName,
  cleanTags,
  createItem,
  DECISIONS,
  deleteProjectIn,
  formatBytes,
  KINDS,
  kindLabel,
  liveComments,
  normalizeItem,
  nowIso,
  parseData,
  pinnedFirst,
  PRIORITIES,
  projectKey,
  projectList,
  renameProjectIn,
  resolveProjectName,
  safeFileName,
  serializeDocument,
  slugify,
  sortItems,
  STATUSES,
  statusLabel,
  tagCounts,
  tombstone,
  TYPE_IDS,
  upsertProjectRecord,
} from '../app/js/model.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Keeps results well inside Claude's tool-output limits; read_file pages through longer files.
export const MAX_READ_CHARS = 90_000;
const MAX_ATTEMPTS = 4;

export class TrackerError extends Error {}

const isConflict = (err) => err?.status === 409 || err?.status === 422;
const byteLength = (s) => new TextEncoder().encode(s).length;
const has = (obj, key) => obj[key] !== undefined && obj[key] !== null;

const EDITABLE = ['type', 'title', 'status', 'priority', 'kind', 'project', 'url', 'due', 'notes', 'decision', 'feedback', 'pinned'];

function checkFields(fields, type) {
  if (has(fields, 'type') && !TYPE_IDS.includes(fields.type)) throw new TrackerError(`type must be one of ${TYPE_IDS.join(', ')}`);
  if (has(fields, 'status') && !STATUSES.includes(fields.status)) throw new TrackerError(`status must be one of ${STATUSES.join(', ')}`);
  if (has(fields, 'priority') && !PRIORITIES.some((p) => p.id === fields.priority)) {
    throw new TrackerError(`priority must be one of ${PRIORITIES.map((p) => p.id).join(', ')}`);
  }
  if (has(fields, 'decision') && fields.decision !== '' && !DECISIONS.some((d) => d.id === fields.decision)) {
    throw new TrackerError(`decision must be one of ${DECISIONS.map((d) => d.id).join(', ')} or "" to clear it`);
  }
  if (has(fields, 'due') && fields.due !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(fields.due)) throw new TrackerError('due must be YYYY-MM-DD or "" to clear it');
  if (has(fields, 'pinned') && typeof fields.pinned !== 'boolean') throw new TrackerError('pinned must be true or false');
  const kinds = KINDS[fields.type ?? type];
  if (has(fields, 'kind') && fields.kind !== '' && !kinds?.some((k) => k.id === fields.kind)) {
    throw new TrackerError(kinds ? `kind for ${fields.type ?? type} must be one of ${kinds.map((k) => k.id).join(', ')}` : `items of type ${fields.type ?? type} have no kind`);
  }
}

function pickFields(input) {
  const out = {};
  for (const key of EDITABLE) if (has(input, key)) out[key] = input[key];
  if (has(input, 'tags')) out.tags = cleanTags(input.tags);
  return out;
}

export function summarize(item) {
  const out = { id: item.id, type: item.type, title: item.title, status: item.status };
  if (item.kind) out.kind = item.kind;
  if (item.priority !== 'normal') out.priority = item.priority;
  if (item.due) out.due = item.due;
  if (item.project) out.project = item.project;
  if (item.tags.length) out.tags = item.tags;
  if (item.url) out.url = item.url;
  if (item.decision) out.decision = item.decision;
  if (item.pinned) out.pinned = true;
  if (item.files.length) out.files = item.files.map((f) => f.path);
  const comments = liveComments(item).length;
  if (comments) out.comments = comments;
  if (awaitsClaude(item)) out.awaitingReply = true;
  out.updatedAt = item.updatedAt;
  return out;
}

// Comments as Claude reads them: who (Claude or the user, with the device), when, the text.
const commentView = (c) => ({
  by: c.by === CLAUDE_AUTHOR ? 'Claude' : 'user',
  ...(c.by && c.by !== CLAUDE_AUTHOR ? { device: c.by } : {}),
  at: c.at,
  ...(c.edited ? { edited: c.editedAt } : {}),
  text: c.text,
});
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// `onChange` receives notification events (see app/js/changes.js) after each
// successful write; the server uses it to send push notifications.
export function createTracker({ client, path = 'tracker.json', branch = '', filesDir = 'files', device = 'Claude', appUrl = '', editorUrl = '', now = nowIso, onChange = () => {} }) {
  const ref = branch || undefined;
  const dir = filesDir.replace(/^\/+|\/+$/g, '') || 'files';

  async function load() {
    const file = await client.getFile(path, ref);
    return { sha: file?.sha, ...(file ? parseData(file.text) : { items: [], projects: [], extra: {} }) };
  }

  // Applies `change` to the latest data and commits it. `change(items, data)`
  // returns the new item list, or { items, projects }, or null when there is
  // nothing to write. It may run again if another device wrote in between,
  // so it must not have side effects.
  async function commit(change, message) {
    for (let attempt = 1; ; attempt++) {
      const data = await load();
      const result = change(data.items, data);
      if (!result) return data.items;
      const next = Array.isArray(result) ? { items: result, projects: data.projects } : { items: result.items ?? data.items, projects: result.projects ?? data.projects };
      if (!data.sha && branch) await client.ensureBranch(branch);
      try {
        await client.putFile(path, { text: serializeDocument(next.items, next.projects, data.extra), sha: data.sha, branch: ref, message });
      } catch (err) {
        if (!isConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
        continue;
      }
      try {
        onChange(describeChanges(data.items, next.items));
      } catch {
        // notifications are best effort
      }
      return next.items;
    }
  }

  // Existing project spelling for `name` (projects are matched case-insensitively).
  const canonical = (name, data) => (name ? resolveProjectName(name, projectList(data.items, data.projects)) : name);

  async function writeFile(filePath, content, message) {
    const existing = await client.getFile(filePath, ref);
    const write = () => client.putFile(filePath, { text: content, sha: existing?.sha, branch: ref, message });
    try {
      return { ...(await write()), replaced: Boolean(existing) };
    } catch (err) {
      if (err.status !== 404 && err.status !== 422) throw err;
      if (!branch || !(await client.ensureBranch(branch))) throw err;
      return { ...(await write()), replaced: Boolean(existing) };
    }
  }

  const live = (items) => items.filter((i) => !i.deleted);

  // Finds an item by id, or by its exact title when that is unambiguous.
  function resolve(items, key) {
    const wanted = String(key ?? '').trim();
    if (!wanted) throw new TrackerError('An item id is required.');
    const alive = live(items);
    const byId = alive.find((i) => i.id === wanted);
    if (byId) return byId;
    const byTitle = alive.filter((i) => i.title.toLowerCase() === wanted.toLowerCase());
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) throw new TrackerError(`Several items are titled “${wanted}”; use the id instead (${byTitle.map((i) => i.id).join(', ')}).`);
    throw new TrackerError(`No item with id or title “${wanted}”. Use list_items to find it.`);
  }

  const link = (id) => (appUrl ? `${appUrl.replace(/#.*$/, '').replace(/\/?$/, '/')}#/item/${id}` : undefined);
  const withLink = (item) => ({ ...summarize(item), link: link(item.id) });

  return {
    // Tracker Editor files, in the same repo; projects use the tracker's spelling.
    editor: createEditorFiles({
      client,
      branch,
      device,
      editorUrl,
      now,
      canonicalProject: async (name) => (name ? canonical(name, await load()) : name),
      maxReadChars: MAX_READ_CHARS,
      maxFileBytes: MAX_FILE_BYTES,
    }),

    async overview() {
      const data = await load();
      const items = live(data.items);
      const today = now().slice(0, 10);
      const counts = {};
      for (const t of TYPE_IDS) {
        const ofType = items.filter((i) => i.type === t);
        counts[t] = Object.fromEntries(STATUSES.map((s) => [s, ofType.filter((i) => i.status === s).length]));
      }
      const open = items.filter((i) => i.status !== 'done');
      return {
        counts,
        // What the user keeps on top of each project, whatever its status.
        pinned: pinnedFirst(sortItems(items.filter((i) => i.pinned))).slice(0, 30).map(summarize),
        // The user's latest comment on each, newest first: read the rest with get_item, reply with update_items comment.
        commentsAwaiting: items
          .filter(awaitsClaude)
          .map((i) => ({ item: i, last: liveComments(i).at(-1) }))
          .sort((a, b) => (a.last.at < b.last.at ? 1 : -1))
          .slice(0, 20)
          .map(({ item, last }) => ({ ...summarize(item), lastComment: { ...commentView(last), text: clip(last.text, 400) } })),
        inProgress: sortItems(items.filter((i) => i.status === 'in_progress')).slice(0, 20).map(summarize),
        dueSoon: sortItems(open.filter((i) => i.due && i.due <= addDays(today, 7)), 'due').slice(0, 20).map(summarize),
        awaitingReview: sortItems(items.filter((i) => i.type === 'doc' && i.status !== 'done' && (i.files.length || ['proposal', 'artifact'].includes(i.kind))))
          .slice(0, 20)
          .map(summarize),
        recentDecisions: sortItems(items.filter((i) => i.decision), 'updated')
          .slice(0, 10)
          .map((i) => ({ ...summarize(i), feedback: i.feedback || undefined })),
        projects: projectList(data.items, data.projects)
          .filter((p) => p.open)
          .slice(0, 20)
          .map((p) => ({ name: p.name, area: p.area || undefined, open: p.open })),
      };
    },

    async listProjects() {
      const data = await load();
      return {
        projects: projectList(data.items, data.projects).map((p) => ({
          name: p.name,
          area: p.area || undefined,
          description: p.description || undefined,
          open: p.open,
          total: p.total,
        })),
        tags: tagCounts(data.items).map((t) => ({ tag: t.tag, count: t.count })),
      };
    },

    // Creates or updates a project; can also rename (moving its items) or delete it.
    async saveProject({ name, area, color, description, rename_to: renameTo, delete: remove = false } = {}) {
      const clean = cleanProjectName(name);
      if (!clean) throw new TrackerError('A project name is required.');
      if (has({ area }, 'area') && area !== '' && !AREAS.some((a) => a.id === area)) throw new TrackerError(`area must be one of ${AREAS.map((a) => a.id).join(', ')} or ""`);
      if (has({ color }, 'color') && color !== '' && !/^#[0-9a-f]{6}$/i.test(color)) throw new TrackerError('color must look like #4f46e5');
      const at = now();
      let summary = null;
      let moved = 0;
      await commit(
        (items, data) => {
          const known = projectList(data.items, data.projects).find((p) => p.key === projectKey(clean));
          const affected = items.filter((i) => !i.deleted && projectKey(i.project) === projectKey(clean)).length;
          if (remove) {
            if (!known) throw new TrackerError(`No project named “${clean}”.`);
            moved = affected;
            summary = { name: known.name, deleted: true };
            return deleteProjectIn(data, known.name, at, CLAUDE_AUTHOR);
          }
          let next = data;
          let current = known?.name ?? clean;
          if (renameTo && cleanProjectName(renameTo)) {
            next = renameProjectIn(next, current, cleanProjectName(renameTo), at, CLAUDE_AUTHOR);
            current = cleanProjectName(renameTo);
            moved = affected;
          }
          const patch = {};
          if (has({ area }, 'area')) patch.area = area;
          if (has({ color }, 'color')) patch.color = color;
          if (has({ description }, 'description')) patch.description = String(description);
          const projects = upsertProjectRecord(next.projects, current, patch, at, CLAUDE_AUTHOR);
          const saved = projects.find((p) => p.key === projectKey(current));
          summary = { name: saved.name, area: saved.area || undefined, description: saved.description || undefined };
          return { items: next.items, projects };
        },
        `Tracker: ${remove ? 'delete' : renameTo ? 'rename' : 'save'} project “${clean}” (via ${device})`,
      );
      return { project: summary, itemsMoved: moved || undefined };
    },

    async list({ type, status, query = '', tag, project, projects, area, kind, decision, pinned, comments, limit = 50 } = {}) {
      // Pinned and commented items are asked for whatever their status, unless one is given.
      status ??= pinned === true || comments ? 'all' : 'open';
      if (comments && !['unanswered', 'any'].includes(comments)) throw new TrackerError('comments must be "unanswered" or "any"');
      const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const data = await load();
      const areas = new Map(projectList(data.items, data.projects).map((p) => [p.key, p.area]));
      const wanted = [project, projects].flat().filter(Boolean).map(projectKey);
      const matches = live(data.items).filter(
        (i) =>
          (!type || type === 'all' || i.type === type) &&
          (status === 'all' || (status === 'open' ? i.status !== 'done' : i.status === status)) &&
          (!tag || i.tags.some((t) => t.toLowerCase() === String(tag).replace(/^#/, '').toLowerCase())) &&
          (!wanted.length || wanted.includes(projectKey(i.project))) &&
          (!area || (area === 'none' ? !i.project || !areas.get(projectKey(i.project)) : areas.get(projectKey(i.project)) === area)) &&
          (!kind || i.kind === kind) &&
          (!decision || (decision === 'none' ? !i.decision : i.decision === decision)) &&
          (typeof pinned !== 'boolean' || Boolean(i.pinned) === pinned) &&
          (!comments || (comments === 'unanswered' ? awaitsClaude(i) : liveComments(i).length > 0)) &&
          terms.every((term) =>
            [i.title, i.notes, i.feedback, i.project, i.url, ...i.tags, ...i.files.map((f) => f.name), ...liveComments(i).map((c) => c.text)].join('\n').toLowerCase().includes(term),
          ),
      );
      const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return { total: matches.length, shown: Math.min(max, matches.length), items: pinnedFirst(sortItems(matches)).slice(0, max).map(summarize) };
    },

    async get(id, { includeFiles = false } = {}) {
      const item = resolve((await load()).items, id);
      const result = { ...item, statusLabel: statusLabel(item.status, item.type), link: link(item.id) };
      // Only the comments that show, as Claude reads them.
      delete result.comments;
      const comments = liveComments(item);
      if (comments.length) {
        result.comments = comments.map(commentView);
        if (awaitsClaude(item)) result.awaitingReply = true;
      }
      if (includeFiles) {
        let budget = MAX_READ_CHARS;
        result.files = [];
        for (const f of item.files) {
          const file = await client.getFile(f.path, ref);
          if (!file) {
            result.files.push({ ...f, missing: true });
            continue;
          }
          const content = file.text.slice(0, Math.max(budget, 0));
          budget -= content.length;
          const truncated = content.length < file.text.length;
          result.files.push({ ...f, content, truncated: truncated ? `Showing ${content.length} of ${file.text.length} characters; use read_file with offset ${content.length} for the rest.` : undefined });
        }
      }
      return result;
    },

    async readFile(filePath, offset = 0) {
      const p = String(filePath ?? '').replace(/^\/+/, '');
      if (!p.startsWith(`${dir}/`) || p.split('/').includes('..')) throw new TrackerError(`Only files under ${dir}/ can be read. Use the paths listed in an item's files.`);
      const file = await client.getFile(p, ref);
      if (!file) throw new TrackerError(`File not found: ${p}`);
      const start = Math.min(Math.max(Number(offset) || 0, 0), file.text.length);
      const content = file.text.slice(start, start + MAX_READ_CHARS);
      const end = start + content.length;
      return {
        path: p,
        totalChars: file.text.length,
        offset: start,
        nextOffset: end < file.text.length ? end : undefined,
        content,
      };
    },

    async addItems(list) {
      if (!Array.isArray(list) || !list.length) throw new TrackerError('Provide at least one item.');
      const at = now();
      const created = list.map((input, n) => {
        const fields = pickFields(input);
        checkFields(fields, fields.type ?? 'task');
        if (!String(fields.title ?? '').trim()) throw new TrackerError(`Item ${n + 1} needs a title.`);
        return createItem({ type: 'task', ...fields, updatedBy: CLAUDE_AUTHOR }, at);
      });
      const label = created.length === 1 ? `“${created[0].title}”` : `${created.length} items`;
      let saved = created;
      await commit((items, data) => {
        saved = created.map((c) => (c.project ? { ...c, project: canonical(c.project, data) } : c));
        return [...items, ...saved];
      }, `Tracker: add ${label} (via ${device})`);
      return { added: saved.map(withLink) };
    },

    async updateItems(updates) {
      if (!Array.isArray(updates) || !updates.length) throw new TrackerError('Provide at least one update.');
      const at = now();
      let changed = [];
      const next = await commit((items, data) => {
        changed = [];
        const patches = new Map();
        for (const u of updates) {
          const item = resolve(items, u.id);
          const patch = pickFields(u);
          checkFields(patch, item.type);
          if (has(patch, 'project')) patch.project = canonical(patch.project, data);
          let tags = patch.tags ?? item.tags;
          if (u.add_tags) tags = cleanTags([...tags, ...cleanTags(u.add_tags)]);
          if (u.remove_tags) {
            const remove = new Set(cleanTags(u.remove_tags).map((t) => t.toLowerCase()));
            tags = tags.filter((t) => !remove.has(t.toLowerCase()));
          }
          if (u.add_tags || u.remove_tags) patch.tags = tags;
          if (u.append_notes) patch.notes = [patch.notes ?? item.notes, String(u.append_notes)].filter((s) => s.trim()).join('\n\n');
          if (has(patch, 'type') && patch.type !== item.type && !has(patch, 'kind')) patch.kind = '';
          const earlier = patches.get(item.id) ?? {};
          if (has(u, 'comment')) {
            if (typeof u.comment !== 'string' || !u.comment.trim()) throw new TrackerError('comment must be some text');
            patch.comments = addCommentPatch({ ...item, ...earlier }, u.comment, CLAUDE_AUTHOR, at).comments;
          }
          patches.set(item.id, { ...earlier, ...patch, updatedBy: CLAUDE_AUTHOR });
        }
        const out = items.map((i) => {
          if (!patches.has(i.id) || i.deleted) return i;
          const updated = applyPatch(i, patches.get(i.id), at);
          changed.push(updated);
          return updated;
        });
        return changed.length ? out : null;
      }, `Tracker: update ${updates.length === 1 ? 'an item' : `${updates.length} items`} (via ${device})`);
      return { updated: changed.map((c) => withLink(next.find((i) => i.id === c.id) ?? c)) };
    },

    async deleteItems(ids) {
      if (!Array.isArray(ids) || !ids.length) throw new TrackerError('Provide at least one id.');
      const at = now();
      let removed = [];
      await commit((items) => {
        const targets = new Set(ids.map((id) => resolve(items, id).id));
        removed = items.filter((i) => targets.has(i.id));
        return items.map((i) => (targets.has(i.id) ? tombstone(i, at, CLAUDE_AUTHOR) : i));
      }, `Tracker: delete ${ids.length === 1 ? 'an item' : `${ids.length} items`} (via ${device})`);
      return { deleted: removed.map((i) => ({ id: i.id, title: i.title })) };
    },

    // Saves a document as a file in the repo and files it on the tracker:
    // as a new "doc" item, or as a new version on an existing item.
    async sendDocument(input) {
      const content = String(input.content ?? '');
      if (!content.trim()) throw new TrackerError('content is empty — pass the full text of the document.');
      const size = byteLength(content);
      if (size > MAX_FILE_BYTES) throw new TrackerError(`The document is ${formatBytes(size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}.`);
      const kind = input.kind ?? 'other';
      checkFields({ kind, priority: input.priority, due: input.due }, 'doc');
      const at = now();

      let target = null;
      if (input.item_id) target = resolve((await load()).items, input.item_id);
      const title = String(input.title ?? '').trim() || target?.title;
      if (!title) throw new TrackerError('A title is required.');

      const fallbackName = kind === 'proposal' || kind === 'artifact' ? `${kind}.md` : `${slugify(title)}.md`;
      const filename = safeFileName(input.filename, fallbackName);
      const draft = target ? null : createItem({ type: 'doc', title, updatedBy: CLAUDE_AUTHOR }, at);
      const folder = target?.files[0]?.path.split('/').slice(0, -1).join('/') || `${dir}/${at.slice(0, 10)}-${slugify(title)}-${draft.id.slice(-6)}`;
      const filePath = `${folder}/${filename}`;

      const written = await writeFile(filePath, content, `Tracker: ${target ? 'update' : 'add'} ${filePath} (via ${device})`);
      const file = { path: filePath, name: filename, size, sha: written.sha ?? '', addedAt: at };
      const fields = pickFields({ project: input.project, url: input.url, priority: input.priority, due: input.due });
      if (has(input, 'tags')) fields.tags = cleanTags(input.tags);

      if (!target) {
        let item = normalizeItem({ ...draft, ...fields, kind, notes: input.summary ?? '', files: [file] });
        await commit((items, data) => {
          item = { ...item, project: canonical(item.project, data) };
          return [...items, item];
        }, `Tracker: add ${kindLabel('doc', kind).toLowerCase() || 'document'} “${title}” (via ${device})`);
        return { created: true, item: withLink(item), file: { path: filePath, size: formatBytes(size) } };
      }

      let saved = null;
      await commit((items, data) => {
        if (has(fields, 'project')) fields.project = canonical(fields.project, data);
        const current = resolve(items, target.id);
        const notes = input.summary ? [current.notes, `**Update ${at.slice(0, 10)}:** ${input.summary}`].filter((s) => s.trim()).join('\n\n') : current.notes;
        saved = applyPatch(
          current,
          { ...fields, notes, files: [...current.files.filter((f) => f.path !== filePath), file], status: 'pending', decision: '', updatedBy: CLAUDE_AUTHOR },
          at,
        );
        return items.map((i) => (i.id === current.id ? saved : i));
      }, `Tracker: new version of “${target.title}” (via ${device})`);
      return { created: false, replacedFile: written.replaced, item: withLink(saved), file: { path: filePath, size: formatBytes(size) } };
    },
  };
}
