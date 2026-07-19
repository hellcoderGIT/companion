import { DEFAULT_DASHBOARD_MODEL, getSettings } from "./settings-manager.js";
import { isClaudeCliAvailable, runClaudePrompt } from "./claude-cli-runner.js";
import { discoverClaudeSessions, type DiscoveredClaudeSession } from "./claude-session-discovery.js";
import { getClaudeSessionHistoryPage } from "./claude-session-history.js";
import { DashboardStore, getDashboardStore } from "./dashboard-store.js";
import {
  DASHBOARD_SESSION_STATUSES,
  type DashboardRunMeta,
  type DashboardRunProgress,
  type DashboardRunTrigger,
  type DashboardSessionStatus,
  type DashboardSessionSummary,
} from "./dashboard-types.js";

// Bounded transcript excerpt so a huge session can't blow the token budget:
// keep only the tail of the conversation, and truncate individual messages.
const EXCERPT_MESSAGE_LIMIT = 40;
const EXCERPT_MAX_MESSAGE_CHARS = 1_500;
const EXCERPT_MAX_TOTAL_CHARS = 24_000;
const DISCOVERY_LIMIT = 500;
// Generous: each summarization pays Claude CLI startup cost on top of the model call.
const PER_SESSION_TIMEOUT_MS = 120_000;

interface ExcerptMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Builds a compact, tail-biased plain-text excerpt of a transcript.
 * Exported for tests.
 */
export function buildTranscriptExcerpt(messages: ExcerptMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  // Walk backwards from the end so the most recent context always survives.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = msg.content.trim();
    if (!text) continue;
    const clipped = text.length > EXCERPT_MAX_MESSAGE_CHARS
      ? `${text.slice(0, EXCERPT_MAX_MESSAGE_CHARS)}\n[... truncated]`
      : text;
    const line = `${msg.role === "user" ? "USER" : "ASSISTANT"}: ${clipped}`;
    if (total + line.length > EXCERPT_MAX_TOTAL_CHARS) break;
    total += line.length;
    lines.push(line);
  }
  return lines.reverse().join("\n\n");
}

export interface ParsedSessionSummary {
  summary: string;
  status: DashboardSessionStatus;
  openItems: string[];
  archivable: boolean;
}

/**
 * Tolerant parser for the model's JSON answer. Model-agnostic on purpose —
 * works whether or not the configured model supports structured outputs.
 * Exported for tests.
 */
export function parseSummaryResponse(raw: string): ParsedSessionSummary | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) return null;

  const status = DASHBOARD_SESSION_STATUSES.includes(parsed.status as DashboardSessionStatus)
    ? (parsed.status as DashboardSessionStatus)
    : "in_progress";

  const openItems = Array.isArray(parsed.openItems)
    ? parsed.openItems.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 5)
    : [];

  return {
    summary: summary.slice(0, 1_000),
    status,
    openItems,
    archivable: parsed.archivable === true,
  };
}

function buildPrompt(session: DiscoveredClaudeSession, excerpt: string): string {
  return [
    "You are generating a project-dashboard entry for a Claude Code (coding agent) session transcript.",
    "Do not use any tools — analyze only the excerpt below and answer directly.",
    "Answer with ONLY a JSON object — no prose, no markdown fences — with exactly these fields:",
    `{"summary": "...", "status": "...", "openItems": ["..."], "archivable": true|false}`,
    "",
    '- "summary": 2-3 sentences on what the session is about and where it stands right now.',
    '- "status": one of "completed" (task finished and verified/accepted), "in_progress" (work underway or clearly more to do), "awaiting_user" (agent asked a question or needs a decision/approval), "stalled" (errors, dead ends, or abandoned mid-task).',
    '- "openItems": up to 5 short outstanding work items; empty array if nothing is left.',
    '- "archivable": true only when the session is finished or clearly abandoned and keeping it active adds nothing.',
    "",
    `Project directory: ${session.cwd}`,
    session.gitBranch ? `Git branch: ${session.gitBranch}` : "",
    "",
    "Transcript excerpt (tail of the session):",
    excerpt,
  ].filter(Boolean).join("\n");
}

/**
 * One prompt → one plain-text answer. The default runner goes through the
 * headless Claude CLI (`claude --print`), so summarization authenticates with
 * the same Claude Code login that normal sessions use — no API key required.
 */
export type SummarizerRunner = (prompt: string, model: string) => Promise<string | null>;

const defaultRunner: SummarizerRunner = (prompt, model) =>
  runClaudePrompt({ prompt, model, timeoutMs: PER_SESSION_TIMEOUT_MS });

// ─── Run state (module singleton) ───────────────────────────────────────────

let progress: DashboardRunProgress = { state: "idle", total: 0, processed: 0, failed: 0 };

export function getDashboardRunProgress(): DashboardRunProgress {
  return { ...progress };
}

export function isDashboardRunActive(): boolean {
  return progress.state === "running";
}

function sessionLabel(session: DiscoveredClaudeSession): string {
  if (session.slug) return session.slug;
  const parts = session.cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || session.cwd;
}

export interface RunDashboardUpdateOptions {
  trigger: DashboardRunTrigger;
  store?: DashboardStore;
  projectsRoot?: string;
  /** Override the prompt runner (tests). Defaults to the headless Claude CLI. */
  runner?: SummarizerRunner;
}

export class DashboardRunActiveError extends Error {
  constructor() {
    super("A dashboard update is already running");
  }
}

export class DashboardCliUnavailableError extends Error {
  constructor() {
    super("Claude Code CLI not found — the dashboard summarizer uses your Claude Code login");
  }
}

/**
 * Runs one summarizer pass: summarize every discovered Claude session whose
 * transcript changed since its stored summary. Sequential on purpose — this
 * is a background job and we'd rather be slow than hit rate limits.
 */
export async function runDashboardUpdate(
  options: RunDashboardUpdateOptions,
): Promise<DashboardRunMeta> {
  if (isDashboardRunActive()) throw new DashboardRunActiveError();

  const settings = getSettings();
  const model = settings.dashboardModel?.trim() || DEFAULT_DASHBOARD_MODEL;
  const maxSessions = settings.dashboardMaxSessionsPerRun;
  const store = options.store || getDashboardStore();
  const startedAt = Date.now();

  const discovered = discoverClaudeSessions({
    limit: DISCOVERY_LIMIT,
    projectsRoot: options.projectsRoot,
  });

  // Incremental: only sessions with activity since their last stored summary.
  const stale = discovered.filter((session) => {
    const existing = store.loadSummary(session.sessionId);
    return !existing || session.lastActivityAt > existing.transcriptMtimeMs;
  });
  const queue = stale.slice(0, maxSessions);
  const skipped = discovered.length - queue.length;

  // Only the default (CLI-backed) runner needs the binary; an injected runner
  // (tests) doesn't, and an empty queue never invokes the runner at all.
  if (queue.length > 0 && !options.runner && !isClaudeCliAvailable()) {
    throw new DashboardCliUnavailableError();
  }
  const runner = options.runner || defaultRunner;

  progress = {
    state: "running",
    trigger: options.trigger,
    total: queue.length,
    processed: 0,
    failed: 0,
    startedAt,
  };

  let failed = 0;
  try {
    for (const session of queue) {
      progress = { ...progress, currentSession: sessionLabel(session) };
      const ok = await summarizeOne(session, store, runner, model, options.projectsRoot);
      if (!ok) failed++;
      progress = {
        ...progress,
        processed: progress.processed + 1,
        failed,
      };
    }

    const meta: DashboardRunMeta = {
      lastRunAt: startedAt,
      lastRunCompletedAt: Date.now(),
      lastRunStatus: failed === 0 ? "success" : failed === queue.length && queue.length > 0 ? "error" : "partial",
      lastRunError: failed > 0 ? `${failed} of ${queue.length} sessions failed to summarize` : undefined,
      trigger: options.trigger,
      model,
      sessionsProcessed: queue.length - failed,
      sessionsSkipped: skipped,
      sessionsFailed: failed,
    };
    // Only a fully failed run keeps the previous meta's "last successful" story;
    // we still persist it so the UI can surface the failure.
    store.saveRunMeta(meta);
    return meta;
  } finally {
    progress = { state: "idle", total: 0, processed: 0, failed: 0 };
  }
}

async function summarizeOne(
  session: DiscoveredClaudeSession,
  store: DashboardStore,
  runner: SummarizerRunner,
  model: string,
  projectsRoot?: string,
): Promise<boolean> {
  const history = getClaudeSessionHistoryPage({
    sessionId: session.sessionId,
    limit: EXCERPT_MESSAGE_LIMIT,
    projectsRoot,
  });
  if (!history || history.messages.length === 0) return false;

  const excerpt = buildTranscriptExcerpt(
    history.messages.map((m) => ({ role: m.role, content: m.content })),
  );
  if (!excerpt) return false;

  const raw = await runner(buildPrompt(session, excerpt), model);
  if (!raw) return false;

  const parsed = parseSummaryResponse(raw);
  if (!parsed) {
    console.warn(`[dashboard] Unparseable summarizer response for session ${session.sessionId}`);
    return false;
  }

  const summary: DashboardSessionSummary = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    slug: session.slug,
    summary: parsed.summary,
    status: parsed.status,
    openItems: parsed.openItems,
    archivable: parsed.archivable,
    transcriptMtimeMs: session.lastActivityAt,
    lastActivityAt: session.lastActivityAt,
    summarizedAt: Date.now(),
    model,
  };
  store.saveSummary(summary);
  return true;
}

/** Test hook — reset the module-level run state. */
export function _resetDashboardRunStateForTest(): void {
  progress = { state: "idle", total: 0, processed: 0, failed: 0 };
}
