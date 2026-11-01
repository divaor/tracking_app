// Find by asking (2.6): one question from the search box, run with what is on this device. The items
// are here; the text files on them are read from the cache (and fetched when missing, a few within a
// time budget); the release boards are the ones read here; Tracker Editor's files come from its index
// in the same data (editorFiles.js). findSources.js runs it (plan, search, pick) with the model.
import { llmClient, modelReady } from './assistant.js';
import { cachedBoard, cachedBoards } from './boardStore.js';
import { editorRecords, editorTexts } from './editorFiles.js';
import { loadFileText } from './files.js';
import { boardSources, editorSource, fileSource, findPicture, itemSource, runFind, textFilesOf } from './findSources.js';
import { kvGet } from './kv.js';
import { connectionOf } from './providers.js';
import { getSettings } from './settings.js';

// Text files on items that are not on this device yet: at most this many fetched per question, within the time budget.
const FETCH_FILES = 30;
const FETCH_MS = 4000;

/** Whether a question can go to the model now (one that answers at once, not a service that answers later). */
export const canAsk = (settings = getSettings()) => modelReady(settings) && connectionOf(settings.llm) !== 'async';

const needsText = (plan) => plan.terms.length > 0 || plan.patterns.length > 0;
const wanted = (plan, kind) => !plan.kinds.length || plan.kinds.includes(kind);

async function fileTexts(pairs, plan) {
  const out = [];
  const missing = [];
  for (const { item, file } of pairs) {
    const text = file.sha ? await kvGet(`file:${file.sha}`).catch(() => null) : null;
    if (typeof text === 'string') out.push(fileSource(item, file, text));
    else missing.push({ item, file });
  }
  // Only what the plan has to read: fetched newest first, a few at a time.
  const until = Date.now() + FETCH_MS;
  const fetch = needsText(plan) ? missing.sort((a, b) => String(b.file.addedAt).localeCompare(String(a.file.addedAt))).slice(0, FETCH_FILES) : [];
  for (let i = 0; i < fetch.length && Date.now() < until; i += 5) {
    const batch = await Promise.all(fetch.slice(i, i + 5).map(({ item, file }) => loadFileText(file).then((text) => fileSource(item, file, text), () => null)));
    out.push(...batch.filter(Boolean));
  }
  // The rest are still found by their name.
  const read = new Set(out.map((s) => s.id));
  for (const { item, file } of missing) if (!read.has(`a:${item.id}:${file.path}`)) out.push(fileSource(item, file, ''));
  return out;
}

/**
 * Runs a question: { question, plan, results, encrypted, more, picked }. `items`: the live items;
 * `projects`: their names; `onPhase` says where it is. Without a model that answers at once, the
 * question's own words are searched.
 */
export async function askFind(question, { items, projects, today, signal, onPhase }) {
  const settings = getSettings();
  const boards = cachedBoards()
    .map(({ slug }) => ({ slug, board: cachedBoard(slug) }))
    .filter((b) => b.board);
  const editor = await editorRecords().catch(() => []);
  const files = textFilesOf(items);
  const picture = findPicture({ today, items, projects, boards, files: files.length, editor });
  const chat = canAsk(settings)
    ? (messages, purpose) => llmClient().chat({ model: settings.llm.chatModel, messages, purpose, temperature: 0.1, signal, onToken: () => {} })
    : null;
  const loadSources = async (plan) => {
    const sources = wanted(plan, 'item') ? items.map(itemSource) : [];
    if (wanted(plan, 'board')) for (const { slug, board } of boards) sources.push(...boardSources(slug, board));
    if (wanted(plan, 'file')) sources.push(...(await fileTexts(files, plan)));
    if (wanted(plan, 'editor') && editor.length) {
      const texts = needsText(plan) && !plan.encrypted ? await editorTexts(editor) : new Map();
      sources.push(...editor.map((r) => editorSource(r, texts.get(r.id) ?? '')));
    }
    return sources;
  };
  return runFind(question, { picture, loadSources, chat, namesOnly: Boolean(settings.findNamesOnly), onPhase, signal });
}
