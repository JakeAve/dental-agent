import { CHAT_TTL_MS, MAX_CHATS } from './config';
import { createSession, type Session } from './session';

/**
 * Tool state for the browser chat, keyed by conversation id.
 *
 * The browser already posts the whole transcript on every turn, so the *model*
 * needs no server memory. The *tools* do. They take no patient id — they read
 * `session.patient.id` — and `holdSlot` resolves a short ref the previous turn
 * put in `session.slotRefs`. Rebuilt fresh per request, as the route used to do,
 * every multi-turn booking dies at the hold with "no patient on file".
 *
 * Separate from run-store.ts on purpose. That one also owns the message list
 * and per-turn replay, because the evaluation protocol hands us only visible
 * history and retries turns. Neither applies here, and folding this into it
 * would mean carrying a message list that `useChat` already owns.
 *
 * In-memory suits a dev server driven by hand. Multiple instances would want
 * Redis; the interface would not change.
 */

type Chat = {
  session: Session;
  lastTouched: number;
};

const chats = new Map<string, Chat>();

function evict(now: number) {
  for (const [id, chat] of chats) {
    if (now - chat.lastTouched > CHAT_TTL_MS) chats.delete(id);
  }

  if (chats.size > MAX_CHATS) {
    const ordered = [...chats.entries()].sort(
      (a, b) => a[1].lastTouched - b[1].lastTouched,
    );
    for (const [id] of ordered.slice(0, chats.size - MAX_CHATS)) chats.delete(id);
  }
}

/** The session for this conversation, created on first sight. */
export function getChatSession(conversationId: string): Session {
  const now = Date.now();
  evict(now);

  let chat = chats.get(conversationId);

  if (!chat) {
    chat = { session: createSession(), lastTouched: now };
    chats.set(conversationId, chat);
  }

  chat.lastTouched = now;
  return chat.session;
}

/** Drop a conversation's state. The UI calls this when you start a new chat. */
export function clearChatSession(conversationId: string) {
  chats.delete(conversationId);
}

/** Test seam. */
export function clearChats() {
  chats.clear();
}
