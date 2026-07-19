import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import type { DashboardRunMeta, DashboardSessionSummary } from "./dashboard-types.js";

// ─── Dashboard store ────────────────────────────────────────────────────────
// JSON-file persistence for nightly session summaries, following the same
// pattern as session-store.ts / cron-store.ts:
//   ~/.companion/dashboard/run-meta.json          — last run bookkeeping
//   ~/.companion/dashboard/sessions/<id>.json     — one summary per session

const DEFAULT_DIR = join(COMPANION_HOME, "dashboard");

/** Claude session ids are UUIDs; reject anything that could escape the dir. */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}

export class DashboardStore {
  private dir: string;
  private sessionsDir: string;

  constructor(dir?: string) {
    this.dir = dir || DEFAULT_DIR;
    this.sessionsDir = join(this.dir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  private summaryPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  saveSummary(summary: DashboardSessionSummary): void {
    if (!isSafeSessionId(summary.sessionId)) {
      console.warn(`[dashboard-store] Refusing to persist unsafe session id: ${summary.sessionId}`);
      return;
    }
    try {
      writeFileSync(this.summaryPath(summary.sessionId), JSON.stringify(summary, null, 2), "utf-8");
    } catch (err) {
      console.error(`[dashboard-store] Failed to save summary ${summary.sessionId}:`, err);
    }
  }

  loadSummary(sessionId: string): DashboardSessionSummary | null {
    if (!isSafeSessionId(sessionId)) return null;
    try {
      const raw = readFileSync(this.summaryPath(sessionId), "utf-8");
      return JSON.parse(raw) as DashboardSessionSummary;
    } catch {
      return null;
    }
  }

  loadAllSummaries(): DashboardSessionSummary[] {
    const summaries: DashboardSessionSummary[] = [];
    try {
      const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.sessionsDir, file), "utf-8");
          const parsed = JSON.parse(raw) as DashboardSessionSummary;
          if (parsed && typeof parsed.sessionId === "string" && typeof parsed.summary === "string") {
            summaries.push(parsed);
          }
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Dir doesn't exist yet
    }
    return summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  removeSummary(sessionId: string): void {
    if (!isSafeSessionId(sessionId)) return;
    try {
      unlinkSync(this.summaryPath(sessionId));
    } catch {
      // File may not exist
    }
  }

  saveRunMeta(meta: DashboardRunMeta): void {
    try {
      writeFileSync(join(this.dir, "run-meta.json"), JSON.stringify(meta, null, 2), "utf-8");
    } catch (err) {
      console.error("[dashboard-store] Failed to save run meta:", err);
    }
  }

  loadRunMeta(): DashboardRunMeta | null {
    try {
      const raw = readFileSync(join(this.dir, "run-meta.json"), "utf-8");
      const parsed = JSON.parse(raw) as DashboardRunMeta;
      if (typeof parsed?.lastRunAt !== "number") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  get directory(): string {
    return this.dir;
  }
}

let defaultStore: DashboardStore | null = null;

/** Lazily created singleton so importing this module never touches the disk. */
export function getDashboardStore(): DashboardStore {
  if (!defaultStore) defaultStore = new DashboardStore();
  return defaultStore;
}
