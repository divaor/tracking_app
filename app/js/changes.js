// Turns "before" and "after" item lists into notification-ready events:
// what changed, who changed it and which notification category it is in.
import { CLAUDE_AUTHOR, kindLabel, statusLabel, typeInfo } from './model.js';

const noun = (item) => (kindLabel(item.type, item.kind) || typeInfo(item.type).label).toLowerCase();
const fileSignature = (item) => (item.files ?? []).map((f) => `${f.path}@${f.sha}`).join('|');
const isReviewDoc = (item) => item.type === 'doc' && ((item.files ?? []).length > 0 || ['proposal', 'artifact'].includes(item.kind));

/**
 * @returns {{category: 'documents'|'items', title: string, body: string, itemId?: string, by: string, fromClaude: boolean}[]}
 */
export function describeChanges(before, after, { self = '' } = {}) {
  const prev = new Map(before.map((i) => [i.id, i]));
  const events = [];
  for (const item of after) {
    const old = prev.get(item.id);
    if (old && old.updatedAt === item.updatedAt) continue;
    const by = item.updatedBy || '';
    if (self && by === self) continue;
    const fromClaude = by === CLAUDE_AUTHOR;
    const who = by || 'Another device';
    const base = { by: who, fromClaude, itemId: item.deleted ? undefined : item.id };

    if (item.deleted) {
      if (old && !old.deleted) events.push({ ...base, category: 'items', title: `${who} deleted a ${noun(old)}`, body: old.title });
      continue;
    }
    if (!old || old.deleted) {
      if (isReviewDoc(item)) {
        const what = ['proposal', 'artifact'].includes(item.kind) ? `New ${noun(item)} to review` : 'New document to read';
        events.push({ ...base, category: 'documents', title: what, body: item.title });
      } else {
        events.push({ ...base, category: 'items', title: `${who} added a ${noun(item)}`, body: item.title });
      }
      continue;
    }
    if (fileSignature(item) !== fileSignature(old) && (item.files ?? []).length) {
      events.push({ ...base, category: 'documents', title: 'New version ready to review', body: item.title });
    } else if (item.status !== old.status) {
      events.push({ ...base, category: 'items', title: `${who} marked a ${noun(item)} ${statusLabel(item.status, item.type).toLowerCase()}`, body: item.title });
    } else if ((item.decision ?? '') !== (old.decision ?? '') && item.decision) {
      events.push({ ...base, category: 'documents', title: `${who} reviewed a ${noun(item)}`, body: item.title });
    } else if (Boolean(item.pinned) !== Boolean(old.pinned)) {
      events.push({ ...base, category: 'items', title: `${who} ${item.pinned ? 'pinned' : 'unpinned'} a ${noun(item)}`, body: item.title });
    } else {
      events.push({ ...base, category: 'items', title: `${who} updated a ${noun(item)}`, body: item.title });
    }
  }
  return events;
}

/** Folds several events into one notification. */
export function summarizeEvents(events) {
  if (events.length === 1) return { title: events[0].title, body: events[0].body, itemId: events[0].itemId };
  const fromClaude = events.every((e) => e.fromClaude);
  const titles = events.map((e) => e.body).filter(Boolean);
  const shown = titles.slice(0, 3).join(', ');
  return {
    title: `${fromClaude ? CLAUDE_AUTHOR : 'Your tracker'}: ${events.length} changes`,
    body: titles.length > 3 ? `${shown} and ${titles.length - 3} more` : shown,
  };
}
