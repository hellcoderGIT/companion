import type { Hono } from "hono";
import { getSettings } from "../settings-manager.js";
import { getDashboardStore, type DashboardStore } from "../dashboard-store.js";
import {
  getDashboardRunProgress,
  isDashboardRunActive,
  runDashboardUpdate,
} from "../dashboard-summarizer.js";
import type { DashboardSessionSummary } from "../dashboard-types.js";

/**
 * Minimal slice of SdkSessionInfo needed to join companion-managed sessions
 * onto discovered Claude transcripts (matched via cliSessionId).
 */
export interface CompanionSessionLink {
  sessionId: string;
  cliSessionId?: string;
  name?: string;
  userName?: string;
  archived?: boolean;
}

export interface DashboardRouteDeps {
  listCompanionSessions?: () => CompanionSessionLink[];
  store?: DashboardStore;
}

export interface DashboardSessionEntry extends DashboardSessionSummary {
  /** Companion session id when this transcript belongs to a companion-managed session. */
  companionSessionId?: string;
  companionArchived?: boolean;
  displayName?: string;
  userName?: string;
}

export function registerDashboardRoutes(api: Hono, deps: DashboardRouteDeps = {}): void {
  const store = () => deps.store || getDashboardStore();

  // Dashboard data — served purely from the nightly store, never from live sessions.
  api.get("/dashboard", (c) => {
    const settings = getSettings();
    const summaries = store().loadAllSummaries();

    const links = new Map<string, CompanionSessionLink>();
    try {
      for (const session of deps.listCompanionSessions?.() ?? []) {
        if (session.cliSessionId) links.set(session.cliSessionId, session);
      }
    } catch (err) {
      console.warn("[dashboard] Failed to enumerate companion sessions:", err);
    }

    const sessions: DashboardSessionEntry[] = summaries.map((summary) => {
      const link = links.get(summary.sessionId);
      return {
        ...summary,
        companionSessionId: link?.sessionId,
        companionArchived: link?.archived === true ? true : undefined,
        displayName: link?.name,
        userName: link?.userName,
      };
    });

    return c.json({
      enabled: settings.dashboardEnabled,
      model: settings.dashboardModel,
      runHour: settings.dashboardRunHour,
      anthropicApiKeyConfigured: !!settings.anthropicApiKey.trim(),
      runMeta: store().loadRunMeta(),
      progress: getDashboardRunProgress(),
      sessions,
    });
  });

  // Manual "Update now" trigger. Runs in the background; poll run/status for progress.
  api.post("/dashboard/run", (c) => {
    if (isDashboardRunActive()) {
      return c.json({ error: "A dashboard update is already running", progress: getDashboardRunProgress() }, 409);
    }
    if (!getSettings().anthropicApiKey.trim()) {
      return c.json({ error: "Anthropic API key is not configured (Settings → Anthropic)" }, 400);
    }

    runDashboardUpdate({ trigger: "manual", store: deps.store }).catch((err) => {
      console.warn("[dashboard] Manual update failed:", err);
    });

    return c.json({ started: true });
  });

  api.get("/dashboard/run/status", (c) => {
    return c.json({
      progress: getDashboardRunProgress(),
      runMeta: store().loadRunMeta(),
    });
  });
}
