// The assistant's chats kept on this device (assistantChats.js, assistantChatStore.js), as a list
// inside its panel: those about the item open, its project, all of them, the saved ones; words
// find one; each opens again, is saved for good (☆), renamed or deleted (with Undo).
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { CHAT_FILTERS, filterChats, filterCounts, linkLabel } from '../assistantChats.js';
import { assistantChats } from '../assistantChatStore.js';
import { timeAgo } from '../format.js';
import { Icon } from './icons.js';

/** The chats as the store has them now; re-renders when they change. */
export function useAssistantChats() {
  const [, bump] = useState(0);
  useEffect(() => {
    let live = true;
    assistantChats.ready().then(() => live && bump((n) => n + 1));
    const off = assistantChats.subscribe(() => bump((n) => n + 1));
    return () => {
      live = false;
      off();
    };
  }, []);
  return assistantChats.list();
}

/** Deletes a chat, with Undo in the message (it comes back in its place). */
export async function deleteChat(row, { toast, onDeleted } = {}) {
  const chat = await assistantChats.remove(row.id);
  onDeleted?.(row.id);
  toast?.(`Deleted the chat “${row.title}”`, chat ? { action: { label: 'Undo', run: () => assistantChats.restore(chat) }, timeout: 8000 } : {});
}

/** `here`: { itemId, itemTitle, project } of what is open now; `currentId`: the chat shown. */
export function ChatList({ here = {}, currentId = null, onOpen, onDeleted, toast }) {
  const rows = useAssistantChats();
  const counts = filterCounts(rows, here);
  const [show, setShow] = useState(() => (here.itemId && counts.here ? 'here' : here.project && counts.project ? 'project' : 'all'));
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState(null); // { id, title }
  const search = useRef(null);
  useLayoutEffect(() => search.current?.focus(), []);
  const filters = CHAT_FILTERS.filter((f) => (f.id === 'here' ? here.itemId : f.id === 'project' ? here.project : true));
  const shown = filterChats(rows, { show, itemId: here.itemId, project: here.project, query });
  const rename = async () => {
    const { id, title } = renaming;
    setRenaming(null);
    await assistantChats.rename(id, title);
  };
  const chipLabel = (f) => (f.id === 'project' ? here.project : f.id === 'here' ? 'This item' : f.label);
  const empty = query ? 'No chat has those words.' : show === 'saved' ? 'No saved chats yet: ☆ saves one for good.' : show === 'here' ? 'No chats about this item yet.' : show === 'project' ? `No chats about ${here.project} yet.` : 'No chats yet. They are kept on this device as you ask.';

  return html`<div class="aic-list">
    <div class="aic-top">
      <div class="aic-filters" role="group" aria-label="Which chats">
        ${filters.map(
          (f) => html`<button type="button" key=${f.id} class=${`tag aip-chip ${show === f.id ? 'on' : ''}`} aria-pressed=${show === f.id}
            title=${f.id === 'here' ? `The chats about ${here.itemTitle ?? 'this item'}` : f.id === 'saved' ? 'The chats you saved: kept for good' : ''} onClick=${() => setShow(f.id)}>
            ${chipLabel(f)}<span class="aic-count">${counts[f.id]}</span>
          </button>`,
        )}
      </div>
      <div class="search aic-search">
        <${Icon} name="search" size=${15} />
        <input ref=${search} type="search" value=${query} placeholder="Find a chat" aria-label="Find a chat" onInput=${(e) => setQuery(e.currentTarget.value)}
          onKeyDown=${(e) => e.key === 'Escape' && query && (e.preventDefault(), e.stopPropagation(), setQuery(''))} />
      </div>
    </div>
    ${!shown.length && html`<p class="muted small aic-empty">${empty}</p>`}
    <ul class="aic-rows">
      ${shown.map((r) => {
        const about = linkLabel(r.link);
        return html`<li key=${r.id} class=${`aic-row ${r.id === currentId ? 'current' : ''}`}>
          ${renaming?.id === r.id
            ? html`<${RenameField} value=${renaming.title} onInput=${(title) => setRenaming({ ...renaming, title })} onDone=${rename} onCancel=${() => setRenaming(null)} />`
            : html`<button type="button" class="aic-open" title=${about ? `About ${about}` : 'Open this chat'} onClick=${() => onOpen(r)}>
                <span class="aic-title">${r.title}</span>
                <span class="aic-meta">${about && html`<span class="aic-about">${about}</span>`}<span>${timeAgo(r.updatedAt)}</span></span>
                ${r.preview && html`<span class="aic-preview">${r.preview}</span>`}
              </button>
              <span class="aic-tools">
                <button type="button" class=${`icon-btn sm aic-star ${r.saved ? 'on' : ''}`} aria-pressed=${r.saved} aria-label=${r.saved ? 'Saved: kept for good (click to unsave)' : 'Save it: kept for good'} title=${r.saved ? 'Saved: kept for good' : 'Save: kept for good (the others go after the newest 300)'}
                  onClick=${() => assistantChats.setSaved(r.id, !r.saved)}><${Icon} name="star" size=${15} /></button>
                <button type="button" class="icon-btn sm" aria-label="Rename" title="Rename" onClick=${() => setRenaming({ id: r.id, title: r.title })}><${Icon} name="edit" size=${15} /></button>
                <button type="button" class="icon-btn sm" aria-label="Delete" title="Delete (Undo in the message)" onClick=${() => deleteChat(r, { toast, onDeleted })}><${Icon} name="trash" size=${15} /></button>
              </span>`}
        </li>`;
      })}
    </ul>
    <p class="muted small aic-foot">Kept on this device only, never synced.</p>
  </div>`;
}

/** A chat's name being changed: Enter keeps it, Escape leaves it as it was. */
function RenameField({ value, onInput, onDone, onCancel }) {
  const input = useRef(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return html`<form class="aic-rename" onSubmit=${(e) => (e.preventDefault(), value.trim() && onDone())}>
    <input ref=${input} value=${value} aria-label="The chat’s name" onInput=${(e) => onInput(e.currentTarget.value)}
      onKeyDown=${(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onCancel())} />
    <button type="submit" class="btn sm primary" disabled=${!value.trim()}>Rename</button>
  </form>`;
}

/** The head's buttons: ☆ (when there is a chat), the list, New chat. */
export function ChatButtons({ chatId, saved = false, listOpen = false, busy = false, onToggleList, onNew }) {
  return html`${chatId &&
    html`<button type="button" class=${`icon-btn sm aic-star ${saved ? 'on' : ''}`} aria-pressed=${saved} aria-label=${saved ? 'Saved: kept for good (click to unsave)' : 'Save this chat: kept for good'}
      title=${saved ? 'Saved: kept for good' : 'Save this chat: kept for good (others go after the newest 300)'} onClick=${() => assistantChats.setSaved(chatId, !saved)}><${Icon} name="star" size=${16} /></button>`}
    <button type="button" class=${`icon-btn sm aic-list-btn ${listOpen ? 'on' : ''}`} aria-pressed=${listOpen} aria-label="Chats" title="Chats: this item’s, this project’s, all of them" onClick=${onToggleList}><${Icon} name="history" size=${16} /></button>
    ${chatId && html`<button type="button" class="btn ghost sm aic-new" disabled=${busy} title="A new chat (this one stays in Chats)" onClick=${onNew}><${Icon} name="plus" size=${14} /><span class="label">New chat</span></button>`}`;
}

/** The line at the top of a chat taken up again: when it began, and what it is about. */
export function KeptNote({ chat }) {
  if (!chat?.createdAt) return null;
  const about = linkLabel(chat.link);
  const when = new Date(chat.createdAt);
  const day = Number.isNaN(when.getTime()) ? '' : when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return html`<p class="muted small aic-kept"><${Icon} name="history" size=${13} /><span>A chat kept from ${day}${about ? ` · ${about}` : ''}</span></p>`;
}
