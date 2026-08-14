// ─── MagicUI watcher ─────────────────────────────────────────────────────────
//
// One cheap long-lived Haiku session per opted-in companion session. It taps
// the companionBus message stream (works for BOTH Claude and Codex main
// sessions), builds small incremental digests — never re-reading the
// transcript — and feeds them to the Agent SDK's `query()` over a streaming
// input queue. The model replies with JSON patch ops that are validated,
// folded into the canonical dashboard state, persisted, and broadcast to
// browsers as full snapshots.
//
// Auth: the SDK spawns the logged-in `claude` binary, so the watcher rides
// the Claude Code subscription exactly like normal sessions. NEVER inject
// ANTHROPIC_API_KEY here (metered billing; the reference instance has none).
//
// Context growth: the watcher never re-reads history. When its own session
// gets long it restarts seeded with the serialized dashboard state + the
// rolling session_summary the model itself maintains — the dashboard IS the
// compressed memory.

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options as SdkOptions, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncMessageQueue } from "./async-message-queue.js";
import { companionBus } from "./event-bus.js";
import { log } from "./logger.js";
import { resolveBinary } from "./path-resolver.js";
import { getEffectiveMagicUi } from "./magic-ui-settings.js";
import { MagicUiStore } from "./magic-ui-store.js";
import {
  appendDecision,
  applyOps,
  makeDecisionEntry,
  parseMagicUiReply,
  validateOps,
} from "./magic-ui-ops.js";
import {
  emptyMagicUiState,
  type MagicUiDashboardState,
  type MagicUiStatus,
} from "./magic-ui-types.js";
import {
  extractTextFromAssistant,
  extractToolUses,
} from "./message-extract.js";
import type {
  BrowserIncomingMessage,
  PermissionRequest,
  SessionState,
} from "./session-types.js";
import { tmpdir } from "node:os";

// ── Tuning ──────────────────────────────────────────────────────────────────

/** Flush mid-turn if the accumulator has been non-empty this long. */
const MAX_LATENCY_MS = 20_000;
/** Total digest budget per watcher turn. */
const DIGEST_MAX_CHARS = 4_000;
/** Per-assistant-text budget inside a digest. */
const TEXT_SNIPPET_CHARS = 400;
/** Stop an idle watcher after this long without any digestible activity. */
const IDLE_STOP_MS = 10 * 60_000;
/** Restart the Haiku session (with seed) after this many completed turns. */
const RESTART_AFTER_TURNS = 40;
/** Give up (degraded) after this many consecutive failed query starts. */
const MAX_CRASH_RETRIES = 3;

export const MAGIC_UI_SYSTEM_PROMPT = `You are a live dashboard artist for a coding session. You receive incremental digests of what a coding agent (and its user) did, and you maintain a single fixed-viewport dashboard by emitting JSON patch operations. You never write prose to the user.

OUTPUT FORMAT — HARD RULE: reply with exactly one \`\`\`json code block containing an ARRAY of ops. Nothing else. If nothing meaningful changed, reply with [].

OPS:
- {"op":"set_slot","slot":"<name>","html":"<fragment>","title":"...","area":"hero|main","span":1|2|3}
  Allowed tags: div span p h1-h4 ul ol li table thead tbody tr td th strong em b i u s code pre small br hr blockquote progress mark kbd sub sup. class and data-* attributes only. NO style/script/links/images.
- {"op":"remove_slot","slot":"<name>"}
- {"op":"layout","slots":[{"slot":"...","area":"hero|main","span":1|2|3}]}
- {"op":"chart","slot":"...","spec":{"kind":"bar|line|donut|sparkline","labels":[...],"series":[{"label":"...","data":[...]}]},"title":"...","area":"...","span":...}
- {"op":"stat","slot":"...","label":"...","value":"...","trend":"up|down|flat","area":"...","span":...}
- {"op":"snippet","slot":"...","title":"...","code":"...","language":"bash"} — for any script/command the USER must run themselves; rendered copyable.
- {"op":"open_item","id":"<stable-id>","text":"...","kind":"action|question|blocker"} — OPEN points where the agent waits on the user (questions asked, manual steps requested, blockers). Keep them current; emit {"op":"resolve_item","id":"..."} the moment a point is addressed.
- {"op":"decision_log","title":"...","detail":"..."} — ONLY for notable choices the agent itself made (approach picked, tradeoff taken). User choices are logged automatically — never duplicate them.
- {"op":"session_summary","text":"..."} — maintain a rolling ~5 sentence summary of the WHOLE session. Refresh it every few turns. It is not rendered; it is your own memory across restarts.

DASHBOARD RULES:
- Fixed viewport, NO scrolling: keep at most 8 visible slots. When new content arrives, CONDENSE — merge older work into a compact summary slot or remove it — never just add.
- Newest/most important activity belongs in area "hero". Important points of the discussion must stay visible in a condensed form.
- Charts and stats ONLY for genuinely numeric data (tests passed, files changed, durations, counts). Never invent numbers.
- Decisions and open points are first-class: reference pending decisions in content, but NEVER build buttons or forms — the runtime renders the real controls.
- Emit MINIMAL ops: only slots that actually changed. Keep every html fragment small and dense. Prefer 1 chart + stats + short lists over walls of text.`;

// ── Digest accumulation ─────────────────────────────────────────────────────

interface TurnAccumulator {
  texts: string[];
  tools: Array<{ name: string; summary: string }>;
  files: Set<string>;
  permissionLines: string[];
  resultLine: string | null;
  firstEventAt: number | null;
}

function newAccumulator(): TurnAccumulator {
  return { texts: [], tools: [], files: new Set(), permissionLines: [], resultLine: null, firstEventAt: null };
}

function accumulatorEmpty(acc: TurnAccumulator): boolean {
  return acc.texts.length === 0 && acc.tools.length === 0 && acc.permissionLines.length === 0 && acc.resultLine === null;
}

function toolSummary(tool: { name: string; rawInput?: Record<string, unknown> }): string {
  const input = tool.rawInput ?? {};
  const detail =
    typeof input.file_path === "string" ? input.file_path
      : typeof input.command === "string" ? String(input.command).slice(0, 120)
        : typeof input.pattern === "string" ? String(input.pattern).slice(0, 60)
          : typeof input.description === "string" ? String(input.description).slice(0, 80)
            : "";
  return detail ? `${tool.name}(${detail})` : tool.name;
}

export function buildDigest(acc: TurnAccumulator, seq: number): string {
  const lines: string[] = [`TURN DIGEST #${seq}`];
  if (acc.texts.length) {
    const joined = acc.texts
      .map((t) => t.length > TEXT_SNIPPET_CHARS ? `${t.slice(0, TEXT_SNIPPET_CHARS)}…` : t)
      .join("\n");
    lines.push(`assistant:\n${joined}`);
  }
  if (acc.tools.length) {
    const maxTools = 15;
    const shown = acc.tools.slice(0, maxTools).map((t) => t.summary).join(", ");
    const extra = acc.tools.length > maxTools ? `  [+${acc.tools.length - maxTools} more tool calls]` : "";
    lines.push(`tools: ${shown}${extra}`);
  }
  if (acc.files.size) {
    lines.push(`files touched: ${[...acc.files].slice(0, 20).join(", ")}`);
  }
  if (acc.permissionLines.length) {
    lines.push(`decisions: ${acc.permissionLines.join("; ")}`);
  }
  if (acc.resultLine) lines.push(`result: ${acc.resultLine}`);
  let digest = lines.join("\n");
  if (digest.length > DIGEST_MAX_CHARS) {
    digest = `${digest.slice(0, DIGEST_MAX_CHARS)}\n…[digest truncated]`;
  }
  return digest;
}

// ── Watcher (one per session) ───────────────────────────────────────────────

type QueryFn = typeof sdkQuery;

interface WatcherDeps {
  broadcast: (sessionId: string, msg: BrowserIncomingMessage) => void;
  store: MagicUiStore;
  model: string;
  queryFn?: QueryFn;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class MagicUiWatcher {
  private acc = newAccumulator();
  private queue: AsyncMessageQueue<SDKUserMessage> | null = null;
  private abortController: AbortController | null = null;
  private inFlight = false;
  private pendingDigest: string | null = null;
  private digestSeq = 0;
  private completedTurns = 0;
  private crashRetries = 0;
  private latencyTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  state: MagicUiDashboardState;

  constructor(
    private readonly sessionId: string,
    private readonly deps: WatcherDeps,
  ) {
    this.state = deps.store.load(sessionId, this.now());
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    this.stopped = false;
    this.setStatus("live");
    this.broadcastState();
    this.startQuery(this.seedMessage());
    this.armIdleTimer();
  }

  /** First message of a (re)started watcher session: current dashboard + summary. */
  private seedMessage(): string | null {
    if (this.state.version === 0) return null;
    const seedState = { slots: this.state.slots, layout: this.state.layout, openItems: this.state.openItems };
    return [
      "You are resuming a dashboard you maintain. CURRENT DASHBOARD STATE:",
      JSON.stringify(seedState).slice(0, 12_000),
      this.state.sessionSummary ? `SESSION SUMMARY SO FAR: ${this.state.sessionSummary}` : "",
      "Continue maintaining this dashboard. Reply [] to acknowledge.",
    ].filter(Boolean).join("\n");
  }

  private startQuery(seed: string | null): void {
    const binary = resolveBinary("claude");
    if (!binary) {
      this.setStatus("degraded");
      this.broadcastState();
      return;
    }
    const queue = new AsyncMessageQueue<SDKUserMessage>();
    const abort = new AbortController();
    this.queue = queue;
    this.abortController = abort;
    this.inFlight = false;
    this.completedTurns = 0;

    const options: SdkOptions = {
      abortController: abort,
      model: this.deps.model,
      systemPrompt: MAGIC_UI_SYSTEM_PROMPT,
      // The watcher is a pure text transformer: no tools, ever. Deny at
      // every layer in case the model tries anyway.
      allowedTools: [],
      maxTurns: RESTART_AFTER_TURNS + 5,
      cwd: tmpdir(), // neutral cwd — no project CLAUDE.md leaks into the watcher
      pathToClaudeCodeExecutable: binary,
      includePartialMessages: false,
      // Full server env: the CLI resolves subscription OAuth itself.
      // Do NOT inject ANTHROPIC_API_KEY (see claude-sdk-adapter.ts).
      env: { ...(process.env as Record<string, string>) },
      canUseTool: async () => ({ behavior: "deny", message: "The dashboard watcher may not use tools." }),
    };

    const q = (this.deps.queryFn ?? sdkQuery)({ prompt: queue, options });
    void this.pump(q, abort);

    if (seed) {
      this.inFlight = true;
      queue.push(this.userMessage(seed));
    }
  }

  private userMessage(text: string): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  private async pump(q: AsyncIterable<unknown>, abort: AbortController): Promise<void> {
    let turnTexts: string[] = [];
    try {
      for await (const raw of q) {
        const msg = raw as { type?: string; subtype?: string; message?: { content?: unknown } };
        if (msg.type === "assistant") {
          const text = extractTextFromAssistant(msg as unknown as BrowserIncomingMessage);
          if (text) turnTexts.push(text);
        } else if (msg.type === "result") {
          this.crashRetries = 0;
          this.completedTurns += 1;
          this.handleReply(turnTexts.join("\n"));
          turnTexts = [];
          this.finishTurn();
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        log.warn("magic-ui", "Watcher query crashed", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.handleCrash();
        return;
      }
    }
    // Clean end (abort/close): nothing to do — stop()/restart() own the state.
  }

  private handleCrash(): void {
    if (this.stopped) return;
    this.crashRetries += 1;
    if (this.crashRetries > MAX_CRASH_RETRIES) {
      this.setStatus("degraded");
      this.broadcastState();
      return;
    }
    const backoff = Math.min(30_000, 2_000 * 2 ** (this.crashRetries - 1));
    setTimeout(() => {
      if (!this.stopped) this.startQuery(this.seedMessage());
    }, backoff);
  }

  private handleReply(text: string): void {
    const parsed = parseMagicUiReply(text);
    if (parsed === null) {
      log.warn("magic-ui", "Unparseable watcher reply", { sessionId: this.sessionId, sample: text.slice(0, 200) });
      return;
    }
    if (parsed.length === 0) return;
    const ops = validateOps(parsed);
    if (ops.length === 0) return;
    this.state = applyOps(this.state, ops, this.now());
    this.persistAndBroadcast();
  }

  /** A watcher turn finished: send the queued digest, or restart on budget. */
  private finishTurn(): void {
    this.inFlight = false;
    if (this.completedTurns >= RESTART_AFTER_TURNS) {
      this.restart();
      return;
    }
    if (this.pendingDigest) {
      const digest = this.pendingDigest;
      this.pendingDigest = null;
      this.sendDigest(digest);
    }
  }

  private restart(): void {
    this.abortController?.abort();
    this.queue?.close();
    this.startQuery(this.seedMessage());
    if (this.pendingDigest) {
      const digest = this.pendingDigest;
      this.pendingDigest = null;
      this.sendDigest(digest);
    }
  }

  private sendDigest(digest: string): void {
    if (!this.queue) return;
    if (this.inFlight) {
      // One turn in flight at a time; merge follow-ups into one pending digest.
      this.pendingDigest = this.pendingDigest
        ? `${this.pendingDigest}\n\n${digest}`.slice(-DIGEST_MAX_CHARS * 2)
        : digest;
      return;
    }
    this.inFlight = true;
    this.queue.push(this.userMessage(digest));
  }

  // ── Event intake ──────────────────────────────────────────────────────

  onAssistantMessage(msg: BrowserIncomingMessage): void {
    const text = extractTextFromAssistant(msg);
    if (text.trim()) this.acc.texts.push(text.trim());
    for (const tool of extractToolUses(msg)) {
      this.acc.tools.push({ name: tool.name, summary: toolSummary(tool) });
      const input = tool.rawInput ?? {};
      if ((tool.name === "Edit" || tool.name === "Write" || tool.name === "NotebookEdit") && typeof input.file_path === "string") {
        this.acc.files.add(input.file_path);
      }
    }
    this.touch();
    this.armLatencyTimer();
  }

  onResult(msg: BrowserIncomingMessage): void {
    if (msg.type === "result") {
      const data = (msg as { data?: { duration_ms?: number; num_turns?: number; total_cost_usd?: number } }).data;
      const parts: string[] = [];
      if (typeof data?.duration_ms === "number") parts.push(`${Math.round(data.duration_ms / 1000)}s`);
      if (typeof data?.num_turns === "number") parts.push(`${data.num_turns} turns`);
      this.acc.resultLine = parts.join(", ") || "turn completed";
    }
    this.touch();
    this.flush("turn-end");
  }

  onPermissionRequested(request: PermissionRequest): void {
    const kind = request.tool_name === "AskUserQuestion" ? "QUESTION for user" : `PERMISSION wanted: ${request.tool_name}`;
    const detail = request.tool_name === "AskUserQuestion"
      ? (Array.isArray(request.input.questions)
        ? request.input.questions.map((q) => (q as { question?: string })?.question || "").filter(Boolean).join(" / ").slice(0, 200)
        : "")
      : typeof request.input.command === "string" ? String(request.input.command).slice(0, 120) : (request.description ?? "");
    this.acc.permissionLines.push(`PENDING ${kind}${detail ? ` — ${detail}` : ""}`);
    this.touch();
    // Decisions must reach the dashboard fast.
    this.flush("permission");
  }

  onPermissionResolved(payload: {
    behavior: "allow" | "deny";
    resolvedBy: "user" | "ai";
    toolName?: string;
    answers?: Record<string, string>;
    reason?: string;
  }): void {
    // Server-generated decision-log entry — correctness never depends on Haiku.
    const source = payload.resolvedBy === "ai" ? "ai_auto" : "user";
    const title = payload.toolName === "AskUserQuestion"
      ? "Answered the agent's question"
      : payload.toolName === "ExitPlanMode"
        ? "Plan approval"
        : payload.toolName || "Permission";
    const detail = payload.answers
      ? Object.entries(payload.answers).map(([q, a]) => (q ? `${q} → ${a}` : a)).join("; ").slice(0, 400)
      : payload.reason
        ? `${payload.behavior === "allow" ? "Allowed" : "Denied"} (${payload.reason})`
        : payload.behavior === "allow" ? "Allowed" : "Denied";
    this.state = appendDecision(
      this.state,
      makeDecisionEntry(source, title, detail, this.now(), payload.behavior),
    );
    this.persistAndBroadcast();

    // And give the watcher context.
    this.acc.permissionLines.push(
      `RESOLVED ${title}: ${detail}${payload.resolvedBy === "ai" ? " [auto-resolved by AI validation]" : ""}`,
    );
    this.touch();
    this.armLatencyTimer();
  }

  onPermissionCancelled(): void {
    this.acc.permissionLines.push("A pending request was cancelled (likely interrupt)");
    this.touch();
  }

  // ── Flush machinery ───────────────────────────────────────────────────

  private touch(): void {
    if (this.acc.firstEventAt === null) this.acc.firstEventAt = this.now();
    this.armIdleTimer();
  }

  private armLatencyTimer(): void {
    if (this.latencyTimer) return;
    this.latencyTimer = setTimeout(() => {
      this.latencyTimer = null;
      this.flush("max-latency");
    }, MAX_LATENCY_MS);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.suspendIdle(), IDLE_STOP_MS);
  }

  flush(reason: string): void {
    if (this.latencyTimer) {
      clearTimeout(this.latencyTimer);
      this.latencyTimer = null;
    }
    if (accumulatorEmpty(this.acc)) return;
    if (this.stopped) {
      // Idle-suspended watcher: activity arrived — lazily restart.
      this.start();
    }
    this.digestSeq += 1;
    const digest = buildDigest(this.acc, this.digestSeq);
    this.acc = newAccumulator();
    log.info("magic-ui", `Flushing digest (${reason})`, { sessionId: this.sessionId, seq: this.digestSeq });
    this.sendDigest(digest);
  }

  /** Idle for a while → stop burning a subprocess; state stays broadcastable. */
  private suspendIdle(): void {
    if (this.stopped) return;
    log.info("magic-ui", "Suspending idle watcher", { sessionId: this.sessionId });
    this.teardownQuery();
    this.stopped = true;
    this.setStatus("stopped");
    this.persistAndBroadcast();
  }

  stop(): void {
    this.stopped = true;
    if (this.latencyTimer) clearTimeout(this.latencyTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.latencyTimer = null;
    this.idleTimer = null;
    this.teardownQuery();
    this.setStatus("stopped");
    this.persistAndBroadcast();
    this.deps.store.flush(this.sessionId);
  }

  private teardownQuery(): void {
    this.abortController?.abort();
    this.queue?.close();
    this.abortController = null;
    this.queue = null;
    this.inFlight = false;
  }

  // ── State plumbing ────────────────────────────────────────────────────

  private setStatus(status: MagicUiStatus): void {
    if (this.state.status === status) return;
    this.state = { ...this.state, status, version: this.state.version + 1, updatedAt: this.now() };
  }

  private persistAndBroadcast(): void {
    this.deps.store.save(this.sessionId, this.state);
    this.broadcastState();
  }

  broadcastState(): void {
    this.deps.broadcast(this.sessionId, { type: "magic_ui_state", state: this.state });
  }
}

// ── Manager ─────────────────────────────────────────────────────────────────

export interface MagicUiManagerDeps {
  broadcast: (sessionId: string, msg: BrowserIncomingMessage) => void;
  getSessionState: (sessionId: string) => SessionState | undefined;
  store?: MagicUiStore;
  queryFn?: QueryFn;
  now?: () => number;
}

export class MagicUiWatcherManager {
  private watchers = new Map<string, MagicUiWatcher>();
  private store: MagicUiStore;
  private unsubscribes: Array<() => void> = [];

  constructor(private readonly deps: MagicUiManagerDeps) {
    this.store = deps.store ?? new MagicUiStore();
    this.unsubscribes.push(
      companionBus.on("magic-ui:setting-changed", ({ sessionId }) => this.reconcile(sessionId)),
      companionBus.on("magic-ui:sync-requested", ({ sessionId }) => this.handleSyncRequest(sessionId)),
      companionBus.on("message:assistant", ({ sessionId, message }) => {
        this.watcherFor(sessionId)?.onAssistantMessage(message);
      }),
      companionBus.on("message:result", ({ sessionId, message }) => {
        this.watcherFor(sessionId)?.onResult(message);
      }),
      companionBus.on("permission:requested", ({ sessionId, request }) => {
        this.watcherFor(sessionId)?.onPermissionRequested(request);
      }),
      companionBus.on("permission:resolved", ({ sessionId, ...payload }) => {
        this.watcherFor(sessionId)?.onPermissionResolved(payload);
      }),
      companionBus.on("permission:cancelled", ({ sessionId }) => {
        this.watcherFor(sessionId)?.onPermissionCancelled();
      }),
      companionBus.on("session:exited", ({ sessionId }) => {
        // The CLI exited, but the session may relaunch; keep the watcher
        // unless the user opted out — just note quietness via idle timer.
        void sessionId;
      }),
    );
  }

  /** Effective-enabled watcher for a session, lazily created (e.g. after a
   *  server restart where the persisted session state says active). */
  private watcherFor(sessionId: string): MagicUiWatcher | undefined {
    const existing = this.watchers.get(sessionId);
    if (existing) return existing;
    const sessionState = this.deps.getSessionState(sessionId);
    if (!sessionState) return undefined;
    const effective = getEffectiveMagicUi(sessionState);
    if (!effective.enabled) return undefined;
    return this.startWatcher(sessionId, effective.model);
  }

  private startWatcher(sessionId: string, model: string): MagicUiWatcher {
    const watcher = new MagicUiWatcher(sessionId, {
      broadcast: this.deps.broadcast,
      store: this.store,
      model,
      queryFn: this.deps.queryFn,
      now: this.deps.now,
    });
    this.watchers.set(sessionId, watcher);
    watcher.start();
    log.info("magic-ui", "Watcher started", { sessionId, model });
    return watcher;
  }

  /** Re-evaluate opt-in for a session after set_magic_ui. */
  reconcile(sessionId: string): void {
    const sessionState = this.deps.getSessionState(sessionId);
    const effective = sessionState ? getEffectiveMagicUi(sessionState) : { enabled: false, model: "" };
    const existing = this.watchers.get(sessionId);
    if (effective.enabled && !existing) {
      this.startWatcher(sessionId, effective.model);
    } else if (!effective.enabled && existing) {
      existing.stop();
      this.watchers.delete(sessionId);
      log.info("magic-ui", "Watcher stopped (opt-out)", { sessionId });
    }
  }

  private handleSyncRequest(sessionId: string): void {
    const watcher = this.watcherFor(sessionId);
    if (watcher) {
      watcher.broadcastState();
      return;
    }
    // Not active: still serve the persisted snapshot so reloads of an
    // opted-out-but-previously-magic session show the last dashboard.
    const state = this.store.load(sessionId, this.deps.now ? this.deps.now() : Date.now());
    if (state.version > 0) {
      this.deps.broadcast(sessionId, { type: "magic_ui_state", state });
    }
  }

  removeSession(sessionId: string): void {
    const watcher = this.watchers.get(sessionId);
    if (watcher) {
      watcher.stop();
      this.watchers.delete(sessionId);
    }
    this.store.remove(sessionId);
  }

  shutdown(): void {
    for (const unsub of this.unsubscribes.splice(0)) unsub();
    for (const [id, watcher] of this.watchers) {
      watcher.stop();
      this.watchers.delete(id);
    }
  }
}
