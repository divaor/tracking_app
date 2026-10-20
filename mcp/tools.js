// The tracker's MCP surface: server instructions, tools and prompts. The
// wording here is what lets Claude act on requests like "send this proposal
// to my tracker" from any chat or Claude Code session.
import { APP_VERSION } from '../app/js/version.js';
import { DECISIONS, KINDS, PRIORITIES, STATUSES, TYPE_IDS } from '../app/js/model.js';

export const SERVER_INFO = { name: 'tracker', title: 'Tracker', version: APP_VERSION };

export const INSTRUCTIONS = `Tracker is the user's personal tracker for tasks, ideas, Claude work and documents. They read and review it in the Tracker app on their computers and phone. Data lives in a private GitHub repo; every write is a commit.

Model
- Item types: task, idea, claude (Claude work: Claude Code sessions, PRs, chats, artifacts), doc (things for the user to read or review).
- Status: pending → in_progress → done (docs show as To read → Reading → Read).
- Docs can carry files (proposal.md, report.html, …) stored in the repo; the user reads them in the app.
- The user reviews docs by setting decision (approved | changes | rejected) and writing feedback.

How to handle requests
- "Send (this) proposal / plan / design to my tracker" → send_document with kind "proposal", the COMPLETE proposal as Markdown in content, and a 2–4 sentence summary. Do not send a shortened version.
- "Send (this) artifact / file / report / README / doc to my tracker" → send_document with the matching kind, the complete file content, and a filename with the right extension (dashboard.html, notes.md, script.py…).
- A revised version of something already on the tracker → send_document with item_id (and the same filename to replace it); this puts it back in the user's review queue.
- "Update tasks on my tracker", "mark X done", "add a task …" → list_items first to find existing items and avoid duplicates, then update_items / add_items. Batch several changes into one call.
- "Log / track this Claude work" → add_items with type "claude", kind (code, chat, pr, artifact) and url = the session, PR or artifact link.
- "What's on my tracker?" → get_overview. "Any feedback on my proposal?" → list_items with decision, or get_item; then read decision and feedback.

Conventions
- Set project to the repository or project name and url to the most relevant link (Claude session, PR, artifact) when you know them.
- Keep titles short and specific; put details in notes (Markdown, checklists with "- [ ]").
- Due dates are YYYY-MM-DD. Use tags sparingly and reuse existing ones.
- Never delete items unless the user explicitly asks. After a write, tell the user what changed and include the item link if one is returned.`;

const str = (description) => ({ type: 'string', description });
const enumOf = (values, description) => ({ type: 'string', enum: values, description });
const tagsSchema = { type: 'array', items: { type: 'string' }, description: 'Tags without "#", e.g. ["work"].' };
const kindIds = (type) => KINDS[type].map((k) => k.id);

const ITEM_FIELDS = {
  title: str('Short, specific title.'),
  type: enumOf(TYPE_IDS, 'task | idea | claude (Claude work) | doc (something to read). Default: task.'),
  status: enumOf(STATUSES, 'Default: pending.'),
  priority: enumOf(PRIORITIES.map((p) => p.id), 'Default: normal.'),
  kind: str(`Optional subtype. For claude: ${kindIds('claude').join(', ')}. For doc: ${kindIds('doc').join(', ')}.`),
  project: str('Repository or project name.'),
  tags: tagsSchema,
  url: str('Most relevant link: Claude session, PR, artifact or source.'),
  due: str('Due date as YYYY-MM-DD.'),
  notes: str('Details in Markdown. Checklists as "- [ ] step".'),
};

export function createTools(getTracker) {
  const run = (fn) => async (args) => fn(await getTracker(), args);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  return [
    {
      name: 'get_overview',
      title: 'Tracker overview',
      description: 'Summary of the tracker: counts per type and status, items in progress, items due within 7 days, documents waiting for review, and recent review decisions with feedback.',
      inputSchema: { type: 'object', properties: {} },
      annotations: readOnly,
      run: run((t) => t.overview()),
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
          query: str('Words to search for in title, notes, feedback, project, url, tags and file names.'),
          tag: str('Only items with this tag.'),
          project: str('Only items for this project.'),
          kind: str('Only items of this kind, e.g. proposal.'),
          decision: enumOf([...DECISIONS.map((d) => d.id), 'none'], 'Only docs with this review decision (none = not reviewed yet).'),
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
      },
      annotations: readOnly,
      run: run((t, a) => t.list(a)),
    },
    {
      name: 'get_item',
      title: 'Get a tracker item',
      description: 'Full details of one item: notes, review decision and feedback, attached files. Set include_file_contents to also read the attached files (e.g. to revise a proposal the user reviewed).',
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
      description: 'Read a file attached to a tracker item, by the path listed in the item\'s files. Long files come in pages: pass nextOffset from the previous result as offset.',
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
      description: 'Change one or more existing items in one commit: status (e.g. mark done), title, priority, due, notes, tags, review fields. Only the fields you pass change; pass "" to clear due or decision.',
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
  ];
}

export const PROMPTS = [
  {
    name: 'send_proposal',
    title: 'Send proposal to my tracker',
    description: 'Write up the current plan or proposal and send it to the tracker for review.',
    arguments: [{ name: 'topic', description: 'What the proposal is about (optional).', required: false }],
    text: ({ topic }) =>
      `Write the ${topic ? `proposal about ${topic}` : 'proposal or plan we have been discussing'} as a complete Markdown document (context, proposal, alternatives, risks, open questions) and send it to my tracker with send_document (kind "proposal"). Include the project and a link to this session or PR if you know it. Then tell me the item link.`,
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
    description: 'Find review decisions and feedback on proposals and artifacts and act on them.',
    arguments: [{ name: 'project', description: 'Limit to one project (optional).', required: false }],
    text: ({ project }) =>
      `Check my tracker for docs I have reviewed${project ? ` in project ${project}` : ''} (list_items with status "all" and a decision; read the feedback with get_item). Summarize each decision and feedback, and propose next steps. For "changes" decisions, offer to revise and resend with send_document using item_id.`,
  },
];
