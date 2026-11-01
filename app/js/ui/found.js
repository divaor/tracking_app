// Find by asking (2.6): what a question found, in the list's place. Items come in the model's order,
// each with its reason; files on items, release board records and Tracker Editor's files come above
// them, each opening where it belongs; encrypted editor files apart, by name only. "Ask the assistant
// about these" hands the items found to the assistant (they become what it sees on screen).
import { html, useState } from '../../vendor/preact-htm.js';
import { planWords } from '../askFind.js';
import { EditorLink, EmptyState, ItemRow } from './components.js';
import { Icon } from './icons.js';

const PHASES = { planning: 'Working out what to look for…', searching: 'Searching…', picking: 'Picking the best…' };
const KIND_ICON = { file: 'paperclip', board: 'rocket', editor: 'code', item: 'list' };

/** The reason a result fits: the model's, else the first line that matched. */
const reasonOf = (r) => r.why || (r.lines?.[0] ? `${r.lines[0].line > 1 ? `Line ${r.lines[0].line}: ` : ''}${r.lines[0].text}` : '');

function OtherRow({ r, actions }) {
  const reason = reasonOf(r);
  const body = html`<${Icon} name=${KIND_ICON[r.kind] ?? 'doc'} size=${16} />
    <span class="found-main">
      <span class="found-name">${r.name || '(no name)'}${r.from === 'editor' && html`<span class="found-from" title="A file of Tracker Editor: it opens there">Tracker Editor</span>`}</span>
      <span class="found-place muted small">${r.place}</span>
      ${reason && html`<span class="found-why small">${reason}</span>`}
    </span>`;
  if (r.kind === 'editor') return html`<${EditorLink} route=${{ kind: 'file', id: r.editorId }} className="found-row kind-editor" title="Open it in Tracker Editor">${body}</${EditorLink}>`;
  const open = () => (r.kind === 'file' ? actions.openFile(r.itemId, r.path) : (location.hash = r.href));
  return html`<button type="button" class=${`found-row kind-${r.kind}`} onClick=${open}>${body}</button>`;
}

function Results({ list, itemsById, actions, today }) {
  const items = list.filter((r) => r.kind === 'item' && itemsById.has(r.itemId));
  const others = list.filter((r) => r.kind !== 'item');
  return html`${others.length > 0 &&
    html`<div class="found-others">${others.map((r) => html`<${OtherRow} key=${r.id} r=${r} actions=${actions} />`)}</div>`}
    ${items.length > 0 &&
    html`<div class="rows found-items">
      ${items.map((r) => html`<${ItemRow} key=${r.id} item=${itemsById.get(r.itemId)} why=${reasonOf(r)} onOpen=${actions.open} onStatus=${actions.cycleStatus} today=${today} />`)}
    </div>`}`;
}

/**
 * `found`: { question, status: 'asking' | 'done' | 'error', phase, plan, results, encrypted, more, picked, error }.
 * `itemsById`: the live items; `canAssist`: whether the assistant can take them.
 */
export function FoundView({ found, itemsById, actions, today, canAssist }) {
  const [more, setMore] = useState(false);
  if (found.status === 'asking') {
    return html`<div class="found-view">
      <p class="found-status muted"><${Icon} name="sync" size=${15} class="spin" /> ${PHASES[found.phase] ?? 'Searching…'}
        <button type="button" class="btn ghost sm" onClick=${actions.clearFound}><${Icon} name="stop" size=${14} />Stop</button></p>
    </div>`;
  }
  if (found.status === 'error') {
    return html`<div class="found-view"><p class="notice error"><${Icon} name="alert" size=${15} /><span>Could not search: ${found.error}</span></p></div>`;
  }
  const { results, encrypted, plan } = found;
  const nothing = !results.length && !encrypted.length;
  const foundItems = results.filter((r) => r.kind === 'item' && itemsById.has(r.itemId));
  return html`<div class="found-view">
    <div class="found-head">
      <p class="muted small found-plan" title="What the search looked for">${plan.plain ? 'Matched the words of your question' : `Looked for ${planWords(plan) || 'everything'}`}${found.picked ? ' · the model picked these' : ''}</p>
      <span class="spacer" />
      ${canAssist && foundItems.length > 0 &&
      html`<button type="button" class="btn ghost sm" title="The assistant sees these items: “tag these #docker”, “move these to next week”…" onClick=${() => actions.assistant()}><${Icon} name="sparkle" size=${15} />Ask the assistant about these</button>`}
    </div>
    ${nothing &&
    html`<${EmptyState} icon="search" title="Nothing found"><p>Nothing here answers “${found.question}”. Try other words, or a project or tag.</p></${EmptyState}>`}
    <${Results} list=${results} itemsById=${itemsById} actions=${actions} today=${today} />
    ${encrypted.length > 0 &&
    html`<section class="found-locked">
      <h3><${Icon} name="eye" size=${15} />Encrypted in Tracker Editor <span class="muted small">${encrypted.length}</span></h3>
      <p class="muted small">Found by their names only: what they hold is never read here or sent to the model. They open in Tracker Editor, with your passphrase.</p>
      <div class="found-others">${encrypted.map((r) => html`<${OtherRow} key=${r.id} r=${{ ...r, why: '' }} actions=${actions} />`)}</div>
    </section>`}
    ${found.more?.length > 0 &&
    html`<div class="found-more">
      <button type="button" class="btn link" aria-expanded=${more} onClick=${() => setMore(!more)}>${more ? 'Fewer' : `${found.more.length} more that match`}</button>
      ${more && html`<${Results} list=${found.more} itemsById=${itemsById} actions=${actions} today=${today} />`}
    </div>`}
  </div>`;
}
