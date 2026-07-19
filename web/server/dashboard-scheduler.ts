import { Cron } from "croner";
import { getSettings } from "./settings-manager.js";
import { isDashboardRunActive, runDashboardUpdate } from "./dashboard-summarizer.js";

// ─── Nightly dashboard scheduler ────────────────────────────────────────────
// Fires every hour on the hour and runs the summarizer only when the current
// hour matches the configured dashboardRunHour. Reading the settings at fire
// time (instead of baking the hour into the cron expression) means changes to
// the schedule or the opt-in toggle apply without any reschedule plumbing.

let job: Cron | null = null;

export async function runScheduledDashboardUpdateIfDue(now: Date = new Date()): Promise<boolean> {
  const settings = getSettings();
  if (!settings.dashboardEnabled) return false;
  if (now.getHours() !== settings.dashboardRunHour) return false;
  if (isDashboardRunActive()) return false;
  if (!settings.anthropicApiKey.trim()) {
    console.warn("[dashboard] Nightly update skipped: Anthropic API key not configured");
    return false;
  }

  try {
    const meta = await runDashboardUpdate({ trigger: "scheduled" });
    console.log(
      `[dashboard] Nightly update finished: ${meta.sessionsProcessed} summarized, `
      + `${meta.sessionsSkipped} unchanged, ${meta.sessionsFailed} failed`,
    );
  } catch (err) {
    console.warn("[dashboard] Nightly update failed:", err);
  }
  return true;
}

export function startDashboardScheduler(): void {
  if (job) return;
  job = new Cron("0 * * * *", { protect: true }, () => {
    void runScheduledDashboardUpdateIfDue();
  });
}

export function stopDashboardScheduler(): void {
  job?.stop();
  job = null;
}
