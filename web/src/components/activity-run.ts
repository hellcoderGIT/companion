import type { ChatMessage, ContentBlock } from "../types.js";
import type { FeedEntry } from "./MessageFeed.js";
import { getToolLabel, getPreview } from "./ToolBlock.js";

/**
 * Compact-density folding of "activity runs".
 *
 * Every contiguous stretch of *work* between two pieces of real output — a
 * user message, an assistant answer (text with no tool calls), or the live
 * streaming draft — is folded into a single `activity_run` entry. In the feed
 * that run renders as one header line plus the latest action, instead of one
 * avatar row + tool card + summary strip per turn-step.
 *
 * Standard density never calls this; the fold is purely a view concern and
 * works on `ChatMessage` shapes only, so it applies equally to Claude Code and
 * Codex sessions.
 */
export interface ActivityRun {
  kind: "activity_run";
  /** Stable key — the id of the first child, which never changes as the run grows. */
  key: string;
  children: FeedEntry[];
}

/** What the collapsed run shows as its single "latest action" line. */
export interface LatestAction {
  label: string;
  /** Set when the action was a tool call — lets the UI show the tool's icon. */
  toolName?: string;
  /** Narration (thinking / interstitial text / system line) rather than a tool call. */
  italic?: boolean;
}

export interface RunSummary {
  /** Top-level tool calls (subagent-internal calls are not counted). */
  toolCalls: number;
  subagents: number;
  errors: number;
  /** Number of feed entries folded into this run. */
  steps: number;
  startedAt: number | null;
  endedAt: number | null;
  latest: LatestAction | null;
}

function hasText(msg: ChatMessage): boolean {
  const blocks = msg.contentBlocks;
  if (blocks && blocks.length > 0) {
    return blocks.some((b) => b.type === "text" && b.text.trim().length > 0);
  }
  return Boolean(msg.content?.trim());
}

/**
 * Is this entry something the user actually wants to read, as opposed to the
 * agent's in-progress work?
 *
 * - user messages: always
 * - system lines: only Companion meta notices (interruptions, resume issues);
 *   ordinary hook / task-completed lines are part of the work
 * - assistant: the live streaming draft (it is the tail and must stay visible),
 *   or a finished message with text and no tool calls — i.e. the answer.
 *   Text that shares a message with tool calls is narration ("Now I'll check
 *   the prod data…") and folds with the work.
 */
export function isRealOutput(entry: FeedEntry): boolean {
  if (entry.kind !== "message") return false;
  const msg = entry.msg;
  if (msg.role === "user") return true;
  if (msg.role === "system") return Boolean(msg.meta);
  if (msg.isStreaming) return true;
  if (msg.stopReason === "tool_use") return false;
  const blocks = msg.contentBlocks;
  if (blocks?.some((b) => b.type === "tool_use")) return false;
  return hasText(msg);
}

function entryKey(entry: FeedEntry): string {
  switch (entry.kind) {
    case "message":
      return entry.msg.id;
    case "tool_msg_group":
      return entry.firstId;
    case "subagent":
      return entry.taskToolUseId;
    case "activity_run":
      return entry.key;
  }
}

/**
 * A lone ordinary system line ("Context compacted successfully") is already a
 * single quiet line — wrapping it in a run would add a header for nothing.
 * Anything else (even a single tool step) is shorter as a run.
 */
function shouldFold(pending: FeedEntry[]): boolean {
  if (pending.length >= 2) return true;
  const only = pending[0];
  return !(only.kind === "message" && only.msg.role === "system");
}

/** Fold top-level entries; already-folded runs pass through untouched. */
export function foldActivityRuns(entries: FeedEntry[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  let pending: FeedEntry[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (shouldFold(pending)) {
      out.push({ kind: "activity_run", key: entryKey(pending[0]), children: pending });
    } else {
      out.push(...pending);
    }
    pending = [];
  };

  for (const entry of entries) {
    if (entry.kind === "activity_run" || isRealOutput(entry)) {
      flush();
      out.push(entry);
    } else {
      pending.push(entry);
    }
  }
  flush();
  return out;
}

const LATEST_MAX_CHARS = 160;

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > LATEST_MAX_CHARS ? `${line.slice(0, LATEST_MAX_CHARS)}…` : line;
}

function toolAction(name: string, input: Record<string, unknown>): LatestAction {
  const preview = getPreview(name, input);
  return {
    label: preview ? `${getToolLabel(name)} · ${preview}` : getToolLabel(name),
    toolName: name,
  };
}

/** Last meaningful block of a message, scanning from the end and skipping tool results. */
function latestFromBlocks(blocks: ContentBlock[]): LatestAction | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "tool_use") return toolAction(b.name, b.input);
    if (b.type === "text" && b.text.trim()) return { label: firstLine(b.text), italic: true };
    if (b.type === "thinking" && b.thinking.trim()) {
      return { label: firstLine(b.thinking), italic: true };
    }
  }
  return null;
}

function latestFromEntry(entry: FeedEntry): LatestAction | null {
  switch (entry.kind) {
    case "subagent":
      return { label: `Subagent · ${entry.description || "Subagent"}`, toolName: "Task" };
    case "tool_msg_group": {
      const last = entry.items[entry.items.length - 1];
      return last ? toolAction(last.name, last.input) : null;
    }
    case "activity_run":
      return summarizeRun(entry).latest;
    case "message": {
      const msg = entry.msg;
      if (msg.role === "system") return { label: msg.content, italic: true };
      const blocks = msg.contentBlocks;
      if (blocks && blocks.length > 0) {
        return latestFromBlocks(blocks) ?? { label: "Thinking…", italic: true };
      }
      if (msg.content?.trim()) return { label: firstLine(msg.content), italic: true };
      return { label: "Thinking…", italic: true };
    }
  }
}

function subagentTimestamps(entry: FeedEntry): [number | null, number | null] {
  switch (entry.kind) {
    case "message":
      return [entry.msg.timestamp, entry.msg.timestamp];
    case "tool_msg_group":
      return [entry.startedAt, entry.endedAt];
    case "subagent": {
      let start: number | null = null;
      let end: number | null = null;
      for (const child of entry.children) {
        const [s, e] = subagentTimestamps(child);
        if (s !== null && (start === null || s < start)) start = s;
        if (e !== null && (end === null || e > end)) end = e;
      }
      return [start, end];
    }
    case "activity_run": {
      const s = summarizeRun(entry);
      return [s.startedAt, s.endedAt];
    }
  }
}

/**
 * Aggregate stats for the run header. `now` extends `endedAt` for a live run
 * so the elapsed time keeps ticking while the agent is still working.
 */
export function summarizeRun(run: ActivityRun, now?: number): RunSummary {
  let toolCalls = 0;
  let subagents = 0;
  let errors = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;

  for (const child of run.children) {
    if (child.kind === "subagent") {
      subagents++;
    } else if (child.kind === "tool_msg_group") {
      toolCalls += child.items.length;
    } else if (child.kind === "message") {
      for (const b of child.msg.contentBlocks ?? []) {
        if (b.type === "tool_use") toolCalls++;
        if (b.type === "tool_result" && b.is_error) errors++;
      }
    } else {
      const nested = summarizeRun(child);
      toolCalls += nested.toolCalls;
      subagents += nested.subagents;
      errors += nested.errors;
    }
    const [s, e] = subagentTimestamps(child);
    if (s !== null && (startedAt === null || s < startedAt)) startedAt = s;
    if (e !== null && (endedAt === null || e > endedAt)) endedAt = e;
  }

  if (now !== undefined && startedAt !== null) {
    endedAt = Math.max(endedAt ?? now, now);
  }

  const last = run.children[run.children.length - 1];
  return {
    toolCalls,
    subagents,
    errors,
    steps: run.children.length,
    startedAt,
    endedAt,
    latest: last ? latestFromEntry(last) : null,
  };
}
