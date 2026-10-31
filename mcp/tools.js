// The tracker's MCP surface: server instructions, tools and prompts. The
// wording here is what lets Claude act on requests like "send this proposal
// to my tracker" from any chat or Claude Code session.
import { APP_VERSION } from '../app/js/version.js';
import { BOARD_PARTS, STATUSES as BOARD_STATUSES } from '../app/js/boards.js';
import { MAX_ATTACH_BYTES } from './attach.js';
import { INLINE_EXPORT_CHARS } from './board.js';
import { MAX_PLAN_DAYS } from './tracker.js';
import { UPLOAD_MINUTES } from './uploads.js';
import { AREAS, DECISIONS, KINDS, PRIORITIES, STATUSES, TYPE_IDS, safeFileName } from '../app/js/model.js';

export const SERVER_INFO = { name: 'tracker', title: 'Tracker', version: APP_VERSION };

export const INSTRUCTIONS = `Tracker is the user's personal tracker for tasks, ideas, Claude work and documents, used in the Tracker app on their computers and phone. Every write is a commit to a private GitHub repo.

Model
- Item types: task, idea, claude (Claude work: Claude Code sessions, PRs, chats, artifacts), doc (things for the user to read or review).
- Status: pending → in_progress → done (docs show as To read → Reading → Read).
- Items can carry files (proposal.md, report.html, pictures…) kept in the repo; read_file shows you a picture, attach_file adds one.
- The user reviews docs by setting decision (approved | changes | rejected) and writing feedback.
- Any item can have comments: the user's notes for you and your replies. awaitingReply marks an item whose latest comment is the user's.
- Each item belongs to at most one project. Projects are in area work or personal; the user filters by them. Tags are free-form; use them for the repositories an item touches.

How to handle requests
- "Send (this) proposal / plan / design to my tracker" → send_document with kind "proposal", the COMPLETE proposal as Markdown in content, and a 2–4 sentence summary. Do not send a shortened version.
- "Send (this) artifact / file / report / README / doc to my tracker" → send_document with the matching kind, the complete file content, and a filename with the right extension (dashboard.html, notes.md, script.py…).
- A revised version of something on the tracker → send_document with item_id (the same filename replaces it); it goes back to the user's review queue.
- "Update tasks on my tracker", "mark X done", "add a task …" → list_items first to avoid duplicates, then update_items / add_items. Batch changes into one call.
- "Log / track this Claude work" → add_items with type "claude", kind (code, chat, pr, artifact) and url = the session, PR or artifact link.
- "What's on my tracker?" → get_overview. "Check my tracker for feedback / comments" → list_items with comments "unanswered" (docs: decision); read them with get_item, act, then reply with update_items comment.
- "Pin / unpin X" → update_items pinned true / false (list_items pinned true lists them).
- "Attach this screenshot / picture / file to X" → attach_file (in Claude Code: its upload link with curl).
- "My plan for today", "how did my week go" → get_overview (latestPlan) or get_plans; to make or update one, save_plan.
- A project's release board → get_board; after a merge, test, decision or step, update_board (set_session for your progress).

Projects and tags
- "For this conversation use project X (and tag with the repos you touch)" → remember it: pass project "X" on every add_items and send_document (and update_items when filing items), and tag with the repositories involved (one tag per repo).
- Call list_projects before your first write to reuse the exact project and tag spellings. A new project: save_project (area work or personal; ask if unclear). New tags are created by using them.
- Without such an instruction, set project only when it is obvious (an existing project named after the repo).

Tracker Editor files
- The user's text editor (Tracker Editor) keeps notes, snippets and drafts in the same repo. Not tracker items: use the *_editor_file(s) tools.
- "Save this to my editor" → save_editor_file with a name with extension (notes.md, query.sql…) and the COMPLETE text; project and tags as for items.
- "Find X in my editor files", "what did I paste about Y" → search_editor_files, then read_editor_file. To change one, read it, then save_editor_file with its id and the full new text.
- Encrypted files cannot be read or changed here; tell the user to open them in the editor.

Conventions
- Set url to the most relevant link (Claude session, PR, artifact) when you know it.
- Keep titles short and specific; put details in notes (Markdown, checklists with "- [ ]").
- Due dates are YYYY-MM-DD. Reuse existing tags instead of near-duplicates.
- Never delete items unless the user explicitly asks. After a write, tell the user what changed and give the item link when there is one.`;

const str = (description) => ({ type: 'string', description });
const enumOf = (values, description) => ({ type: 'string', enum: values, description });
const tagsSchema = { type: 'array', items: { type: 'string' }, description: 'Tags without "#", e.g. ["tracking_app", "api"]. Use repository names for the repos an item touches; reuse spellings from list_projects.' };
const kindIds = (type) => KINDS[type].map((k) => k.id);

const ITEM_FIELDS = {
  title: str('Short, specific title.'),
  type: enumOf(TYPE_IDS, 'task | idea | claude (Claude work) | doc (something to read). Default: task.'),
  status: enumOf(STATUSES, 'Default: pending.'),
  priority: enumOf(PRIORITIES.map((p) => p.id), 'Default: normal.'),
  kind: str(`Optional subtype. For claude: ${kindIds('claude').join(', ')}. For doc: ${kindIds('doc').join(', ')}.`),
  project: str('Project name. Reuse an existing project (see list_projects); matching is case-insensitive. A new name creates the project.'),
  tags: tagsSchema,
  url: str('Most relevant link: Claude session, PR, artifact or source.'),
  due: str('Due date as YYYY-MM-DD.'),
  notes: str('Details in Markdown. Checklists as "- [ ] step".'),
  pinned: { type: 'boolean', description: 'Pinned items come first in the app (on the overview, and at the top of any list or filter they match). Only when the user asks to pin or unpin.' },
};

export function createTools(getTracker, { uploads = null } = {}) {
  const run = (fn) => async (args, context) => fn(await getTracker(), args, context);

  // attach_file without bytes: a link for a shell to send the file to (Claude Code: curl -T).
  async function uploadLink(t, a, context) {
    const name = safeFileName(a.filename, '');
    if (!name || !/\.[A-Za-z0-9]{1,8}$/.test(name)) throw new Error('Give filename (with its extension, e.g. screenshot.png) for the upload link.');
    if (!uploads || !context?.baseUrl) throw new Error('Upload links need the connector over HTTP. Pass source_url (a public https link) or content_base64 instead.');
    const item = await t.findItem(a.item_id);
    const { url, expiresAt } = await uploads.link(context.baseUrl, { op: 'attach', item: item.id, name });
    return {
      upload: { url, expiresAt, command: `curl -sS -T <path of the file> '${url}'` },
      item,
      file: name,
      note: `Send the file to url within ${UPLOAD_MINUTES} minutes with the command (PUT, the raw bytes). Its answer says where it was attached; a file of the same name on the item is replaced. If this shell cannot reach the url, pass content_base64 instead for a small file.`,
    };
  }
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // import_board without content: a link to PUT the board file to (curl -T).
  async function boardImportLink(t, a, context) {
    if (!uploads || !context?.baseUrl) throw new Error('Upload links need the connector over HTTP. Pass the file\'s text as content instead.');
    const project = await t.boards.nameOf(a.project);
    const { url, expiresAt } = await uploads.link(context.baseUrl, { op: 'board-import', project });
    return {
      project,
      upload: { url, expiresAt, command: `curl -sS -T <path of the board file> '${url}'` },
      note: `Send the board file (its page, its data script or JSON) to url within ${UPLOAD_MINUTES} minutes with the command. Its answer says what was imported; nothing on the board is deleted.`,
    };
  }

  // export_board: the script itself when small, and a download link (curl -o) when there is HTTP.
  async function boardExport(t, a, context) {
    const out = await t.boards.exportScript(a);
    const result = { project: out.project, variable: out.variable, size: out.size };
    if (uploads && context?.baseUrl) {
      const { url, expiresAt } = await uploads.link(context.baseUrl, { op: 'board-export', project: out.project, name: out.variable });
      result.download = { url, expiresAt, command: `curl -sS '${url}' -o <path of the data file>` };
    }
    if (out.size <= INLINE_EXPORT_CHARS || !result.download) {
      if (out.size > 90_000) throw new Error(`The board is ${out.size.toLocaleString('en')} characters, too large to return here; ask over HTTP for a download link.`);
      result.script = out.script;
    }
    return result;
  }

  const projectArg = str('The project the board belongs to (its name; matching is case-insensitive).');

  return [
    {
      name: 'get_overview',
      title: 'Tracker overview',
      description: 'Summary of the tracker: the plan the user keeps for today (latestPlan), counts per type and status, pinned items, comments waiting for your reply (with the latest comment), items in progress, items due within 7 days, documents waiting for review, and recent review decisions with feedback.',
      inputSchema: { type: 'object', properties: {} },
      annotations: readOnly,
      run: run((t) => t.overview()),
    },
    {
      name: 'list_projects',
      title: 'List projects and tags',
      description: 'All projects (with area work/personal and open/total item counts) and all tags in use (with counts). Call before filing items so you reuse existing spellings.',
      inputSchema: { type: 'object', properties: {} },
      annotations: readOnly,
      run: run((t) => t.listProjects()),
    },
    {
      name: 'save_project',
      title: 'Create or update a project',
      description: 'Create a project or change its area (work/personal), color or description. Can also rename a project (its items move along, merging into an existing project of that name) or delete it (only when the user asks; its items stay, without a project).',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Project name (existing projects match case-insensitively).'),
          area: enumOf([...AREAS.map((a) => a.id), ''], 'work or personal; "" for none.'),
          description: str('Optional one-line description.'),
          color: str('Optional color as #rrggbb.'),
          rename_to: str('New name for the project.'),
          delete: { type: 'boolean', description: 'Delete the project. Only when the user explicitly asks.' },
        },
        required: ['name'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      run: run((t, a) => t.saveProject(a)),
    },
    {
      name: 'list_items',
      title: 'List tracker items',
      description: 'Find items on the tracker. By default returns open items (pending + in progress). Use before adding or updating so you work with existing items and their ids.',
      inputSchema: {
        type: 'object',
        properties: {
          type: enumOf(['all', ...TYPE_IDS], 'Filter by type. Default: all.'),
          status: enumOf(['open', 'all', ...STATUSES], 'open = pending or in_progress (default).'),
          query: str('Words to search for in title, notes, feedback, comments, project, url, tags and file names (case and accents ignored; "a phrase" in quotes).'),
          tag: str('Only items with this tag.'),
          project: str('Only items in this project (case-insensitive).'),
          projects: { type: 'array', items: { type: 'string' }, description: 'Only items in any of these projects.' },
          area: enumOf([...AREAS.map((a) => a.id), 'none'], 'Only items whose project is in this area (none = no project or no area).'),
          kind: str('Only items of this kind, e.g. proposal.'),
          decision: enumOf([...DECISIONS.map((d) => d.id), 'none'], 'Only docs with this review decision (none = not reviewed yet).'),
          pinned: { type: 'boolean', description: 'true: only pinned items (any status unless status is given); false: only unpinned ones.' },
          comments: enumOf(['unanswered', 'any'], 'unanswered: items whose latest comment is the user\'s, waiting for your reply; any: items with comments. Any status unless status is given.'),
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
      },
      annotations: readOnly,
      run: run((t, a) => t.list(a)),
    },
    {
      name: 'get_item',
      title: 'Get a tracker item',
      description: 'Full details of one item: notes, comments (the user\'s and yours, oldest first), review decision and feedback, attached files. Set include_file_contents to also read the attached files (e.g. to revise a proposal the user reviewed).',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('Item id (or its exact title).'),
          include_file_contents: { type: 'boolean', description: 'Also return the text of attached files. Default false.' },
        },
        required: ['id'],
      },
      annotations: readOnly,
      run: run((t, a) => t.get(a.id, { includeFiles: Boolean(a.include_file_contents) })),
    },
    {
      name: 'read_file',
      title: 'Read a tracker file',
      description: 'Read a file attached to a tracker item, by the path listed in the item\'s files. Long files come in pages: pass nextOffset from the previous result as offset. A picture (png, jpg, gif, webp) comes back as the picture itself, for you to look at; other files that are not text (PDFs, documents) are only described.',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('File path, e.g. files/2026-10-20-sync-plan-1a2b3c/proposal.md'),
          offset: { type: 'integer', minimum: 0, description: 'Character offset to start from. Default 0.' },
        },
        required: ['path'],
      },
      annotations: readOnly,
      run: run((t, a) => t.readFile(a.path, a.offset)),
    },
    {
      name: 'add_items',
      title: 'Add tracker items',
      description: 'Add one or more tasks, ideas, Claude work entries or docs to the tracker (one commit). Check list_items first to avoid duplicates. To send a document with its file, use send_document instead.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: { type: 'object', properties: ITEM_FIELDS, required: ['title'] },
          },
        },
        required: ['items'],
      },
      annotations: write,
      run: run((t, a) => t.addItems(a.items)),
    },
    {
      name: 'update_items',
      title: 'Update tracker items',
      description: 'Change one or more existing items in one commit: status (e.g. mark done), title, priority, due, notes, tags, pinned, review fields, or add a comment. Only the fields you pass change; pass "" to clear due or decision.',
      inputSchema: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                id: str('Item id (or exact title).'),
                ...ITEM_FIELDS,
                tags: { ...tagsSchema, description: 'Replaces all tags.' },
                add_tags: { ...tagsSchema, description: 'Tags to add.' },
                remove_tags: { ...tagsSchema, description: 'Tags to remove.' },
                append_notes: str('Markdown appended to the existing notes (use for progress logs).'),
                decision: enumOf(['', ...DECISIONS.map((d) => d.id)], 'Review decision; normally set by the user.'),
                feedback: str('Review feedback; normally written by the user.'),
                comment: str('A comment from you on the item, in Markdown: your answer to the user\'s comment, or what you did about it. It is added to the item\'s comments (the notes stay as they are).'),
              },
              required: ['id'],
            },
          },
        },
        required: ['updates'],
      },
      annotations: { ...write, idempotentHint: true },
      run: run((t, a) => t.updateItems(a.updates)),
    },
    {
      name: 'delete_items',
      title: 'Delete tracker items',
      description: 'Delete items from the tracker. Only when the user explicitly asks to delete or remove them; prefer marking items done.',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Item ids.' } }, required: ['ids'] },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      run: run((t, a) => t.deleteItems(a.ids)),
    },
    {
      name: 'send_document',
      title: 'Send a document to the tracker',
      description:
        'Save a proposal, artifact, plan, report, README or any document to the tracker for the user to read and review. Use for "send this proposal to my tracker", "send the artifact to my tracker", "put this doc on my tracker". The file is stored in the tracker repo and appears in the user\'s reading list as a doc item. Pass item_id to add a new version to an existing item instead.',
      inputSchema: {
        type: 'object',
        properties: {
          title: str('Document title.'),
          kind: enumOf(kindIds('doc'), 'proposal for proposals/plans to approve, artifact for Claude artifacts, otherwise the closest match.'),
          content: str('The COMPLETE document text (Markdown, HTML, code…). Not a summary.'),
          filename: str('File name with extension, e.g. proposal.md, dashboard.html, analysis.py. Default: <kind>.md.'),
          summary: str('2–4 sentence Markdown summary shown above the file: what it is and what the user should decide.'),
          project: ITEM_FIELDS.project,
          tags: tagsSchema,
          url: ITEM_FIELDS.url,
          priority: ITEM_FIELDS.priority,
          due: str('Review-by date as YYYY-MM-DD.'),
          item_id: str('Existing item to attach this version to (resets it to "To read" and clears the decision).'),
        },
        required: ['title', 'content', 'kind'],
      },
      annotations: write,
      run: run((t, a) => t.sendDocument(a)),
    },
    {
      name: 'attach_file',
      title: 'Attach a picture or file to an item',
      description: `Attach a picture, screenshot, PDF or any other file to an existing item; the user sees it in the item (pictures as pictures, documents to open). A file of the same name on the item is replaced. Give the bytes one of three ways: source_url (a public https link the connector downloads), content_base64 (small files only), or neither: the result is an upload link (valid ${UPLOAD_MINUTES} minutes) to send the file to from a shell, e.g. in Claude Code: curl -sS -T screenshot.png '<link>'. Up to ${MAX_ATTACH_BYTES / 1024 / 1024} MB (larger files: the user attaches them in the app). For a document to review, use send_document.`,
      inputSchema: {
        type: 'object',
        properties: {
          item_id: str('The item (id, exact title, link or part of the id). Add it with add_items first if it does not exist.'),
          filename: str('File name with extension, e.g. login-screen.png, invoice.pdf. Needed for an upload link or base64; from source_url it defaults to the link\'s name.'),
          source_url: str('A public https address of the file to download (a picture on the web, a raw GitHub file…).'),
          content_base64: str('The file\'s bytes in base64 (a data: URL works too). Only for small files; in a shell, use the upload link.'),
        },
        required: ['item_id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: run((t, a, context) => (a.source_url || a.content_base64 ? t.attachFile(a) : uploadLink(t, a, context))),
    },
    {
      name: 'get_board',
      title: 'Release board: where it stands',
      description:
        "Where a project's release board stands, in a few lines: the headline, the tiles (releases out, features live, tests passed, what waits on the user, open decisions), each release's progress and next step, what waits on the user, open decisions, each session's row and the latest log. Pass since (an ISO time) to also list what changed after it. Whole records: get_board_records.",
      inputSchema: { type: 'object', properties: { project: projectArg, since: str('ISO time: also list the records changed after it.') }, required: ['project'] },
      annotations: readOnly,
      run: run((t, a) => t.boards.get(a)),
    },
    {
      name: 'get_board_records',
      title: 'Release board records',
      description: `Whole records of one part of a project's release board (${BOARD_PARTS.join(', ')}): a release's steps, merges, commands, recommendations and risks; a feature's repos, branch, commit and blockers; and so on. Filter by ids, release, status or words; long lists come in pages (pass nextOffset as offset).`,
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArg,
          part: enumOf(BOARD_PARTS, 'Which part of the board.'),
          ids: { type: 'array', items: { type: 'string' }, description: 'Only these ids.' },
          release: str('Only records of this release (its id, e.g. R4).'),
          status: str('Only records with this status.'),
          query: str('Words to look for anywhere in the records.'),
          offset: { type: 'integer', minimum: 0, description: 'Where to start (nextOffset of the last page).' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
        },
        required: ['project', 'part'],
      },
      annotations: readOnly,
      run: run((t, a) => t.boards.records(a)),
    },
    {
      name: 'update_board',
      title: 'Update a release board',
      description: `Change a project's release board (made if it has none) in one commit: records by id with only the fields that change, a log line, where things stand. A change is { part, id, set: { field: value } }: dotted paths reach inside ("steps.3.done", "dates.deployed"), null removes a field, a record not there yet is added. Or { part, id, remove: true }. Statuses: ${BOARD_STATUSES.join(', ')}. Write a log line for what happened ("R4 merged into dev"), pass session (your session's name) so the board says who changed what, and use the ids get_board shows. Records not mentioned stay as they are, so several sessions can update at once.`,
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArg,
          changes: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              properties: {
                part: enumOf(BOARD_PARTS, 'Which part of the board.'),
                id: str('The record\'s id (releases R1…, features, tests, decisions…; a session\'s id is its name).'),
                set: { type: 'object', description: 'Fields to set: { status: "live", commit: "abc123", "steps.2.done": true }. null removes a field.' },
                remove: { type: 'boolean', description: 'Remove the record.' },
              },
              required: ['part', 'id'],
            },
          },
          log: str('A line for the board\'s log: what happened.'),
          log_release: str('The release the log line is about.'),
          log_item: str('A tracker item the log line points to.'),
          now: { type: 'object', properties: { headline: str('One line: where things stand.'), summary: str('A few sentences.') }, description: 'Where things stand (the board\'s banner).' },
          session: str('Your session\'s name, as on the board\'s sessions.'),
        },
        required: ['project'],
      },
      annotations: write,
      run: run((t, a) =>
        t.boards.update({ ...a, log: a.log ? { text: a.log, release: a.log_release, item: a.log_item } : undefined }),
      ),
    },
    {
      name: 'set_session',
      title: 'Report your session on a release board',
      description: "Your session's row on a project's release board: its state (working, waiting, idle, done), status and what it is doing now. Call it when you start, when you wait on something and when you finish.",
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArg,
          name: str('Your session\'s name, as on the board.'),
          state: str('working, waiting, idle or done.'),
          status: enumOf(BOARD_STATUSES, 'Its status colour on the board.'),
          now: str('What it is doing now, in a line.'),
          item: str('The tracker item of this session, if any.'),
        },
        required: ['project', 'name'],
      },
      annotations: write,
      run: run((t, a) => t.boards.setSession(a)),
    },
    {
      name: 'import_board',
      title: 'Import a release board file',
      description: `Bring a release board file (the standalone page, its data script window.NAME = {...}, or its JSON) into a project's board: merged, nothing on the board deleted. With content (small files) it is imported at once; without, the result is an upload link (valid ${UPLOAD_MINUTES} minutes) to send the file to from a shell, e.g. in Claude Code: curl -sS -T board.html '<link>'.`,
      inputSchema: { type: 'object', properties: { project: projectArg, content: str('The whole file, for small boards. Leave out for an upload link.') }, required: ['project'] },
      annotations: write,
      run: run((t, a, context) => (a.content ? t.boards.importText(a) : boardImportLink(t, a, context))),
    },
    {
      name: 'export_board',
      title: 'Export a release board',
      description: `A project's release board as its standalone page's data script (window.NAME = {...}), to keep that page current or to share. Small boards come back whole; larger ones as a download link (valid ${UPLOAD_MINUTES} minutes): curl -sS '<link>' -o <the page's data file>.`,
      inputSchema: { type: 'object', properties: { project: projectArg, variable: str('The script\'s variable (default: the one the board was imported with).') }, required: ['project'] },
      annotations: readOnly,
      run: run((t, a, context) => boardExport(t, a, context)),
    },
    {
      name: 'get_plans',
      title: 'Plans and past days',
      description: 'The day plans and week reviews the user keeps on the tracker (made in the app or with save_plan, updated during the day; earlier versions kept), and what got done, started and added each day. One day (days 1) comes with the whole texts and the earlier versions; several days with the texts shortened.',
      inputSchema: {
        type: 'object',
        properties: {
          date: str('The last day, YYYY-MM-DD. Default: today.'),
          days: { type: 'integer', minimum: 1, maximum: MAX_PLAN_DAYS, description: 'How many days, back from date. Default 7.' },
        },
      },
      annotations: readOnly,
      run: run((t, a) => t.plans(a)),
    },
    {
      name: 'save_plan',
      title: 'Save a plan',
      description: 'Keep a plan for the user\'s day (kind day) or a review of their week (kind week) on the tracker, where the app shows it on the Overview, above List and Board, and under Days. Saving again for the same day makes a new version; the earlier one is kept. Read get_overview or get_plans first, so an update builds on the plan there.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: enumOf(['day', 'week'], 'day: the plan for the day (default); week: a review of the week.'),
          text: str('The whole plan in Markdown: short, a list of what to do first and why.'),
          date: str('The day it is for, YYYY-MM-DD. Default: today; pass the user\'s own date when you know it.'),
        },
        required: ['text'],
      },
      annotations: write,
      run: run((t, a) => t.savePlan(a)),
    },
    {
      name: 'list_editor_files',
      title: 'List Tracker Editor files',
      description: 'Files in Tracker Editor, the user\'s text editor (notes, snippets, drafts; not tracker items), most recently changed first: name, id, project, tags, size, when and by whom, and a link that opens it in the editor.',
      inputSchema: {
        type: 'object',
        properties: {
          query: str('Words to match in the file name, project or tags. To search the text, use search_editor_files.'),
          project: str('Only files in this project (case-insensitive).'),
          tag: str('Only files with this tag.'),
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
      },
      annotations: readOnly,
      run: run((t, a) => t.editor.list(a)),
    },
    {
      name: 'search_editor_files',
      title: 'Search Tracker Editor files',
      description: 'Search the text of the user\'s Tracker Editor files (case-insensitive), most recently changed files first. Returns matching files with line numbers and snippets; then use read_editor_file. Covers the 60 newest files and skips encrypted and very large ones; the note says when it stopped early.',
      inputSchema: {
        type: 'object',
        properties: {
          query: str('Text to find, e.g. a word or phrase.'),
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Most matching lines to return. Default 40.' },
        },
        required: ['query'],
      },
      annotations: readOnly,
      run: run((t, a) => t.editor.search(a)),
    },
    {
      name: 'read_editor_file',
      title: 'Read a Tracker Editor file',
      description: 'Read one Tracker Editor file by id (or its exact name). Long files come in pages: pass nextOffset from the previous result as offset. End-to-end encrypted files cannot be read here.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('File id from list_editor_files or search_editor_files (or the exact file name).'),
          offset: { type: 'integer', minimum: 0, description: 'Character offset to start from. Default 0.' },
        },
        required: ['id'],
      },
      annotations: readOnly,
      run: run((t, a) => t.editor.read(a.id, a.offset)),
    },
    {
      name: 'save_editor_file',
      title: 'Save a Tracker Editor file',
      description: 'Save text to Tracker Editor. Without id it creates a file (name and content required). With id it changes that file: content replaces its whole text; name renames it; project and tags replace its project and tags. It syncs to the editor on the user\'s devices. Encrypted files are never changed.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('Existing file to change. Omit to create a new file.'),
          name: str('File name with extension, e.g. notes.md, query.sql. Required for a new file; renames an existing one.'),
          content: str('The COMPLETE text of the file (not a summary or a diff). Optional when only renaming or changing project/tags.'),
          project: { ...ITEM_FIELDS.project, description: 'Project name, shared with the tracker (see list_projects); matching is case-insensitive. "" for none.' },
          tags: tagsSchema,
        },
      },
      annotations: { ...write, idempotentHint: true },
      run: run((t, a) => t.editor.save(a)),
    },
  ];
}

export const PROMPTS = [
  {
    name: 'use_project',
    title: 'Use a project on my tracker',
    description: 'File everything from this conversation under one project and tag it with the repos involved.',
    arguments: [
      { name: 'project', description: 'Project name.', required: true },
      { name: 'area', description: 'work or personal (used if the project is new).', required: false },
    ],
    text: ({ project, area }) =>
      `For the rest of this conversation, put everything you add to or send to my tracker (tasks, Claude work, proposals, artifacts) in the project "${project}", and tag each item with the repositories it touches (one tag per repo name). First call list_projects to reuse existing spellings; if "${project}" does not exist, create it with save_project${area ? ` in area ${area}` : ' (ask me whether it is work or personal)'}. Confirm in one line.`,
  },
  {
    name: 'send_proposal',
    title: 'Send proposal to my tracker',
    description: 'Write up the current plan or proposal and send it to the tracker for review.',
    arguments: [{ name: 'topic', description: 'What the proposal is about (optional).', required: false }],
    text: ({ topic }) =>
      `Write the ${topic ? `proposal about ${topic}` : 'proposal or plan we have been discussing'} as a complete Markdown document (context, proposal, alternatives, risks, open questions) and send it to my tracker with send_document (kind "proposal"). Include the project and a link to this session or PR if you know it. Then tell me the item link.`,
  },
  {
    name: 'release_board',
    title: 'Keep a release board current',
    description: "How to keep a project's release board current from this session.",
    arguments: [
      { name: 'project', description: 'The project whose board it is.', required: true },
      { name: 'session', description: "This session's name on the board (optional).", required: false },
    ],
    text: ({ project, session }) =>
      `Keep the release board of "${project}" on my tracker current from this session${session ? ` (you are "${session}" on it)` : ''}:
- Start with get_board and use its ids (releases, features, tests, decisions); get_board_records for whole records.
- set_session when you start, when you wait on something and when you finish${session ? `, as "${session}"` : ''}.
- After a merge, deploy, test, decision or a finished step: update_board with only the fields that changed, a log line saying what happened${session ? ' and your session' : ''}. Use the board's statuses; never guess one.
- Something I must do (run a command, merge, decide): an action (part actions: text, when, release, item, command). Remove it once done.
- A question for me: a decision with status open, and say so in your reply.
- Do not change records other sessions own beyond what your work changed.`,
  },
  {
    name: 'update_tracker',
    title: 'Update my tracker',
    description: 'Sync the tracker with the work done in this conversation.',
    arguments: [],
    text: () =>
      'Look at what we did in this conversation and update my tracker: list_items to see what is there, mark finished tasks done, update in-progress items with a short progress note (append_notes), add follow-up tasks we identified, and log this Claude work (type "claude" with the session or PR link). Batch the changes, then summarize what you changed.',
  },
  {
    name: 'check_feedback',
    title: 'Check tracker feedback',
    description: 'Find my comments waiting for your reply on any item, and my review decisions on proposals and artifacts, and act on them.',
    arguments: [{ name: 'project', description: 'Limit to one project (optional).', required: false }],
    text: ({ project }) =>
      `Check my tracker${project ? ` (project ${project})` : ''} for feedback: comments waiting for your reply on any item (list_items with comments "unanswered"), and docs I have reviewed (list_items with status "all" and a decision). Read each with get_item. Summarize each comment, decision and feedback, and propose next steps. Once you have handled a comment, reply to it with update_items comment, saying what you did. For "changes" decisions, offer to revise and resend with send_document using item_id.`,
  },
];
