import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DashboardStore } from "./dashboard-store.js";
import { _resetForTest, updateSettings } from "./settings-manager.js";
import { clearClaudeSessionHistoryCacheForTests } from "./claude-session-history.js";
import {
  _resetDashboardRunStateForTest,
  buildTranscriptExcerpt,
  DashboardNotConfiguredError,
  parseSummaryResponse,
  runDashboardUpdate,
} from "./dashboard-summarizer.js";

// Covers the three layers of the summarizer:
// 1. buildTranscriptExcerpt — bounded, tail-biased excerpt building
// 2. parseSummaryResponse — tolerant parsing of the model's JSON answer
// 3. runDashboardUpdate — end-to-end over fake transcripts with a stubbed
//    Anthropic API, including the incremental "only changed sessions" skip.

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function anthropicResponse(payload: object): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

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
  let settingsPath: string;
  let store: DashboardStore;

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "dashboard-projects-"));
    storeDir = mkdtempSync(join(tmpdir(), "dashboard-store-"));
    settingsPath = join(mkdtempSync(join(tmpdir(), "dashboard-settings-")), "settings.json");
    store = new DashboardStore(storeDir);
    _resetForTest(settingsPath);
    _resetDashboardRunStateForTest();
    clearClaudeSessionHistoryCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetForTest();
    rmSync(projectsRoot, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("throws when no Anthropic API key is configured", async () => {
    await expect(
      runDashboardUpdate({ trigger: "manual", store, projectsRoot }),
    ).rejects.toBeInstanceOf(DashboardNotConfiguredError);
  });

  it("summarizes changed sessions and persists summary + run meta", async () => {
    updateSettings({ anthropicApiKey: "test-key" });
    writeTranscript(projectsRoot, SESSION_ID, "/root/projects/demo");

    const fetchMock = vi.fn().mockResolvedValue(anthropicResponse({
      summary: "Login bug fixed; regression test added.",
      status: "completed",
      openItems: [],
      archivable: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const meta = await runDashboardUpdate({ trigger: "manual", store, projectsRoot });

    expect(meta.lastRunStatus).toBe("success");
    expect(meta.sessionsProcessed).toBe(1);
    expect(meta.sessionsFailed).toBe(0);
    expect(store.loadRunMeta()).toEqual(meta);

    const summary = store.loadSummary(SESSION_ID);
    expect(summary?.status).toBe("completed");
    expect(summary?.archivable).toBe(true);
    expect(summary?.cwd).toBe("/root/projects/demo");
    expect(summary?.model).toBe("claude-haiku-4-5");

    // The request body must target the configured dashboard model.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe("claude-haiku-4-5");
  });

  it("skips sessions whose transcript is unchanged since the last run", async () => {
    updateSettings({ anthropicApiKey: "test-key" });
    const file = writeTranscript(projectsRoot, SESSION_ID, "/root/projects/demo");
    // Pin the mtime so both runs observe the same lastActivityAt.
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const fetchMock = vi.fn().mockResolvedValue(anthropicResponse({
      summary: "s", status: "in_progress", openItems: [], archivable: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await runDashboardUpdate({ trigger: "manual", store, projectsRoot });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await runDashboardUpdate({ trigger: "manual", store, projectsRoot });
    // No new activity → no additional API call, session counted as skipped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.sessionsProcessed).toBe(0);
    expect(second.sessionsSkipped).toBe(1);
  });

  it("records a failed run when the API errors", async () => {
    updateSettings({ anthropicApiKey: "test-key" });
    writeTranscript(projectsRoot, SESSION_ID, "/root/projects/demo");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));

    const meta = await runDashboardUpdate({ trigger: "scheduled", store, projectsRoot });
    expect(meta.lastRunStatus).toBe("error");
    expect(meta.sessionsFailed).toBe(1);
    expect(store.loadSummary(SESSION_ID)).toBeNull();
  });
});
