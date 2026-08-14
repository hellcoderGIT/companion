// ─── MagicUI types ───────────────────────────────────────────────────────────
//
// Shared vocabulary between the server-side Haiku watcher, the canonical
// dashboard state it maintains, and the browser/iframe runtime that renders
// it. The watcher never authors whole documents: it emits small patch
// operations (MagicUiOp) that the server validates, sanitizes and folds into
// a MagicUiDashboardState — the single source of truth that late-joining
// browsers receive as a snapshot.
//
// Imported by both web/server and web/src (same pattern as session-types.ts).

export type MagicUiArea = "hero" | "main" | "side" | "footer";

export type MagicUiTrend = "up" | "down" | "flat";

export interface MagicChartSpec {
  kind: "bar" | "line" | "donut" | "sparkline";
  title?: string;
  labels?: string[];
  series: Array<{ label: string; data: number[] }>;
}

export interface MagicUiStat {
  label: string;
  value: string;
  trend?: MagicUiTrend;
}

/** A copyable/expandable script or command the user is asked to run. */
export interface MagicUiSnippet {
  title: string;
  language?: string;
  code: string;
}

/**
 * An unresolved point where the main agent is waiting on the user —
 * a question, a manual step ("run this and report back"), or a blocker.
 * Rendered prominently in the runtime-owned Open Points panel until a
 * resolve_item op clears it.
 */
export interface MagicUiOpenItem {
  id: string;
  ts: number;
  text: string;
  kind: "action" | "question" | "blocker";
}

export interface MagicUiDecisionEntry {
  id: string;
  ts: number;
  /**
   * user    — the user answered a permission prompt / question
   * ai_auto — AI validation auto-resolved a permission
   * agent   — a notable choice the main agent made (watcher-observed)
   */
  source: "user" | "ai_auto" | "agent";
  title: string;
  detail: string;
  behavior?: "allow" | "deny";
}

/** One named region of the dashboard grid. Exactly one content kind is set. */
export interface MagicUiSlot {
  title?: string;
  html?: string;
  chart?: MagicChartSpec;
  stat?: MagicUiStat;
  snippet?: MagicUiSnippet;
  updatedAt: number;
}

export interface MagicUiLayoutEntry {
  slot: string;
  area: MagicUiArea;
  span?: 1 | 2 | 3;
}

export type MagicUiStatus = "live" | "degraded" | "stopped";

/** Patch operations the watcher model may emit (one JSON array per turn). */
export type MagicUiOp =
  | { op: "set_slot"; slot: string; html: string; title?: string; area?: MagicUiArea; span?: 1 | 2 | 3 }
  | { op: "remove_slot"; slot: string }
  | { op: "layout"; slots: MagicUiLayoutEntry[] }
  | { op: "chart"; slot: string; spec: MagicChartSpec; title?: string; area?: MagicUiArea; span?: 1 | 2 | 3 }
  | { op: "stat"; slot: string; label: string; value: string; trend?: MagicUiTrend; area?: MagicUiArea; span?: 1 | 2 | 3 }
  | { op: "snippet"; slot: string; title: string; code: string; language?: string; area?: MagicUiArea; span?: 1 | 2 | 3 }
  | { op: "open_item"; id: string; text: string; kind?: "action" | "question" | "blocker" }
  | { op: "resolve_item"; id: string }
  | { op: "decision_log"; title: string; detail: string }
  | { op: "session_summary"; text: string };

export interface MagicUiDashboardState {
  /** Monotonic version, bumped once per applied patch batch. */
  version: number;
  slots: Record<string, MagicUiSlot>;
  layout: MagicUiLayoutEntry[];
  /** Newest first; server-owned entries (user/ai_auto) + watcher-observed agent ones. */
  decisionLog: MagicUiDecisionEntry[];
  /** Unresolved user-facing points, newest first. */
  openItems: MagicUiOpenItem[];
  /** Rolling watcher-maintained summary; the seed for watcher restarts. Not rendered. */
  sessionSummary: string;
  status: MagicUiStatus;
  updatedAt: number;
}

export function emptyMagicUiState(now: number): MagicUiDashboardState {
  return {
    version: 0,
    slots: {},
    layout: [],
    decisionLog: [],
    openItems: [],
    sessionSummary: "",
    status: "live",
    updatedAt: now,
  };
}

// ── Budgets (enforced server-side in magic-ui-ops.ts) ────────────────────────

/** Hard cap on named slots; the prompt asks the model to stay well under. */
export const MAGIC_UI_MAX_SLOTS = 24;
/** Per-slot sanitized HTML budget (chars). */
export const MAGIC_UI_MAX_HTML_CHARS = 8_192;
/** Per-snippet code budget (chars). */
export const MAGIC_UI_MAX_SNIPPET_CHARS = 8_192;
/** Max ops applied from a single watcher turn; the rest is dropped. */
export const MAGIC_UI_MAX_OPS_PER_TURN = 30;
/** Decision log retention (newest first). */
export const MAGIC_UI_MAX_DECISIONS = 50;
/** Open point retention (newest first). */
export const MAGIC_UI_MAX_OPEN_ITEMS = 30;
/** Chart size guards. */
export const MAGIC_UI_MAX_CHART_SERIES = 6;
export const MAGIC_UI_MAX_CHART_POINTS = 100;
