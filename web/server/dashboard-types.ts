// ─── Project Dashboard types ────────────────────────────────────────────────
// The dashboard never reads live session data. A nightly (or manually
// triggered) summarizer job writes per-session summaries + a run-meta record
// to ~/.companion/dashboard/, and the dashboard UI reads only that store.

/** Where a session stands, as classified by the summarizer LLM. */
export type DashboardSessionStatus =
  | "completed"
  | "in_progress"
  | "awaiting_user"
  | "stalled";

export const DASHBOARD_SESSION_STATUSES: DashboardSessionStatus[] = [
  "completed",
  "in_progress",
  "awaiting_user",
  "stalled",
];

export interface DashboardSessionSummary {
  /** Claude CLI session id — the transcript's .jsonl basename. */
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  /** Session slug from the transcript metadata, if present. */
  slug?: string;
  /** 2-3 sentence "where it stands" summary. */
  summary: string;
  status: DashboardSessionStatus;
  /** Outstanding work items, empty when the task is done. */
  openItems: string[];
  /** Summarizer's hint that this session is finished/abandoned and safe to archive. */
  archivable: boolean;
  /** Transcript mtime observed when this summary was generated (incremental-skip key). */
  transcriptMtimeMs: number;
  /** Last activity timestamp of the session (= transcript mtime). */
  lastActivityAt: number;
  summarizedAt: number;
  /** Model that produced this summary. */
  model: string;
}

export type DashboardRunTrigger = "manual" | "scheduled";

export type DashboardRunStatus = "success" | "partial" | "error";

export interface DashboardRunMeta {
  /** Start of the last completed run (successful or not). */
  lastRunAt: number;
  lastRunCompletedAt: number;
  lastRunStatus: DashboardRunStatus;
  lastRunError?: string;
  trigger: DashboardRunTrigger;
  model: string;
  sessionsProcessed: number;
  sessionsSkipped: number;
  sessionsFailed: number;
}

/** Live progress of an in-flight summarizer run (not persisted). */
export interface DashboardRunProgress {
  state: "idle" | "running";
  trigger?: DashboardRunTrigger;
  total: number;
  processed: number;
  failed: number;
  /** Short label (project dir name or slug) of the session being summarized. */
  currentSession?: string;
  startedAt?: number;
}
