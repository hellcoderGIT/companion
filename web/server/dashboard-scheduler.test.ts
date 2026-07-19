import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _resetForTest, updateSettings } from "./settings-manager.js";

// The hourly tick reads settings at fire time, so the gate logic
// (opt-in flag, configured hour, CLI availability) is what needs coverage.
// Both the CLI check and the summarizer are mocked — no real runs here.

const cliMock = { available: true };
const runMock = vi.fn();

vi.mock("./claude-cli-runner.js", () => ({
  isClaudeCliAvailable: () => cliMock.available,
  runClaudePrompt: vi.fn().mockResolvedValue(null),
}));

vi.mock("./dashboard-summarizer.js", () => ({
  isDashboardRunActive: () => false,
  runDashboardUpdate: (...args: unknown[]) => runMock(...args),
}));

import { runScheduledDashboardUpdateIfDue } from "./dashboard-scheduler.js";

describe("runScheduledDashboardUpdateIfDue", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-scheduler-test-"));
    _resetForTest(join(tempDir, "settings.json"));
    cliMock.available = true;
    runMock.mockReset().mockResolvedValue({
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      sessionsFailed: 0,
    });
  });

  afterEach(() => {
    _resetForTest();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does nothing while the dashboard is not opted in", async () => {
    updateSettings({ dashboardRunHour: 3 });
    const ran = await runScheduledDashboardUpdateIfDue(new Date(2026, 6, 19, 3, 0, 0));
    expect(ran).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("does nothing outside the configured hour", async () => {
    updateSettings({ dashboardEnabled: true, dashboardRunHour: 3 });
    const ran = await runScheduledDashboardUpdateIfDue(new Date(2026, 6, 19, 4, 0, 0));
    expect(ran).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("skips (without throwing) when the Claude CLI is unavailable", async () => {
    updateSettings({ dashboardEnabled: true, dashboardRunHour: 3 });
    cliMock.available = false;
    const ran = await runScheduledDashboardUpdateIfDue(new Date(2026, 6, 19, 3, 0, 0));
    expect(ran).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("runs the summarizer when enabled, on the hour, with the CLI present", async () => {
    updateSettings({ dashboardEnabled: true, dashboardRunHour: 3 });
    const ran = await runScheduledDashboardUpdateIfDue(new Date(2026, 6, 19, 3, 0, 0));
    expect(ran).toBe(true);
    expect(runMock).toHaveBeenCalledWith({ trigger: "scheduled" });
  });
});
