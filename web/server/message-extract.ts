// ─── Shared BrowserIncomingMessage extraction helpers ────────────────────────
//
// Pure functions for pulling text / tool activity out of the bridge's
// message stream. Used by consumers that tap companionBus message events
// (linear-agent-bridge, magic-ui-watcher).

import type { BrowserIncomingMessage } from "./session-types.js";

/** Content blocks of an assistant message, or null. */
export function getAssistantContent(msg: BrowserIncomingMessage): unknown[] | null {
  if (msg.type !== "assistant") return null;
  // Assistant messages carry content blocks at msg.message.content
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content : null;
}

/** Extract text from assistant message content blocks */
export function extractTextFromAssistant(msg: BrowserIncomingMessage): string {
  const content = getAssistantContent(msg);
  if (!content) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Extract text deltas from stream events. */
export function extractTextDeltaFromStreamEvent(msg: BrowserIncomingMessage): string {
  if (msg.type !== "stream_event") return "";
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "content_block_delta") return "";
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return "";
  return delta.text;
}

/** Extract all tool use blocks from assistant message content (with raw input for plan extraction) */
export function extractToolUses(msg: BrowserIncomingMessage): Array<{ id?: string; name: string; input: string; rawInput?: Record<string, unknown> }> {
  const content = getAssistantContent(msg);
  if (!content) return [];
  return content
    .filter((b): b is { type: string; id?: string; name: string; input?: Record<string, unknown> } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_use"
      && typeof (b as Record<string, unknown>).name === "string")
    .map((toolBlock) => ({
      id: typeof toolBlock.id === "string" ? toolBlock.id : undefined,
      name: toolBlock.name,
      input: toolBlock.input ? JSON.stringify(toolBlock.input).slice(0, 200) : "",
      rawInput: toolBlock.input,
    }));
}

/** Extract tool_result blocks from assistant message content. */
export function extractToolResults(msg: BrowserIncomingMessage): Array<{ tool_use_id: string; content: string }> {
  const content = getAssistantContent(msg);
  if (!content) return [];
  return content
    .filter((b): b is { type: string; tool_use_id: string; content?: unknown } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_result"
      && typeof (b as Record<string, unknown>).tool_use_id === "string")
    .map((block) => ({
      tool_use_id: block.tool_use_id,
      content: typeof block.content === "string"
        ? block.content.slice(0, 500)
        : Array.isArray(block.content)
          ? (block.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
            .slice(0, 500)
          : "",
    }));
}
