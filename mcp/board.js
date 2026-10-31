// Release boards for Claude (the board_* tools): boards/<slug>.json in the data repo, one per
// project (app/js/boards.js says what they hold). Reads say where things stand in a few lines; writes
// change records by id with only the fields given and are committed at the version read, read again,
// changed again and retried when another writer (a session, a device) got there first.
import {
  actionTime,
  addLog,
  applyBoardChanges,
  boardEvents,
  boardFromData,
  boardPath,
  boardScript,
  boardSlug,
  boardSummary,
  boardTime,
  boardUpdated,
  BOARD_PARTS,
  BOARDS_DIR,
  changedSince,
  commentsAwaiting,
  emptyBoard,
  liveRecords,
  mergeBoards,
  parseBoard,
  recordTitle,
  serializeBoard,
  setNow,
  statusLabel,
  STATUSES,
  tidyBoard,
  waitingActions,
} from '../app/js/boards.js';

export class BoardError extends Error {}

const MAX_ATTEMPTS = 4;
const isConflict = (err) => err?.status === 409 || err?.status === 422;
const pct = (n, total) => (total ? Math.round((n * 100) / total) : 0);
// export_board gives the script itself up to this size; a download link beyond it.
export const INLINE_EXPORT_CHARS = 20_000;

const clip = (text, max) => (String(text ?? '').length > max ? `${String(text).slice(0, max - 1)}…` : String(text ?? ''));

// `onChange(events)` gets what a write changed that the person wants to hear about (boardEvents:
// a test failed, a release's status, a decision or a step waiting for them, a comment) for push.
export function createBoards({ client, branch = '', device = 'Claude', now, appUrl = '', canonicalProject, maxReadChars = 90_000, onChange = () => {} }) {
  const ref = branch || undefined;
  const link = (name) => (appUrl ? `${appUrl.replace(/#.*$/, '').replace(/\/?$/, '/')}#/release-board/${boardSlug(name)}` : undefined);

  async function nameOf(project) {
    const name = String(project ?? '').trim();
    if (!name) throw new BoardError('Say which project: project is required.');
    return (await canonicalProject(name)) || name;
  }

  async function load(name) {
    const file = await client.getFile(boardPath(name), ref);
    if (!file) return { sha: undefined, board: null };
    const board = parseBoard(file.text);
    if (!board) throw new BoardError(`${boardPath(name)} cannot be read, so it was left as it is.`);
    return { sha: file.sha, board };
  }

  async function need(name) {
    const { board } = await load(name);
    if (!board) throw new BoardError(`“${name}” has no release board yet. Start one with import_board (from a board file) or update_board.`);
    return board;
  }

  async function put(path, text, sha, message) {
    const write = () => client.putFile(path, { text, sha, branch: ref, message });
    try {
      return await write();
    } catch (err) {
      if (err.status === 404 && branch && (await client.ensureBranch(branch))) return write();
      throw err;
    }
  }

  // Log entries the board let go (over MAX_LOG): kept in boards/<slug>/log-<month>.json.
  async function archive(name, older) {
    const byMonth = new Map();
    for (const entry of older) {
      const month = String(entry.time).slice(0, 7) || 'undated';
      byMonth.set(month, [...(byMonth.get(month) ?? []), entry]);
    }
    for (const [month, entries] of byMonth) {
      const path = `${BOARDS_DIR}/${boardSlug(name)}/log-${month}.json`;
      for (let attempt = 1; ; attempt++) {
        const file = await client.getFile(path, ref);
        const kept = file ? (JSON.parse(file.text).log ?? []) : [];
        const ids = new Set(kept.map((e) => e.id));
        const log = [...kept, ...entries.filter((e) => !ids.has(e.id))].sort((a, b) => (a.time < b.time ? 1 : -1));
        try {
          await put(path, `${JSON.stringify({ version: 1, project: name, log }, null, 1)}\n`, file?.sha, `Tracker: release board “${name}”: older log (${month})`);
          break;
        } catch (err) {
          if (!isConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
        }
      }
    }
  }

  // Changes the board as `change(board or null)` says ({ board } or null for nothing to write) and
  // commits it; runs `change` again on the newer version when another writer got there first.
  async function write(name, change, message) {
    for (let attempt = 1; ; attempt++) {
      const { sha, board } = await load(name);
      const result = change(board);
      if (!result) return { board };
      const { board: tidy, older } = tidyBoard(result.board, now());
      if (older.length) await archive(name, older);
      try {
        await put(boardPath(name), serializeBoard(tidy), sha, typeof message === 'function' ? message(tidy) : message);
        const events = boardEvents(board, tidy);
        if (events.length) onChange(events);
        return { ...result, board: tidy };
      } catch (err) {
        if (!isConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
  }

  const by = (session) => (String(session ?? '').trim() ? `${device} · ${String(session).trim()}` : device);

  /** Where the board stands, compactly (what get_board returns). */
  function view(name, board, since) {
    const at = now();
    const s = boardSummary(board, new Date(at));
    const updated = boardUpdated(board);
    const releases = liveRecords(board, 'releases');
    const cardOf = new Map(s.cards.map((c) => [c.id, c]));
    const out = {
      project: name,
      link: link(name),
      updated: updated.at ? { at: updated.at, by: updated.by } : undefined,
      headline: board.now?.headline || undefined,
      summary: board.now?.summary || undefined,
      tiles: {
        releasesOut: `${s.releases.out} of ${s.releases.total} (fully or partly)`,
        featuresLive: `${s.features.live} of ${s.features.total} (${pct(s.features.live, s.features.total)}%)`,
        testsPassed: `${s.tests.passed} of ${s.tests.total}`,
        waitingOnYou: s.actions,
        openDecisions: s.openDecisions,
      },
      next: s.next.map((n) => ({ title: n.title, at: n.date.toISOString(), release: n.release })),
      releases: releases.map((r) => {
        const c = cardOf.get(r.id);
        const step = (Array.isArray(r.steps) ? r.steps : []).find((x) => !x?.done);
        return {
          id: r.id,
          title: r.title,
          status: r.status,
          shipLabel: r.ship_label || undefined,
          steps: c.progress.total ? `${c.progress.done} of ${c.progress.total} done (${c.progress.percent}%)` : undefined,
          nextStep: step?.label,
          features: c.features.total ? `${c.features.live} of ${c.features.total} live` : undefined,
          tests: c.tests.total ? `${c.tests.passed} of ${c.tests.total} passed` : undefined,
        };
      }),
      waitingOnYou: waitingActions(board).map((a) => ({ id: a.id, text: a.text, when: a.when, at: actionTime(a, new Date(at))?.toISOString(), release: a.release, item: a.item, command: a.command })),
      // The person's comments you have not answered (answer with update_board: { part, id, comment }).
      commentsAwaiting: commentsAwaiting(board)
        .slice(-20)
        .map((c) => ({ part: c.part, id: c.id, title: c.title || undefined, command: c.command, by: c.comment.by, at: c.comment.at, text: clip(c.comment.text, 400) })),
      openDecisions: liveRecords(board, 'decisions')
        .filter((d) => d.status === 'open')
        .map((d) => ({ id: d.id, code: d.code || undefined, title: d.title, release: d.release, date: d.date })),
      sessions: liveRecords(board, 'sessions').map((x) => ({ name: x.name ?? x.id, state: x.state, status: x.status, now: x.now, reported: x.updatedAt, by: x.updatedBy })),
      latestLog: board.log.filter((l) => !l.deleted).slice(0, 8).map((l) => ({ time: l.time, text: l.text, release: l.release, by: l.by || l.updatedBy })),
      counts: Object.fromEntries(BOARD_PARTS.map((p) => [p, liveRecords(board, p).length])),
    };
    if (since) {
      const changes = changedSince(board, since);
      out.changedSince = {
        since,
        total: changes.length,
        changes: changes.slice(0, 60).map(({ part, id, record }) => ({ part, id, title: recordTitle(part, record) || undefined, status: record.status, deleted: record.deleted || undefined, at: record.updatedAt, by: record.updatedBy })),
      };
    }
    return out;
  }

  return {
    async get({ project, since } = {}) {
      const name = await nameOf(project);
      const board = await need(name);
      return view(board.project || name, board, since ? String(since) : '');
    },

    async records({ project, part, ids, release, status, query, offset = 0, limit = 20 } = {}) {
      const name = await nameOf(project);
      if (!BOARD_PARTS.includes(part)) throw new BoardError(`part must be one of ${BOARD_PARTS.join(', ')}.`);
      const board = await need(name);
      const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
      const words = String(query ?? '').toLowerCase().trim();
      const matches = liveRecords(board, part).filter(
        (r) =>
          (!wanted || wanted.has(r.id)) &&
          (!release || r.release === release || (part === 'releases' && r.id === release)) &&
          (!status || r.status === status) &&
          (!words || JSON.stringify(r).toLowerCase().includes(words)),
      );
      const start = Math.max(0, Number(offset) || 0);
      const records = [];
      let budget = maxReadChars;
      for (const r of matches.slice(start, start + Math.min(Math.max(1, Number(limit) || 20), 50))) {
        const size = JSON.stringify(r).length;
        if (records.length && size > budget) break;
        budget -= size;
        records.push(r);
      }
      const end = start + records.length;
      return { project: board.project || name, part, total: matches.length, offset: start, nextOffset: end < matches.length ? end : undefined, records };
    },

    async update({ project, changes = [], log, now: where, session } = {}) {
      const name = await nameOf(project);
      // Claude adds comments (answers) but does not delete the person's.
      const list = (Array.isArray(changes) ? changes : []).map((c) => (c && typeof c === 'object' ? { ...c, uncomment: undefined } : c));
      const logEntry = typeof log === 'string' ? { text: log } : log && typeof log === 'object' ? log : null;
      if (!list.length && !logEntry?.text && !where) throw new BoardError('Nothing to change: give changes, log or now.');
      const at = now();
      const who = by(session);
      const result = await write(
        name,
        (board) => {
          let next = board ?? emptyBoard(name);
          let changed = [];
          if (list.length) ({ board: next, changed } = applyBoardChanges(next, list, { at, by: who }));
          if (logEntry?.text) next = addLog(next, logEntry, { at, by: who });
          if (where) next = setNow(next, where, { at, by: who });
          return { board: next, changed, created: !board };
        },
        (board) => `Tracker: release board “${board.project || name}”: ${logEntry?.text ? String(logEntry.text).slice(0, 72) : `${list.length} change${list.length === 1 ? '' : 's'}`} (via ${who})`,
      );
      const warnings = list
        .filter((c) => c?.set && typeof c.set.status === 'string' && !STATUSES.includes(c.set.status))
        .map((c) => `${c.part} ${c.id}: “${c.set.status}” is not one of the board's statuses (${STATUSES.join(', ')}); it shows without a colour.`);
      const shown = result.board.project || name;
      return { project: shown, link: link(shown), created: result.created || undefined, changed: result.changed, log: logEntry?.text || undefined, warnings: warnings.length ? warnings : undefined };
    },

    async setSession({ project, name: session, state, status, now: doing, item } = {}) {
      const who = String(session ?? '').trim();
      if (!who) throw new BoardError('name is required: the session whose row this is.');
      const set = { name: who, reported: boardTime(now()) };
      if (state != null) set.state = String(state);
      if (status != null) set.status = String(status);
      if (doing != null) set.now = String(doing);
      if (item != null) set.item = String(item);
      return this.update({ project, changes: [{ part: 'sessions', id: who, set }], session: who });
    },

    /** Imports a board file (its page, script or JSON) into the project's board: merged, nothing deleted. */
    async importText({ project, content }) {
      const name = await nameOf(project);
      const at = now();
      const imported = boardFromData(content, { project: name, at, by: device });
      const result = await write(name, (board) => ({ board: board ? mergeBoards(board, { ...imported, project: board.project || name }) : imported, created: !board }), (b) => `Tracker: release board “${b.project || name}” imported (via ${device})`);
      const counts = Object.fromEntries(BOARD_PARTS.map((p) => [p, liveRecords(imported, p).length]).filter(([, n]) => n));
      const shown = result.board.project || name;
      return { project: shown, link: link(shown), created: result.created || undefined, imported: counts, variable: imported.meta.export_variable || undefined };
    },

    /** The board as its page's data script: { variable, script, size }. */
    async exportScript({ project, variable } = {}) {
      const name = await nameOf(project);
      const board = await need(name);
      const script = boardScript(board, variable || board.meta?.export_variable || 'BOARD_DATA');
      return { project: board.project || name, variable: variable || board.meta?.export_variable || 'BOARD_DATA', script, size: script.length };
    },

    /** Each board in a line or two, for get_overview: what comes next, what waits, open decisions, comments. */
    async summaries() {
      const entries = ((await client.listDir(BOARDS_DIR, ref)) ?? []).filter((e) => e.type === 'file' && /\.json$/.test(e.name)).slice(0, 10);
      const out = [];
      for (const entry of entries) {
        const file = await client.getFile(entry.path, ref);
        const board = file && parseBoard(file.text);
        if (!board) continue;
        const s = boardSummary(board, new Date(now()));
        const next = s.next[0];
        const waiting = waitingActions(board);
        const comments = commentsAwaiting(board).length;
        out.push({
          project: board.project,
          link: link(board.project),
          headline: board.now?.headline || undefined,
          next: next ? { title: next.title, at: next.date.toISOString() } : undefined,
          waitingOnYou: waiting.length ? waiting.slice(0, 5).map((a) => (a.when ? `${a.text} (${a.when})` : a.text)) : undefined,
          openDecisions: s.openDecisions || undefined,
          commentsAwaiting: comments || undefined,
        });
      }
      return out;
    },

    nameOf,
    statusLabel,
  };
}
