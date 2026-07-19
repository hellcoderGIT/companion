import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DashboardStore } from "./dashboard-store.js";
import { _resetForTest } from "./settings-manager.js";
import { clearClaudeSessionHistoryCacheForTests } from "./claude-session-history.js";

// The summarizer runs prompts through the headless Claude CLI (same login as
// normal sessions). Tests either inject a fake runner or toggle the mocked CLI
// availability below — no network and no real CLI involved.
const cliMock = { available: true };
vi.mock("./claude-cli-runner.js", () => ({
  isClaudeCliAvailable: () => cliMock.available,
  runClaudePrompt: vi.fn().mockResolvedValue(null),
}));

import {
  _resetDashboardRunStateForTest,
  buildTranscriptExcerpt,
  DashboardCliUnavailableError,
  parseSummaryResponse,
  runDashboardUpdate,
} from "./dashboard-summarizer.js";

// Covers the three layers of the summarizer:
// 1. buildTranscriptExcerpt — bounded, tail-biased excerpt building
// 2. parseSummaryResponse — tolerant parsing of the model's JSON answer
// 3. runDashboardUpdate — end-to-end over fake transcripts with an injected
//    prompt runner, including the incremental "only changed sessions" skip.

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Writes a minimal Claude Code transcript that discovery + history parsing accept. */
function writeTranscript(projectsRoot: string, sessionId: string, cwd: string): string {
  const projectDir = join(projectsRoot, "-root-projects-demo");
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    { sessionId, cwd, gitBranch: "main", slug: "demo-task", type: "summary" },
    {
      sessionId,
      type: "user",
      timestamp: "2026-07-18T10:00:00Z",
      message: { role: "user", content: "Please fix the login bug" },
    },
    {
      sessionId,
      type: "assistant",
      timestamp: "2026-07-18T10:01:00Z",
      message: {
        role: "assistant",
        id: "msg_1",
        content: [{ type: "text", text: "Fixed the redirect loop and added a test." }],
      },
    },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
  return file;
}

describe("buildTranscriptExcerpt", () => {
  it("formats roles and keeps message order", () => {
    const excerpt = buildTranscriptExcerpt([
      { role: "user", content: "do X" },
      { role: "assistant", content: "did X" },
    ]);
    expect(excerpt).toBe("USER: do X\n\nASSISTANT: did X");
  });

  it("keeps the tail when the total budget is exceeded", () => {
    const big = "x".repeat(1_400);
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      content: `${i}:${big}`,
    }));
    const excerpt = buildTranscriptExcerpt(messages);
    // The last message must survive; the first must be dropped.
    expect(excerpt).toContain("39:");
    expect(excerpt).not.toContain("USER: 0:");
    expect(excerpt.length).toBeLessThanOrEqual(25_000);
  });

  it("truncates oversized individual messages", () => {
    const excerpt = buildTranscriptExcerpt([{ role: "user", content: "y".repeat(5_000) }]);
    expect(excerpt).toContain("[... truncated]");
    expect(excerpt.length).toBeLessThan(2_000);
  });
});

describe("parseSummaryResponse", () => {
  it("parses a clean JSON object", () => {
    const parsed = parseSummaryResponse(
      '{"summary":"Done.","status":"completed","openItems":[],"archivable":true}',
    );
    expect(parsed).toEqual({ summary: "Done.", status: "completed", openItems: [], archivable: true });
  });

  it("extracts JSON wrapped in prose or markdown fences", () => {
    const parsed = parseSummaryResponse(
      'Here you go:\n```json\n{"summary":"WIP","status":"in_progress","openItems":["write tests"],"archivable":false}\n```',
    );
    expect(parsed?.status).toBe("in_progress");
    expect(parsed?.openItems).toEqual(["write tests"]);
  });

  it("falls back to in_progress for unknown status values and caps openItems", () => {
    const parsed = parseSummaryResponse(
      `{"summary":"s","status":"weird","openItems":["1","2","3","4","5","6","7"],"archivable":"yes"}`,
    );
    expect(parsed?.status).toBe("in_progress");
    expect(parsed?.openItems).toHaveLength(5);
    // Non-boolean archivable must not be treated as true.
    expect(parsed?.archivable).toBe(false);
  });

  it("returns null for garbage or missing summary", () => {
    expect(parseSummaryResponse("no json here")).toBeNull();
    expect(parseSummaryResponse('{"status":"completed"}')).toBeNull();
  });
});

describe("runDashboardUpdate", () => {
  let projectsRoot: string;
  let storeDir: string;
  let store: DashboardStore;

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "dashboard-projects-"));
    storeDir = mkdtempSync(join(tmpdir(), "dashboard-store-"));
    store = new DashboardStore(storeDir);
    cliMock.available = true;
    _resetForTest(join(mkdtempSync(join(tmpdir(), "dashboard-settings-")), "settings.json"));
    _resetDashboardRunStateForTest();
    clearClaudeSessionHistoryCacheForTests();
  });

  afterEach(() => {
    _resetForTest();
    rmSync(projectsRoot, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("throws when sessions need summarizing but the Claude CLI is missing", async () => {
    writeTranscript(projectsRoot, SESSION_ID, "/root/projects/demo");
    cliMock.available = false;
    await expect(
      runDashboardUpdate({ trigger: "manual", store, projectsRoot }),
    ).rejects.toBeInstanceOf(DashboardCliUnavailableError);
  });

  it("succeeds without the CLI when there is nothing to summarize", async () => {
    cliMock.available = false;
    const meta = await runDashboardUpdate({ trigger: "manual", store, projectsRoot });
    expect(meta.lastRunStatus).toBe("success");
    expect(meta.sessionsProcessed).toBe(0);
  });

  it("summarizes changed sessions via the runner and persists summary + run meta", async () => {
    writeTranscript(projectsRoot, SESSION_ID, "/root/projects/demo");

    const runner = vi.fn().mockResolvedValue(JSON.stringify({
      summary: "Login bug fixed; regression test added.",
      status: "completed",
      openItems: [],
      archivable: true,
    }));

    const meta = await runDashboardUpdate({ trigger: "manual", store, projectsRoot, runner });

    expect(meta.lastRunStatus).toBe("success");
    expect(meta.sessionsProcessed).toBe(1);
    expect(meta.sessionsFailed).toBe(0);
    expect(store.loadRunMeta()).toEqual(meta);

    const summary = store.loadSummary(SESSION_ID);
    expect(summary?.status).toBe("completed");
    expect(summary?.archivable).toBe(true);
    expect(summary?.cwd).toBe("/root/projects/demo");
    expect(summary?.model).toBe("claude-haiku-4-5");

    // The runner receives the transcript excerpt and the configured dashboard model.
    const [prompt, model] = runner.mock.calls[0];
    expect(prompt).toContain("USER: Please fix the login bug");
    expect(model).toBe("claude-haiku-4-5");
  });

  it("skips sessions whose transcript is unchanged since the last run", async () => {
    const file = writeTranscript(projectsRoot, SESSION_ID, "/root/projects/demo");
    // Pin the mtime so both runs observe the same lastActivityAt.
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const runner = vi.fn().mockResolvedValue(JSON.stringify({
      summary: "s", status: "in_progress", openItems: [], archivable: false,
    }));

    await runDashboardUpdate({ trigger: "manual", store, projectsRoot, runner });
    expect(runner).toHaveBeenCalledTimes(1);

    const second = await runDashboardUpdate({ trigger: "manual", store, projectsRoot, runner });
    // No new activity → no additional runner call, session counted as skipped.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(second.sessionsProcessed).toBe(0);
    expect(second.sessionsSkipped).toBe(1);
  });

  it("records a failed run when the runner yields nothing", async () => {
    writeTranscript(projectsRoot, SESSION_ID, "/root/projects/demo");
    const runner = vi.fn().mockResolvedValue(null);

    const meta = await runDashboardUpdate({ trigger: "scheduled", store, projectsRoot, runner });
    expect(meta.lastRunStatus).toBe("error");
    expect(meta.sessionsFailed).toBe(1);
    expect(store.loadSummary(SESSION_ID)).toBeNull();
  });
});
