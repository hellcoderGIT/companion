import type { BrowserIncomingMessage } from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";
import type { SessionStore, PersistedSession } from "./session-store.js";

// ─── Persistence Pipeline ───────────────────────────────────────────────────
// Extracted from WsBridge to consolidate history append + disk persistence
// into explicit, testable functions.

export const MESSAGE_HISTORY_LIMIT = 2000;

/**
 * Append a message to session history with cap enforcement, then persist to disk.
 * Consolidates the common appendHistory + persistSession pattern into one call,
 * eliminating the risk of appending without persisting.
 */
export function appendAndPersist(
  session: Session,
  msg: BrowserIncomingMessage,
  store: SessionStore | null,
  historyLimit: number = MESSAGE_HISTORY_LIMIT,
): void {
  appendHistory(session, msg, historyLimit);
  persistSession(session, store);
}

/**
 * Append a message to session history with cap enforcement.
 * Trims oldest messages when the history exceeds the limit.
 */
export function appendHistory(
  session: Session,
  msg: BrowserIncomingMessage,
  historyLimit: number = MESSAGE_HISTORY_LIMIT,
): void {
  session.messageHistory.push(msg);
  if (session.messageHistory.length > historyLimit) {
    session.messageHistory.splice(0, session.messageHistory.length - historyLimit);
  }
}

/**
 * Persist session state to disk (debounced via SessionStore).
 * No-op if no store is attached.
 */
export function persistSession(session: Session, store: SessionStore | null): void {
  if (!store) return;
  store.save(serializeForStore(session));
}

/**
 * Serialize a Session into the shape expected by SessionStore.save().
 * Converts Maps to arrays and selects the persisted fields.
 */
export function serializeForStore(session: Session): PersistedSession {
  return {
    id: session.id,
    state: session.state,
    messageHistory: session.messageHistory,
    pendingMessages: session.pendingMessages,
    pendingPermissions: Array.from(session.pendingPermissions.entries()),
    eventBuffer: session.eventBuffer,
    nextEventSeq: session.nextEventSeq,
    lastAckSeq: session.lastAckSeq,
    processedClientMessageIds: session.processedClientMessageIds,
    lastUserMessageAt: session.lastUserMessageAt,
  };
}

/**
 * Timestamp of the newest user_message in a history, or undefined if there is
 * none. Used to backfill Session.lastUserMessageAt for sessions persisted
 * before that field existed (history is capped, so very old sessions whose
 * last prompt scrolled out simply fall back to createdAt on the client).
 */
export function findLastUserMessageAt(history: BrowserIncomingMessage[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.type === "user_message" && typeof msg.timestamp === "number" && msg.timestamp > 0) {
      return msg.timestamp;
    }
  }
  return undefined;
}
