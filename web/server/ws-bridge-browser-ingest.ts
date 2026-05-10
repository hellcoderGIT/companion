import type { BrowserOutgoingMessage } from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";
import {
  isDuplicateClientMessage,
  rememberClientMessage,
} from "./ws-bridge-replay.js";

// ─── Attachment limits (server-side, mirrors client) ────────────────────────
// Re-validated server-side because clients can lie. Keep these in sync
// with web/src/utils/attachment.ts.
export const MAX_ATTACHMENT_BYTES = Number(process.env.COMPANION_MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024);
export const MAX_TOTAL_ATTACHMENT_BYTES = Number(process.env.COMPANION_MAX_TOTAL_ATTACHMENT_BYTES || 100 * 1024 * 1024);

/**
 * Validate the attachments on an outgoing user_message. Returns null when
 * all attachments pass, or a human-readable error message describing the
 * first violation otherwise.
 */
export function validateAttachments(
  attachments: { name: string; media_type: string; data: string; size: number }[] | undefined,
): string | null {
  if (!attachments?.length) return null;
  let total = 0;
  for (const att of attachments) {
    if (typeof att.size !== "number" || att.size < 0) {
      return `Attachment "${att.name}" has an invalid size`;
    }
    if (att.size > MAX_ATTACHMENT_BYTES) {
      return `Attachment "${att.name}" exceeds the per-file limit (${MAX_ATTACHMENT_BYTES} bytes)`;
    }
    total += att.size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      return `Total attachment size exceeds the per-message limit (${MAX_TOTAL_ATTACHMENT_BYTES} bytes)`;
    }
    if (typeof att.data !== "string" || att.data.length === 0) {
      return `Attachment "${att.name}" has no data`;
    }
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(att.data)) {
      return `Attachment "${att.name}" is not valid base64`;
    }
    // Best-effort sanity check: declared size vs base64 length. Allow slack
    // for padding/whitespace, but catch wildly mismatched payloads.
    const expectedB64Len = Math.ceil(att.size / 3) * 4;
    const actualB64Len = att.data.replace(/\s/g, "").length;
    if (Math.abs(actualB64Len - expectedB64Len) > 8) {
      return `Attachment "${att.name}" size does not match its data length`;
    }
  }
  return null;
}

// ─── Browser Ingest Pipeline ────────────────────────────────────────────────
// Pure functions for parsing and deduplicating browser WebSocket messages.
// Extracted from WsBridge.handleBrowserMessage and routeBrowserMessage
// to enable isolated testing of idempotent message scenarios.

/** Message types that support client_msg_id-based deduplication. */
export const IDEMPOTENT_BROWSER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
  "set_ai_validation",
]);

/**
 * Parse a raw browser WebSocket message into a typed BrowserOutgoingMessage.
 * Returns null if parsing fails (malformed JSON).
 */
export function parseBrowserMessage(raw: string | Buffer): BrowserOutgoingMessage | null {
  const data = typeof raw === "string" ? raw : raw.toString("utf-8");
  try {
    return JSON.parse(data) as BrowserOutgoingMessage;
  } catch {
    console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
    return null;
  }
}

/**
 * Check if a browser message is a duplicate based on client_msg_id.
 * Returns true if the message should be skipped.
 *
 * Only checks messages whose type is in `idempotentTypes` and that have
 * a non-empty `client_msg_id` field. For non-idempotent types or messages
 * without client_msg_id, always returns false.
 *
 * If not a duplicate, remembers the client_msg_id for future dedup checks.
 */
export function deduplicateBrowserMessage(
  msg: BrowserOutgoingMessage,
  idempotentTypes: ReadonlySet<string>,
  session: Session,
  processedIdLimit: number,
  persistFn: (session: Session) => void,
): boolean {
  if (
    !idempotentTypes.has(msg.type)
    || !("client_msg_id" in msg)
    || !msg.client_msg_id
  ) {
    return false;
  }

  if (isDuplicateClientMessage(session, msg.client_msg_id)) {
    return true;
  }

  rememberClientMessage(session, msg.client_msg_id, processedIdLimit, persistFn);
  return false;
}
