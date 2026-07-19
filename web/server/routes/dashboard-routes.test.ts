import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { registerDashboardRoutes } from "./dashboard-routes.js";
import { DashboardStore } from "../dashboard-store.js";
import { _resetForTest } from "../settings-manager.js";
import { _resetDashboardRunStateForTest } from "../dashboard-summarizer.js";
import type { DashboardRunMeta, DashboardSessionSummary } from "../dashboard-types.js";

// Validates the dashboard REST surface: GET serves purely from the stored
// nightly data (never live sessions), joins companion-managed sessions via
// cliSessionId, and the manual run trigger requires the Claude Code CLI
// (the summarizer authenticates via the CLI login, not an API key).

const CLI_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeSummary(overrides: Partial<DashboardSessionSummary> = {}): DashboardSessionSummary {
  return {
    sessionId: CLI_SESSION_ID,
    cwd: "/root/projects/demo",
    gitBranch: "main",
    slug: "demo-task",
    summary: "Work is underway.",
    status: "in_progress",
    openItems: ["finish tests"],
    archivable: false,
    transcriptMtimeMs: 1000,
    lastActivityAt: 1000,
    summarizedAt: 2000,
    model: "claude-haiku-4-5",
    ...overrides,
  };
}

function buildApp(store: DashboardStore, cliAvailable: boolean): Hono {
  const app = new Hono();
  registerDashboardRoutes(app, {
    store,
    isCliAvailable: () => cliAvailable,
    listCompanionSessions: () => [
      {
        sessionId: "companion-1",
        cliSessionId: CLI_SESSION_ID,
        name: "Fix login",
        userName: "Moritz",
        archived: false,
      },
    ],
  });
  return app;
}

describe("dashboard routes", () => {
  let storeDir: string;
  let store: DashboardStore;
  let app: Hono;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "dashboard-routes-test-"));
    store = new DashboardStore(storeDir);
    _resetForTest(join(storeDir, "settings.json"));
    _resetDashboardRunStateForTest();
    app = buildApp(store, true);
  });

  afterEach(() => {
    _resetForTest();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("GET /dashboard returns stored summaries joined with companion sessions", async () => {
    store.saveSummary(makeSummary());
    const meta: DashboardRunMeta = {
      lastRunAt: 1,
      lastRunCompletedAt: 2,
      lastRunStatus: "success",
      trigger: "scheduled",
      model: "claude-haiku-4-5",
      sessionsProcessed: 1,
      sessionsSkipped: 0,
      sessionsFailed: 0,
    };
    store.saveRunMeta(meta);

    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.enabled).toBe(false); // opt-in defaults to off
    expect(data.claudeCliAvailable).toBe(true);
    expect(data.runMeta).toEqual(meta);
    expect(data.progress.state).toBe("idle");
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].companionSessionId).toBe("companion-1");
    expect(data.sessions[0].displayName).toBe("Fix login");
    expect(data.sessions[0].userName).toBe("Moritz");
  });

  it("GET /dashboard leaves external (non-companion) sessions unlinked", async () => {
    store.saveSummary(makeSummary({ sessionId: "11111111-2222-3333-4444-555555555555" }));
    const res = await app.request("/dashboard");
    const data = await res.json();
    expect(data.sessions[0].companionSessionId).toBeUndefined();
  });

  it("POST /dashboard/run returns 400 when the Claude CLI is unavailable", async () => {
    const noCliApp = buildApp(store, false);
    const res = await noCliApp.request("/dashboard/run", { method: "POST" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Claude Code CLI");
  });

  it("POST /dashboard/run starts a background run when the CLI is available", async () => {
    // Point discovery at an empty dir so the background run finds no sessions
    // (and therefore never actually invokes the CLI).
    const emptyProjects = mkdtempSync(join(tmpdir(), "dashboard-empty-projects-"));
    const prevProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
    process.env.CLAUDE_PROJECTS_DIR = emptyProjects;
    try {
      const res = await app.request("/dashboard/run", { method: "POST" });
      expect(res.status).toBe(200);
      expect((await res.json()).started).toBe(true);

      // Wait for the fire-and-forget run to finish and write run meta.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const status = await app.request("/dashboard/run/status");
      const statusData = await status.json();
      expect(statusData.progress.state).toBe("idle");
      expect(statusData.runMeta?.trigger).toBe("manual");
    } finally {
      if (prevProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
      else process.env.CLAUDE_PROJECTS_DIR = prevProjectsDir;
      rmSync(emptyProjects, { recursive: true, force: true });
    }
  });
});
