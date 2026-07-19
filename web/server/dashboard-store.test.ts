import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DashboardStore } from "./dashboard-store.js";
import type { DashboardRunMeta, DashboardSessionSummary } from "./dashboard-types.js";

// Validates the JSON-file persistence layer that the dashboard reads from:
// round-tripping summaries and run metadata, tolerating corrupt files, and
// rejecting session ids that could escape the storage directory.

function makeSummary(overrides: Partial<DashboardSessionSummary> = {}): DashboardSessionSummary {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/root/projects/demo",
    gitBranch: "main",
    slug: "fix-login-bug",
    summary: "Fixed the login redirect loop and added a regression test.",
    status: "completed",
    openItems: [],
    archivable: true,
    transcriptMtimeMs: 1000,
    lastActivityAt: 1000,
    summarizedAt: 2000,
    model: "claude-haiku-4-5",
    ...overrides,
  };
}

describe("DashboardStore", () => {
  let dir: string;
  let store: DashboardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dashboard-store-test-"));
    store = new DashboardStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a session summary", () => {
    const summary = makeSummary();
    store.saveSummary(summary);
    expect(store.loadSummary(summary.sessionId)).toEqual(summary);
  });

  it("returns null for a missing summary", () => {
    expect(store.loadSummary("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("lists all summaries sorted by lastActivityAt desc", () => {
    store.saveSummary(makeSummary({ sessionId: "a-old", lastActivityAt: 100 }));
    store.saveSummary(makeSummary({ sessionId: "b-new", lastActivityAt: 300 }));
    store.saveSummary(makeSummary({ sessionId: "c-mid", lastActivityAt: 200 }));
    expect(store.loadAllSummaries().map((s) => s.sessionId)).toEqual(["b-new", "c-mid", "a-old"]);
  });

  it("skips corrupt summary files instead of throwing", () => {
    store.saveSummary(makeSummary({ sessionId: "good" }));
    writeFileSync(join(dir, "sessions", "corrupt.json"), "{not json", "utf-8");
    const all = store.loadAllSummaries();
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe("good");
  });

  it("rejects unsafe session ids (path traversal)", () => {
    // Neither save nor load should touch anything outside sessions/.
    store.saveSummary(makeSummary({ sessionId: "../evil" }));
    expect(store.loadSummary("../evil")).toBeNull();
    expect(store.loadAllSummaries()).toHaveLength(0);
  });

  it("removes a summary", () => {
    const summary = makeSummary();
    store.saveSummary(summary);
    store.removeSummary(summary.sessionId);
    expect(store.loadSummary(summary.sessionId)).toBeNull();
  });

  it("round-trips run meta and returns null when absent or invalid", () => {
    expect(store.loadRunMeta()).toBeNull();

    const meta: DashboardRunMeta = {
      lastRunAt: 1000,
      lastRunCompletedAt: 2000,
      lastRunStatus: "success",
      trigger: "manual",
      model: "claude-haiku-4-5",
      sessionsProcessed: 3,
      sessionsSkipped: 5,
      sessionsFailed: 0,
    };
    store.saveRunMeta(meta);
    expect(store.loadRunMeta()).toEqual(meta);

    writeFileSync(join(dir, "run-meta.json"), JSON.stringify({ bogus: true }), "utf-8");
    expect(store.loadRunMeta()).toBeNull();
  });
});
