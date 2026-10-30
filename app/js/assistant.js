// The model in the tracker (set up as in Tracker Editor): a client from
// Settings, and the requests the app makes with it. The prompts and the
// checking of replies are in assist.js.
import { itemMessages, parseQuickAddReply, planMessages, quickAddMessages } from './assist.js';
import { asyncClient } from './asyncConnection.js';
import { localFetch } from './localFetch.js';
import { createModelClient } from './providers.js';
import { getSecret, getSettings } from './settings.js';

/** A client for the model in Settings: a server on this computer, an AI provider (Claude…), or a service that answers later. */
export function llmClient(settings = getSettings()) {
  if (settings.llm.provider === 'async') return asyncClient(settings);
  return createModelClient(settings.llm, { getSecret, fetchImpl: localFetch });
}

/** Whether a model is connected and turned on. */
export const modelReady = (settings = getSettings()) => Boolean(settings.llm.enabled && settings.llm.chatModel);

const chat = (options) => {
  const { llm } = getSettings();
  return llmClient().chat({ model: llm.chatModel, ...options });
};

/** Item fields for a quick-add line in plain language (null when the model's reply is no use). */
export async function readQuickAdd(input, context) {
  const reply = await chat({ messages: quickAddMessages(input, context), purpose: 'quick-add', temperature: 0.1, signal: AbortSignal.timeout?.(90000) });
  return parseQuickAddReply(reply, context);
}

/** An answer about an item (streamed through `onToken`). */
export const askAboutItem = (action, item, documents, { history = [], signal, onToken, onState } = {}) =>
  chat({ messages: itemMessages(action, item, documents, history), purpose: 'ask', signal, onToken, onState });

/** A plan for today ('day') or a review of the week ('week'), streamed; with `previous` and `changes`, that one updated. */
export const planWith = (items, { kind, today, previous, changes, signal, onToken, onState }) =>
  chat({ messages: planMessages(items, { kind, today, previous, changes }), purpose: 'plan', signal, onToken, onState });
