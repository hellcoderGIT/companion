import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _resetForTest, updateSettings } from "./settings-manager.js";
import { runScheduledDashboardUpdateIfDue } from "./dashboard-scheduler.js";

// The hourly tick reads settings at fire time, so the gate logic
// (opt-in flag, configured hour, API key) is what needs coverage.

describe("runScheduledDashboardUpdateIfDue", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-scheduler-test-"));
    _resetForTest(join(tempDir, "settings.json"));
  });

  afterEach(() => {
    _resetForTest();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does nothing while the dashboard is not opted in", async () => {
    updateSettings({ anthropicApiKey: "key", dashboardRunHour: 3 });
    const ran = await runScheduledDashboardUpdateIfDue(new Date(2026, 6, 19, 3, 0, 0));
    expect(ran).toBe(false);
  });

  it("does nothing outside the configured hour", async () => {
    updateSettings({ anthropicApiKey: "key", dashboardEnabled: true, dashboardRunHour: 3 });
    const ran = await runScheduledDashboardUpdateIfDue(new Date(2026, 6, 19, 4, 0, 0));
    expect(ran).toBe(false);
  });

  it("skips (without throwing) when no API key is configured", async () => {
    updateSettings({ dashboardEnabled: true, dashboardRunHour: 3 });
    const ran = await runScheduledDashboardUpdateIfDue(new Date(2026, 6, 19, 3, 0, 0));
    expect(ran).toBe(false);
  });
});
