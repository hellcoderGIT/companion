import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import type { FeedEntry } from "./MessageFeed.js";
import {
  foldActivityRuns,
  isRealOutput,
  summarizeRun,
  type ActivityRun,
} from "./activity-run.js";

/**
 * Pure-logic tests for compact-mode activity-run folding. These cover the
 * boundary rules (what counts as "real output") and the header summary, so
 * the component tests can focus on rendering.
 */

let seq = 0;
function msg(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): FeedEntry {
  seq += 1;
  return {
    kind: "message",
    msg: { id: `m${seq}`, content: "", timestamp: 1_000 + seq * 1_000, ...overrides },
  };
}

// A thinking + tool_use turn-step: the shape that defeats the feed's plain
// same-tool grouping and produced the "Terminal 5 / Terminal 5 / …" wall.
function toolStep(command: string, extra: Partial<ChatMessage> = {}): FeedEntry {
  return msg({
    role: "assistant",
    stopReason: "tool_use",
    contentBlocks: [
      { type: "thinking", thinking: "" },
      { type: "tool_use", id: `tu-${++seq}`, name: "Bash", input: { command } },
      { type: "tool_result", tool_use_id: `tu-${seq}`, content: "ok" },
    ],
    ...extra,
  });
}

const user = (text: string) => msg({ role: "user", content: text });
const answer = (text: string) =>
  msg({
    role: "assistant",
    content: text,
    stopReason: "end_turn",
    contentBlocks: [{ type: "text", text }],
  });

describe("isRealOutput", () => {
  it("treats user messages and final assistant answers as real output", () => {
    expect(isRealOutput(user("hi"))).toBe(true);
    expect(isRealOutput(answer("Done."))).toBe(true);
  });

  it("treats tool steps and narration-with-tools as work, not output", () => {
    expect(isRealOutput(toolStep("ls"))).toBe(false);
    // Text that shares a message with a tool call is interstitial narration.
    const narration = msg({
      role: "assistant",
      contentBlocks: [
        { type: "text", text: "Now I'll check the prod data shape." },
        { type: "tool_use", id: "tu-n", name: "Bash", input: { command: "psql" } },
      ],
    });
    expect(isRealOutput(narration)).toBe(false);
  });

  it("keeps the live streaming draft visible (never folds the tail)", () => {
    expect(
      isRealOutput(msg({ role: "assistant", isStreaming: true, content: "typing" })),
    ).toBe(true);
  });

  it("folds ordinary system lines but keeps Companion meta notices visible", () => {
    expect(isRealOutput(msg({ role: "system", content: "Task completed: abc" }))).toBe(false);
    expect(
      isRealOutput(msg({ role: "system", content: "Session was interrupted", meta: true })),
    ).toBe(true);
  });

  it("never folds tool groups or subagent containers into 'real output'", () => {
    const group: FeedEntry = {
      kind: "tool_msg_group",
      toolName: "Bash",
      items: [{ id: "a", name: "Bash", input: {} }],
      firstId: "a",
      startedAt: 1,
      endedAt: 2,
    };
    expect(isRealOutput(group)).toBe(false);
  });
});

describe("foldActivityRuns", () => {
  it("folds everything between a user message and the answer into one run", () => {
    const entries = [
      user("fix it"),
      toolStep("git status"),
      toolStep("npm test"),
      msg({ role: "system", content: "Task completed: brnbk6cys" }),
      answer("All green."),
    ];
    const folded = foldActivityRuns(entries);
    expect(folded.map((e) => e.kind)).toEqual(["message", "activity_run", "message"]);
    const run = folded[1] as ActivityRun;
    expect(run.children).toHaveLength(3);
    // Key is the first child's id so it stays stable as the run grows.
    expect(run.key).toBe((entries[1] as { kind: "message"; msg: ChatMessage }).msg.id);
  });

  it("keeps a trailing run open when the turn has not produced an answer yet", () => {
    const folded = foldActivityRuns([user("go"), toolStep("a"), toolStep("b")]);
    expect(folded.map((e) => e.kind)).toEqual(["message", "activity_run"]);
  });

  it("does not wrap a lone ordinary system line in a run", () => {
    const folded = foldActivityRuns([
      user("go"),
      msg({ role: "system", content: "Context compacted successfully" }),
      answer("ok"),
    ]);
    expect(folded.map((e) => e.kind)).toEqual(["message", "message", "message"]);
  });

  it("folds even a single tool step (one header beats avatar + card + summary)", () => {
    const folded = foldActivityRuns([user("go"), toolStep("a"), answer("ok")]);
    expect(folded.map((e) => e.kind)).toEqual(["message", "activity_run", "message"]);
  });

  it("is idempotent — already-folded runs pass through untouched", () => {
    const once = foldActivityRuns([user("go"), toolStep("a"), toolStep("b"), answer("ok")]);
    expect(foldActivityRuns(once)).toEqual(once);
  });
});

describe("summarizeRun", () => {
  it("counts tool calls, errors and subagents and reports the latest action", () => {
    const run: ActivityRun = {
      kind: "activity_run",
      key: "k",
      children: [
        toolStep("git status"),
        msg({
          role: "assistant",
          contentBlocks: [
            { type: "tool_use", id: "tu-e", name: "Bash", input: { command: "npm test" } },
            { type: "tool_result", tool_use_id: "tu-e", content: "FAIL", is_error: true },
          ],
        }),
        {
          kind: "subagent",
          taskToolUseId: "task-1",
          description: "Explore auth module",
          agentType: "Explore",
          children: [toolStep("grep auth")],
        },
        msg({
          role: "assistant",
          contentBlocks: [
            { type: "thinking", thinking: "The OEM code isn't indexed.\nMore detail." },
          ],
        }),
      ],
    };
    const s = summarizeRun(run);
    expect(s.toolCalls).toBe(2); // subagent-internal calls are not counted
    expect(s.subagents).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.steps).toBe(4);
    // Latest action is the last child's last meaningful block — first line only.
    expect(s.latest).toEqual({ label: "The OEM code isn't indexed.", italic: true });
  });

  it("uses the tool label + preview for a tool-call latest action", () => {
    const run: ActivityRun = {
      kind: "activity_run",
      key: "k",
      children: [
        msg({
          role: "assistant",
          contentBlocks: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "Bash",
              input: { command: "hostname", description: "Check hostname" },
            },
            { type: "tool_result", tool_use_id: "tu-1", content: "box" },
          ],
        }),
      ],
    };
    expect(summarizeRun(run).latest).toEqual({
      label: "Terminal · Check hostname",
      toolName: "Bash",
    });
  });

  it("falls back to 'Thinking…' for a step with only an empty thinking block", () => {
    const run: ActivityRun = {
      kind: "activity_run",
      key: "k",
      children: [msg({ role: "assistant", contentBlocks: [{ type: "thinking", thinking: " " }] })],
    };
    expect(summarizeRun(run).latest?.label).toBe("Thinking…");
  });

  it("extends the elapsed window to `now` for a live run", () => {
    const run: ActivityRun = {
      kind: "activity_run",
      key: "k",
      children: [msg({ role: "assistant", timestamp: 10_000, contentBlocks: [] })],
    };
    expect(summarizeRun(run).endedAt).toBe(10_000);
    expect(summarizeRun(run, 25_000).endedAt).toBe(25_000);
  });
});
