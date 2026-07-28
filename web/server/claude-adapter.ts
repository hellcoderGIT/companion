/**
 * Claude Code Backend Adapter
 *
 * Translates between the Claude Code NDJSON WebSocket protocol and
 * The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the bridge (and by extension the browser) to be completely
 * unaware of which backend is running -- it sees the same message types
 * regardless of whether Claude Code or Codex is the backend.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { log } from "./logger.js";
import type { ServerWebSocket, Subprocess } from "bun";
import type { IBackendAdapter } from "./backend-adapter.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIMessage,
  CLISystemMessage,
  CLISystemInitMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIAuthStatusMessage,
  CLIControlCancelRequestMessage,
  CLIRateLimitEventMessage,
  CLIStreamlinedTextMessage,
  CLIStreamlinedToolUseSummaryMessage,
  CLIPromptSuggestionMessage,
  CLICompactBoundaryMessage,
  CLITaskNotificationMessage,
  CLIFilesPersistedMessage,
  CLIHookStartedMessage,
  CLIHookProgressMessage,
  CLIHookResponseMessage,
  PermissionRequest,
  McpServerDetail,
  SessionState,
} from "./session-types.js";
import type { SocketData } from "./ws-bridge-types.js";
import type { PendingControlRequest } from "./ws-bridge-types.js";
import type { RecorderManager } from "./recorder.js";
import { captureProcState, hasLiveDescendants, countDescendants, getDescendants, type ProcDescendant } from "./proc-diagnostics.js";
import { getSettings } from "./settings-manager.js";
import { parseNDJSON, isDuplicateCLIMessage } from "./ws-bridge-cli-ingest.js";
import type { CLIDedupState } from "./ws-bridge-cli-ingest.js";
import { reportProtocolDrift } from "./protocol-monitor.js";

// --- Constants ----------------------------------------------------------------

/** Number of recent CLI message hashes to track for deduplication on WS reconnect. */
const CLI_DEDUP_WINDOW = 2000;

/**
 * How long a process with no remaining descendants may sit without exiting
 * before we treat it as wedged and kill it.
 *
 * This was a flat 2s. Measured over 22 kills that timer never once caught a
 * genuinely hung process — all 22 were healthy (21 sleeping, 1 running),
 * typically S/ep_poll with 12 threads: CLIs that had finished reaping and had
 * simply not exited yet. Each kill destroyed the user's in-flight turn.
 *
 * Raised to 10s to match the descendants path. A real wedge is still caught,
 * just 8s later — a trade that costs recovery latency in the rare case and
 * saves a user's answer in the common one.
 */
const STDOUT_CLOSE_GRACE_MS = Number(process.env.COMPANION_STDOUT_CLOSE_GRACE_MS) || 10_000;

/**
 * Longer grace used when stdout EOFs right after a terminal `result` (a clean
 * end-of-turn shutdown). We give the process generous time to flush teardown
 * (MCP servers, etc.) and exit code-0 on its own instead of SIGTERM-ing it.
 * Still bounded so a process that wedges *after* a result (e.g. a teardown
 * deadlock) cannot hang the reader and block recovery indefinitely.
 */
const STDOUT_CLOSE_RESULT_GRACE_MS = Number(process.env.COMPANION_STDOUT_CLOSE_RESULT_GRACE_MS) || 10000;

/**
 * How long to wait after SIGTERM before escalating to SIGKILL.
 *
 * A CLI that ignores SIGTERM because it is itself blocked reaping children used
 * to be left behind by the old flat kill, so `handleAutoRelaunch`'s PID-liveness
 * guard could still see it alive. Escalating guarantees the pid is gone.
 */
const SIGKILL_ESCALATION_MS = Number(process.env.COMPANION_SIGKILL_ESCALATION_MS) || 2000;

/**
 * Absolute backstop on waiting for a process with live descendants, so a stuck
 * child cannot block recovery forever.
 *
 * Set above the CLI's own maximum background-command duration (10 minutes): the
 * descendants being waited on are frequently the agent's own tool subprocesses,
 * and a ceiling below that would kill a legitimately running command — the very
 * failure this path exists to avoid. Only a process still childless-and-idle,
 * or one that blows this ceiling, is treated as wedged.
 */
const TEARDOWN_MAX_MS = Number(process.env.COMPANION_TEARDOWN_MAX_MS) || 660_000;

/**
 * Silence-probe thresholds.
 *
 * A separate failure mode from the wedge: the CLI's stdout stays **open** and
 * the process stays healthy (S/ep_poll, low CPU), but it stops emitting
 * entirely — observed mid-`thinking_delta`, with its upstream HTTPS sockets
 * ESTABLISHED and idle (Recv-Q/Send-Q 0) and no client-side timeout ever
 * firing. Because stdout never closes, none of the stdout-EOF machinery runs:
 * no warning, no kill, no relaunch. The session hangs forever and the UI shows
 * "Still working…" indefinitely.
 *
 * A stalled CLI also stops answering control requests, while a healthy one
 * replies promptly. So after SILENCE_PROBE_AFTER_MS of total silence we send a
 * cheap control_request; if nothing at all comes back within
 * SILENCE_PROBE_TIMEOUT_MS we treat the transport as dead and hand off to the
 * existing relaunch path, which replays the in-flight turn rather than losing
 * it.
 *
 * Thresholds are deliberately generous (~3 minutes end to end). Every previous
 * timer in this file has turned out to be too aggressive and killed healthy
 * processes, and the cost of being wrong here is the same: a needless restart.
 * Any inbound frame — including `keep_alive` — counts as proof of life.
 */
const SILENCE_PROBE_AFTER_MS = Number(process.env.COMPANION_SILENCE_PROBE_AFTER_MS) || 120_000;
const SILENCE_PROBE_TIMEOUT_MS = Number(process.env.COMPANION_SILENCE_PROBE_TIMEOUT_MS) || 60_000;
const SILENCE_CHECK_INTERVAL_MS = Number(process.env.COMPANION_SILENCE_CHECK_INTERVAL_MS) || 15_000;

/**
 * Turn-stall threshold.
 *
 * The silence probe above keys on *total* inbound silence, which recovers a
 * dead turn far later than it needs to — and only if the CLI eventually stops
 * answering control requests as well.
 *
 * Observed on 0.111.1 (session aa37e7de): turn output stopped at 02:10:56
 * mid-`stream_event`, but the CLI kept replying to probes. Every reply refreshes
 * `lastInboundAt`, so escalation is pushed out another full interval each time —
 * five probes were answered before the process finally went silent outright and
 * the probe could fire. Recovery landed at 02:29:33: an **18.6-minute** hang for
 * the user, nearly all of it spent watching a turn that was already dead.
 *
 * The probe is doing its job; it is just asking the wrong question. Transport
 * liveness and turn progress are independent, and a CLI that answers pings
 * forever while its turn is dead would postpone escalation forever.
 *
 * So track turn progress separately from transport liveness. Only substantive
 * turn frames (`stream_event`, `assistant`, `user`, `result`, `tool_progress`)
 * count — control and keepalive traffic does not.
 *
 * False positives are the thing to fear (every previous timer in this file was
 * too aggressive), so this only applies while a turn is actually outstanding,
 * and never while a tool call is in flight: a long `Bash` run legitimately
 * emits nothing for many minutes. The default is deliberately well beyond any
 * plausible model think-time.
 */
const TURN_STALL_AFTER_MS = Number(process.env.COMPANION_TURN_STALL_AFTER_MS) || 300_000;

/**
 * How long a CLI with an outstanding tool call is allowed to stay silent before
 * the liveness probe is permitted to escalate anyway.
 *
 * The CLI does not answer control requests while a synchronous tool runs, so
 * during a long `Bash` call the probe goes unanswered for reasons that have
 * nothing to do with health. Set above the CLI's own maximum background-command
 * duration (10 minutes), on the same reasoning as TEARDOWN_MAX_MS: only a tool
 * that blows this ceiling is treated as a genuine hang.
 */
const TOOL_CALL_PROBE_GRACE_MS = Number(process.env.COMPANION_TOOL_CALL_PROBE_GRACE_MS) || 660_000;

/** How often to re-check the descendant count while waiting for teardown. */
const TEARDOWN_POLL_MS = Number(process.env.COMPANION_TEARDOWN_POLL_MS) || 500;

/**
 * Does this frame type represent the turn actually making progress?
 *
 * `control_response` and `keep_alive` are excluded on purpose — they are the
 * frames a stalled-but-responsive CLI keeps sending. `system` is excluded for
 * the same reason it is excluded from `lastInboundWasResult`: it carries status
 * and keepalive chatter, not turn work.
 */
function isTurnOutput(type: string): boolean {
  return (
    type === "stream_event" ||
    type === "assistant" ||
    type === "user" ||
    type === "result" ||
    type === "tool_progress"
  );
}

/** Extract `tool_use` / `tool_result` ids from a message's content blocks. */
function toolBlockIds(content: unknown): { uses: string[]; results: string[] } {
  const uses: string[] = [];
  const results: string[] = [];
  if (!Array.isArray(content)) return { uses, results };
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; id?: string; tool_use_id?: string };
    if (b.type === "tool_use" && typeof b.id === "string") uses.push(b.id);
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") results.push(b.tool_use_id);
  }
  return { uses, results };
}


// --- Claude Code Adapter ------------------------------------------------------

export class ClaudeAdapter implements IBackendAdapter {
  private sessionId: string;

  // Transport selector. "websocket" is the legacy `--sdk-url` transport where
  // the CLI dials back into the server; "stdio" is the supported stream-json
  // transport where the server owns the child process and bridges over its
  // stdin/stdout pipes. See claude-adapter stdio section below.
  private transportKind: "websocket" | "stdio" = "websocket";

  // WebSocket to the Claude Code CLI process (transportKind === "websocket")
  private cliSocket: ServerWebSocket<SocketData> | null = null;

  // Stdio transport state (transportKind === "stdio")
  private stdioWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private stdioConnected = false;
  private stdioBuffer = "";
  /** Whether the one-time `initialize` control_request handshake has been sent. */
  private stdioInitialized = false;
  /** The spawned child process (stdio transport), so we can detect/kill a
   *  process that lingers after its stdout transport has died. */
  private stdioProc: Subprocess | null = null;
  /** Guard so the disconnect callback fires at most once per transport, no
   *  matter which teardown path (stdout reader end, reader error, or process
   *  exit) trips first. Mirrors CodexAdapter.disconnectFired. */
  private disconnectFired = false;
  /** Whether the most recent substantive CLI message was a terminal `result`
   *  (end-of-turn). Used by the stdout-EOF handler to distinguish a process
   *  that closed stdout while *finishing a turn cleanly* (exiting on its own —
   *  do not force-kill) from one that EOF'd mid-stream (a genuine wedge that
   *  must be killed so recovery can proceed). Transport-level noise
   *  (`keep_alive`, `system` status/keepalive) does not reset it; any
   *  substantive turn activity does. */
  private getStderrTail: (() => string) | null = null;
  private lastInboundWasResult = false;
  /** Timestamp of the last inbound frame of any kind, for the silence probe. */
  private lastInboundAt = Date.now();
  /** When the outstanding silence probe was sent, or null if none is in flight. */
  private probeSentAt: number | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Timestamp of the last substantive *turn* frame, for the turn-stall check.
   * Deliberately narrower than `lastInboundAt`: control_response and keep_alive
   * prove the transport is alive but say nothing about the turn making progress.
   */
  private lastTurnOutputAt = Date.now();
  /** True while a user turn is outstanding — sent to the CLI, no `result` yet. */
  private turnInFlight = false;
  /**
   * `tool_use` ids emitted by the model that have no matching `tool_result` yet.
   * A long-running tool produces no turn output for minutes at a time and must
   * never be mistaken for a stall.
   */
  private pendingToolUses = new Set<string>();

  // Callbacks registered by the bridge via on*() methods
  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;

  // Pending NDJSON messages queued before CLI WebSocket connects
  private pendingMessages: string[] = [];

  // Async control request/response pairs (e.g. MCP status queries)
  private pendingControlRequests = new Map<string, PendingControlRequest>();

  // CLI message deduplication state (rolling hash window)
  private dedupState: CLIDedupState = {
    recentCLIMessageHashes: [],
    recentCLIMessageHashSet: new Set(),
  };

  // Optional recorder for raw protocol messages
  private recorder: RecorderManager | null;

  // Session cwd used to stage non-inline attachments (anything other than
  // image/*, i.e. PDFs and all other files) inside the working directory so the
  // model can Read them via its file tools. Initially set by the bridge at
  // construction time (the bridge always knows the cwd before spawning the
  // CLI) and refreshed from system_init for safety.
  private sessionCwd: string | null = null;

  // Callback to update session.lastCliActivityTs from the bridge
  private onActivityUpdate: (() => void) | null;

  private protocolDriftSeen = new Set<string>();
  private parseErrorSeen = new Set<string>();

  constructor(
    sessionId: string,
    opts?: {
      recorder?: RecorderManager | null;
      onActivityUpdate?: () => void;
      /** Working directory of the session, used to stage attachments to
       *  `<cwd>/.companion-uploads/`. Optional because tests may construct
       *  without it; the bridge should always pass it. */
      cwd?: string;
      /** Reads the rolling stderr tail for this session.
       *
       *  The launcher already captures stderr to classify exit reasons, but on
       *  the wedge path — where the process is killed rather than exiting — that
       *  buffer was never surfaced. It is the only record of what the CLI said
       *  before it dropped its stdout, so it is the one piece of evidence that
       *  can explain a wedge rather than just report it. */
      getStderrTail?: () => string;
    },
  ) {
    this.sessionId = sessionId;
    this.recorder = opts?.recorder ?? null;
    this.getStderrTail = opts?.getStderrTail ?? null;
    this.onActivityUpdate = opts?.onActivityUpdate ?? null;
    this.sessionCwd = opts?.cwd ?? null;
  }

  /** Update the session cwd (e.g. after a worktree switch). */
  setSessionCwd(cwd: string | undefined | null): void {
    if (cwd) this.sessionCwd = cwd;
  }

  // -- WebSocket lifecycle ----------------------------------------------------

  /**
   * Called when the CLI WebSocket connects. Stores the socket reference and
   * flushes any NDJSON messages that were queued before the connection.
   */
  attachWebSocket(ws: ServerWebSocket<SocketData>): void {
    this.cliSocket = ws;

    // Flush pending messages
    if (this.pendingMessages.length > 0) {
      console.log(
        `[claude-adapter] Flushing ${this.pendingMessages.length} queued message(s) for session ${this.sessionId}`,
      );
      const queued = this.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendRaw(ndjson);
      }
    }
  }

  /**
   * Called when the CLI WebSocket closes. Guards against stale socket references
   * (a new WS may have opened before the old one closed).
   */
  detachWebSocket(ws: ServerWebSocket<SocketData>): void {
    // Only detach if this is the current socket -- ignore stale close events
    if (this.cliSocket !== ws) return;
    this.cliSocket = null;
    this.disconnectCb?.();
  }

  // -- Stdio lifecycle (stream-json over the child process pipes) --------------

  /**
   * Attach the spawned `claude` process and drive it over stdio stream-json.
   *
   * This is the supported transport (the `--sdk-url` WebSocket is an internal
   * Remote-Control flag Anthropic locks down). The server owns the process:
   *   • outbound NDJSON is written to the child's stdin
   *   • inbound NDJSON is read from the child's stdout (line-buffered)
   *   • process exit means the transport is gone (relaunch is driven by the
   *     launcher's `session:exited` → proactive relaunch, mirroring Codex stdio).
   *
   * The child must be spawned with `--input-format stream-json
   * --output-format stream-json --permission-prompt-tool stdio` so the
   * `can_use_tool` permission flow round-trips over the same pipes.
   */
  attachStdio(proc: Subprocess): void {
    this.transportKind = "stdio";
    this.stdioConnected = true;
    this.disconnectFired = false;
    this.stdioProc = proc;

    // Wrap Bun's FileSink stdin (which exposes a synchronous `.write()`) in a
    // WritableStream and hold a single writer — matches the proven CodexAdapter
    // idiom and avoids "WritableStream is locked" races under concurrent sends.
    const stdin = proc.stdin as unknown;
    let writable: WritableStream<Uint8Array>;
    if (stdin && typeof (stdin as { write?: unknown }).write === "function") {
      writable = new WritableStream({
        write(chunk) {
          (stdin as { write(data: Uint8Array): number }).write(chunk);
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    this.stdioWriter = writable.getWriter();

    // Begin consuming stdout NDJSON. The reader is async, so the synchronous
    // attach (and the bridge's callback registration that follows the
    // adapter-created event) completes before any message is dispatched.
    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    void this.readStdioStdout(stdout);

    // Watch for the CLI going silent while stdout stays open — invisible to the
    // stdout-EOF path, which only runs when the stream actually closes.
    this.startSilenceProbe();

    // Flush anything queued before the transport attached (applies the lazy
    // `initialize` handshake before the first real message).
    if (this.pendingMessages.length > 0) {
      const queued = this.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.ensureStdioInitialized(ndjson);
        this.sendRaw(ndjson);
      }
    }

    // Mark the transport gone on process exit and notify the bridge. The
    // launcher independently emits `session:exited` (driving the proactive
    // `--resume` relaunch); the disconnect callback here drives the bridge's
    // reconnecting/`cli_disconnected` flow (reconnect banner). Both relaunch
    // requests are de-duplicated by the orchestrator's relaunchingSet, so this
    // does not double-relaunch. Mirrors the Codex stdio path
    // (`proc.exited` → `cleanupAndDisconnect`).
    proc.exited.then(() => {
      this.notifyStdioDisconnect();
    });
  }

  /**
   * Mark the stdio transport gone and fire the disconnect callback exactly
   * once. Routed (by the bridge's `onDisconnect` handler) into the same
   * recovery flow as a WebSocket drop: transition to "reconnecting", broadcast
   * `cli_disconnected` (so the UI shows the reconnect banner), and request an
   * auto-relaunch. Without this, a dead stdio transport left `isConnected()`
   * false while the bridge still believed the backend was attached — every
   * browser message queued forever ("Backend not connected") and the UI span
   * an endless "generating" spinner with no banner.
   */
  private notifyStdioDisconnect(): void {
    this.stdioConnected = false;
    this.stdioWriter = null;
    this.stopSilenceProbe();
    if (this.disconnectFired) return;
    this.disconnectFired = true;
    this.disconnectCb?.();
  }

  /** Line-buffered stdout reader: splits NDJSON and routes complete lines. */
  private async readStdioStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stdioBuffer += decoder.decode(value, { stream: true });
        const lines = this.stdioBuffer.split("\n");
        // Keep the trailing partial line in the buffer until its newline arrives.
        this.stdioBuffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) this.handleRawMessage(line);
        }
      }
    } catch (err) {
      log.error("claude-adapter", "stdio stdout reader error", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // The stdout stream ended: the stream-json transport is dead and cannot
      // be revived on this process. The process is now in one of two states:
      //   (a) Exiting cleanly — its stdout EOFs a beat before it exits (e.g.
      //       right after a `result`). Killing here converts a code-0 exit into
      //       a SIGTERM (143) and forces a needless relaunch.
      //   (b) Wedged — it stopped emitting (e.g. after a fatal API error such
      //       as a 429) but will never exit, leaving `handleAutoRelaunch`'s
      //       PID-liveness guard satisfied and blocking recovery indefinitely.
      // We distinguish them two ways and only kill genuine wedges (b):
      //   1. If the last substantive message was a terminal `result`, the CLI
      //      finished a turn and is shutting down cleanly — wait a generous
      //      (but bounded) grace for it to exit on its own rather than SIGTERM a
      //      code-0 exit. This is the dominant source of the 143-exit relaunch
      //      churn on busy hosts.
      //   2. Otherwise (mid-stream EOF) give it a short grace; kill only if it
      //      is STILL alive afterwards, so a true wedge can't block recovery.
      const proc = this.stdioProc;
      // Escape hatch: the whole kill path exists for a wedge that may no longer
      // occur on current CLI versions — every kill sampled since the /proc
      // instrumentation landed has been a healthy process. Disabling this leaves
      // the process to exit on its own; the transport is still torn down and the
      // session still relaunches, so the only thing lost is forced recovery from
      // a wedge that may be hypothetical.
      const wedgeKillEnabled = getSettings().wedgeKillEnabled !== false;
      if (proc && proc.exitCode === null && !proc.killed && !wedgeKillEnabled) {
        log.info("claude-adapter", "stdout closed but wedge-kill is disabled; leaving process alone", {
          sessionId: this.sessionId,
          pid: proc.pid,
          proc: captureProcState(proc.pid),
          stderrTail: this.stderrTailForLog(),
        });
      } else if (proc && proc.exitCode === null && !proc.killed) {
        // Which grace applies is decided by whether teardown is actually in
        // progress, NOT by whether the last message happened to be a `result`.
        //
        // Every CLI spawns 2-3 MCP stdio servers, and npm-exec-wrapped servers
        // plus headless chromium do not reap inside the short grace. The old
        // `lastInboundWasResult` discriminator was a proxy for "clean shutdown"
        // that has nothing to do with teardown cost, so a healthy CLI landed on
        // the short grace two ways: any non-result/keep_alive/system message
        // trailing the turn, or a fresh adapter (the flag initialises false).
        // It was then SIGTERMed mid-teardown, exiting 143 and taking the user's
        // turn with it.
        //
        // Live descendants are the direct signal: a genuine wedge is idle with
        // no children, whereas a CLI still reaping MCP servers has children
        // mid-exit.
        const teardownInProgress = hasLiveDescendants(proc.pid);
        if (this.lastInboundWasResult || teardownInProgress) {
          // Wait for teardown ADAPTIVELY rather than on a flat timer. A fixed
          // 10s grace still killed 8 of 12 healthy processes: it cannot know
          // how long `npm exec`-wrapped MCP servers plus headless chromium will
          // take, especially with many CLIs contending for I/O.
          //
          // Instead, keep waiting as long as the descendant count is dropping —
          // teardown is demonstrably working, so killing would be wrong at any
          // deadline. Give up only when progress stalls, or at a hard ceiling.
          const exitedOnOwn = await this.awaitTeardown(proc, STDOUT_CLOSE_RESULT_GRACE_MS);
          if (!exitedOnOwn && proc.exitCode === null && !proc.killed) {
            // Capture kernel state BEFORE the kill: once we SIGTERM, the
            // evidence is gone. A wedged CLI writes nothing to stderr, so this
            // is the only signal about why it is still alive.
            log.warn("claude-adapter", "stdout closed after result but process did not exit within grace; killing wedged process", {
              sessionId: this.sessionId,
              pid: proc.pid,
              graceReason: this.lastInboundWasResult ? "result" : "descendants_alive",
              teardownOutcome: this.lastTeardownOutcome,
              proc: captureProcState(proc.pid),
              stderrTail: this.stderrTailForLog(),
            });
            await this.killWithEscalation(proc);
          }
        } else {
          // No descendants left to reap. This used to take a flat 2s timer, but
          // measured over 22 kills that timer never once caught a genuinely
          // hung process: every single one was healthy (21 sleeping, 1 running,
          // 0 hung), typically S/ep_poll with 12 threads — a CLI that had
          // finished reaping and simply had not exited yet.
          //
          // A CLI in that state is indistinguishable from a real wedge by any
          // signal available here, so the tie is broken on cost instead:
          // killing a healthy process destroys the user's in-flight turn, while
          // waiting longer on a truly wedged one only delays recovery. So wait
          // the same way, bounded by the stall window rather than a 2s guess.
          const exitedOnOwn = await this.awaitTeardown(proc, STDOUT_CLOSE_GRACE_MS);
          if (!exitedOnOwn && proc.exitCode === null && !proc.killed) {
            // Reaching here now means a genuine wedge: stdout closed, no live
            // descendants to reap, and still not exited. Snapshot kernel state
            // before the kill destroys it.
            log.warn("claude-adapter", "stdout closed mid-stream and process did not exit within grace; killing wedged process", {
              sessionId: this.sessionId,
              pid: proc.pid,
              graceMs: STDOUT_CLOSE_GRACE_MS,
              graceReason: "no_descendants",
              proc: captureProcState(proc.pid),
              stderrTail: this.stderrTailForLog(),
            });
            await this.killWithEscalation(proc);
          }
        }
      }
      this.notifyStdioDisconnect();
    }
  }

  /** Why the last teardown wait ended, for the kill warning. */
  private lastTeardownOutcome: string | undefined;

  /**
   * Start the silence probe for the stdio transport.
   *
   * Detects a CLI that has gone silent with its stdout still **open** — the one
   * failure mode none of the stdout-EOF machinery can see, because nothing ever
   * closes. Left alone the session hangs indefinitely with no error surfaced.
   */
  private startSilenceProbe(): void {
    this.stopSilenceProbe();
    this.lastInboundAt = Date.now();
    this.probeSentAt = null;
    // A relaunched transport starts with a clean slate: the bridge replays the
    // in-flight turn, which re-arms turnInFlight via handleOutgoingUserMessage.
    this.lastTurnOutputAt = Date.now();
    this.turnInFlight = false;
    this.pendingToolUses.clear();
    this.silenceTimer = setInterval(() => this.checkSilence(), SILENCE_CHECK_INTERVAL_MS);
    // Never hold the process open for a diagnostic timer.
    (this.silenceTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopSilenceProbe(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.probeSentAt = null;
  }

  /**
   * Maintain the outstanding-tool set so a long tool call is never mistaken for
   * a stalled turn. The model announces work with `tool_use` blocks on an
   * `assistant` frame; the CLI echoes the matching `tool_result` blocks back on
   * a `user` frame when it finishes.
   */
  private trackToolCalls(msg: CLIMessage): void {
    if (msg.type !== "assistant" && msg.type !== "user") return;
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    const { uses, results } = toolBlockIds(content);
    for (const id of uses) this.pendingToolUses.add(id);
    for (const id of results) this.pendingToolUses.delete(id);
  }

  /**
   * Last few hundred bytes the CLI wrote to stderr, for kill/stall warnings.
   *
   * Trimmed and length-capped so a chatty process cannot flood the log, and
   * omitted entirely when empty so quiet failures stay quiet.
   */
  private stderrTailForLog(): string | undefined {
    try {
      const tail = this.getStderrTail?.().trim();
      return tail ? tail.slice(-600) : undefined;
    } catch {
      return undefined;
    }
  }

  private checkSilence(): void {
    if (this.transportKind !== "stdio" || !this.stdioConnected) return;
    if (getSettings().silenceProbeEnabled === false) return;

    const now = Date.now();

    // Turn-stall: the CLI is answering control requests but its turn is dead,
    // so `lastInboundAt` never ages and the probe below can never escalate.
    // Only applies while a turn is outstanding and no tool is running.
    if (
      this.turnInFlight &&
      this.pendingToolUses.size === 0 &&
      now - this.lastTurnOutputAt >= TURN_STALL_AFTER_MS
    ) {
      log.warn("claude-adapter", "turn stalled while transport still responsive; treating transport as dead", {
        sessionId: this.sessionId,
        pid: this.stdioProc?.pid,
        turnSilentForMs: now - this.lastTurnOutputAt,
        transportSilentForMs: now - this.lastInboundAt,
        proc: captureProcState(this.stdioProc?.pid),
        stderrTail: this.stderrTailForLog(),
      });
      this.stopSilenceProbe();
      // Same handoff as the silence probe: relaunch replays the in-flight turn.
      this.notifyStdioDisconnect();
      return;
    }

    // An unanswered probe is the actual failure signal: a healthy CLI replies
    // to control requests promptly even while working.
    if (this.probeSentAt !== null) {
      // A long tool call is silence with a cause. The CLI does not service
      // control requests while a synchronous tool runs, so an unanswered probe
      // proves nothing here — and killing on it destroys a healthy session
      // mid-work. Observed in production: a session running its test suite (a
      // single ~200s Bash call) was declared dead at 182s of silence and
      // relaunched, losing the turn.
      //
      // Bounded by TOOL_CALL_PROBE_GRACE_MS so a tool that never returns cannot
      // suppress recovery forever; the ceiling sits above the CLI's own maximum
      // background-command duration, matching TEARDOWN_MAX_MS's reasoning.
      if (
        this.pendingToolUses.size > 0 &&
        now - this.lastInboundAt < TOOL_CALL_PROBE_GRACE_MS
      ) {
        return;
      }
      if (now - this.probeSentAt >= SILENCE_PROBE_TIMEOUT_MS) {
        log.warn("claude-adapter", "CLI silent with stdout open and probe unanswered; treating transport as dead", {
          sessionId: this.sessionId,
          pid: this.stdioProc?.pid,
          silentForMs: now - this.lastInboundAt,
          probeUnansweredForMs: now - this.probeSentAt,
          proc: captureProcState(this.stdioProc?.pid),
          stderrTail: this.stderrTailForLog(),
        });
        this.stopSilenceProbe();
        // Hand off to the existing recovery path, which relaunches and replays
        // the in-flight turn rather than losing it.
        this.notifyStdioDisconnect();
      }
      return;
    }

    if (now - this.lastInboundAt >= SILENCE_PROBE_AFTER_MS) {
      this.probeSentAt = now;
      log.info("claude-adapter", "CLI silent; sending liveness probe", {
        sessionId: this.sessionId,
        pid: this.stdioProc?.pid,
        silentForMs: now - this.lastInboundAt,
      });
      // mcp_status is cheap and side-effect free. We do not care about the
      // payload — any inbound frame clears probeSentAt in routeCLIMessage.
      this.sendControlRequest({ subtype: "mcp_status" });
    }
  }

  /**
   * Wait for a process to exit after its stdout transport has died.
   *
   * Returns true if it exited on its own.
   *
   * The rule is: **a process with live descendants is never killed on a timer.**
   *
   * An earlier version only reset the stall window when the descendant count
   * *dropped*, on the assumption that descendants are MCP servers mid-teardown.
   * Captured evidence disproved that. A representative kill:
   *
   *   graceReason=result state="R (running)" wchan=0 threads=28
   *   descendants=[{comm:"bash"},{comm:"gh"},{comm:"tail"}]
   *
   * Those are the agent's own tool subprocesses — a background command still
   * running after the turn's `result`. The CLI had closed stdout normally at
   * end-of-turn and stayed alive to supervise that work. Its descendant count
   * holds steady for as long as the command runs, so a drop-based test reads it
   * as stalled and kills a process that is actively working (R, on CPU).
   *
   * So any live descendant counts as "busy", not just a falling count. The
   * stall window only accumulates once the process is childless AND idle, which
   * is the one state that genuinely looks like a wedge. TEARDOWN_MAX_MS remains
   * as a backstop so recovery cannot be blocked forever.
   */
  private async awaitTeardown(proc: Subprocess, stallMs: number): Promise<boolean> {
    const started = Date.now();
    let lastProgressAt = started;
    this.lastTeardownOutcome = undefined;

    while (true) {
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TEARDOWN_POLL_MS)),
      ]);
      if (exited || proc.exitCode !== null) {
        this.lastTeardownOutcome = `exited_after_${Date.now() - started}ms`;
        return true;
      }

      const now = Date.now();
      const count = countDescendants(proc.pid);
      if (count > 0) {
        // Live descendants: the process is supervising work — a background tool
        // call, or MCP servers still shutting down. Either way it is doing
        // something, so the stall window must not accumulate.
        lastProgressAt = now;
      }

      if (now - lastProgressAt >= stallMs) {
        this.lastTeardownOutcome =
          `stalled_at_${count}_descendants_after_${now - started}ms`;
        return false;
      }
      if (now - started >= TEARDOWN_MAX_MS) {
        this.lastTeardownOutcome =
          `ceiling_${TEARDOWN_MAX_MS}ms_with_${count}_descendants`;
        return false;
      }
    }
  }

  /**
   * SIGTERM a process, then SIGKILL it if it has not exited.
   *
   * A flat SIGTERM is not enough for the case this path exists to handle: a CLI
   * blocked reaping its own children may never act on the signal, staying alive
   * and satisfying `handleAutoRelaunch`'s PID-liveness guard, which blocks
   * recovery indefinitely — the exact failure the kill was meant to prevent.
   * Never throws; the process may exit between any two steps here.
   *
   * Killing the CLI alone leaks its MCP servers. Signals go to the pid, not the
   * tree, so each CLI's 2-3 stdio MCP children (plus, for @playwright/mcp, a
   * headless chromium) are re-parented to init and live on with no client that
   * could ever reach them. Under kill/relaunch churn they accumulate: a
   * production box was found holding 123 such orphans across 11.9 GB, on 23 GB
   * total — which starves the surviving CLIs until they stop answering, causing
   * more kills and more orphans.
   */
  private async killWithEscalation(proc: Subprocess): Promise<void> {
    // Snapshot the tree *before* the parent dies. Once it exits its children are
    // re-parented to init and the link back to this session is gone for good.
    const spawned = getDescendants(proc.pid);

    try {
      proc.kill();
    } catch {
      this.reapOrphans(spawned); // Parent already gone; children may not be.
      return;
    }

    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SIGKILL_ESCALATION_MS)),
    ]);
    if (exited || proc.exitCode !== null) {
      this.reapOrphans(spawned);
      return;
    }

    log.warn("claude-adapter", "process ignored SIGTERM; escalating to SIGKILL", {
      sessionId: this.sessionId,
      pid: proc.pid,
      afterMs: SIGKILL_ESCALATION_MS,
      stderrTail: this.stderrTailForLog(),
    });
    try {
      proc.kill("SIGKILL");
    } catch {
      // Exited between the check and the escalation.
    }
    this.reapOrphans(spawned);
  }

  /**
   * Terminate descendants that outlived the CLI they belonged to.
   *
   * Only pids snapshotted as descendants of *this* session's process are
   * touched. A pid could in principle be recycled between the snapshot and the
   * signal, so each one is re-checked against the `comm` recorded at snapshot
   * time and skipped if it no longer matches — a recycled pid is a different
   * process and must not be killed.
   */
  private reapOrphans(spawned: ProcDescendant[]): void {
    if (spawned.length === 0) return;

    const stillAlive = spawned.filter((d) => {
      try {
        process.kill(d.pid, 0); // Signal 0 = liveness check only.
      } catch {
        return false; // Already reaped with its parent.
      }
      if (!d.comm) return true;
      try {
        return readFileSync(`/proc/${d.pid}/comm`, "utf8").trim() === d.comm;
      } catch {
        return false;
      }
    });
    if (stillAlive.length === 0) return;

    for (const d of stillAlive) {
      try {
        process.kill(d.pid, "SIGTERM");
      } catch {
        // Exited in the meantime.
      }
    }
    log.info("claude-adapter", "reaped orphaned CLI descendants", {
      sessionId: this.sessionId,
      count: stillAlive.length,
      comms: [...new Set(stillAlive.map((d) => d.comm).filter(Boolean))].slice(0, 5),
    });

    // Chromium (and npm wrappers mid-install) routinely ignore SIGTERM.
    setTimeout(() => {
      for (const d of stillAlive) {
        try {
          process.kill(d.pid, 0);
          process.kill(d.pid, "SIGKILL");
        } catch {
          // Gone, which is the desired outcome.
        }
      }
    }, SIGKILL_ESCALATION_MS).unref?.();
  }

  /**
   * Send the one-time `initialize` control_request before the first outbound
   * message in stdio mode. This registers the canUseTool capability so the CLI
   * emits `can_use_tool` control_requests (via `--permission-prompt-tool
   * stdio`). If the first outbound message is itself an `initialize` (e.g. from
   * injectSystemPrompt for agent sessions), we skip the duplicate.
   */
  private ensureStdioInitialized(nextNdjson: string): void {
    if (this.stdioInitialized) return;
    this.stdioInitialized = true;
    try {
      const parsed = JSON.parse(nextNdjson) as { type?: string; request?: { subtype?: string } };
      if (parsed?.type === "control_request" && parsed.request?.subtype === "initialize") {
        return; // caller is sending its own initialize — don't double up
      }
    } catch {
      // fall through and send the baseline initialize
    }
    this.sendRaw(JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "initialize" },
    }));
  }

  /** True when this adapter owns the child process via stdio (vs legacy WS). */
  usesProcessTransport(): boolean {
    return this.transportKind === "stdio";
  }

  // -- IBackendAdapter: Event registration ------------------------------------

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  // -- IBackendAdapter: Transport state ---------------------------------------

  isConnected(): boolean {
    if (this.transportKind === "stdio") return this.stdioConnected;
    return this.cliSocket !== null;
  }

  async disconnect(): Promise<void> {
    // Clear pending control requests to prevent memory leaks from
    // unresolved promises (CLI won't respond after disconnect)
    this.pendingControlRequests.clear();
    if (this.transportKind === "stdio") {
      // The launcher owns the process lifecycle (kill). Just drop the writer
      // reference and mark disconnected; closing stdin here could race the kill.
      this.stdioConnected = false;
      this.stdioWriter = null;
      return;
    }
    if (this.cliSocket) {
      try {
        this.cliSocket.close();
      } catch {
        // Socket may already be closed
      }
      this.cliSocket = null;
    }
  }

  /**
   * Handle transport-level close (used when WS proxy drops).
   * Clears the socket reference without triggering the disconnect callback,
   * allowing the CLI to reconnect.
   */
  handleTransportClose(): void {
    if (this.transportKind === "stdio") {
      this.notifyStdioDisconnect();
      return;
    }
    this.cliSocket = null;
  }

  // -- IBackendAdapter: Raw message ingestion from CLI ------------------------

  /**
   * Called when raw NDJSON data arrives from the CLI WebSocket.
   * Parses lines, deduplicates, and routes each message.
   */
  handleRawMessage(data: string): void {
    // Record raw incoming CLI message before any parsing
    this.recorder?.record(
      this.sessionId, "in", data, "cli", "claude", "",
    );

    const lines = parseNDJSON(data);
    for (const line of lines) {
      let msg: CLIMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        reportProtocolDrift(
          this.parseErrorSeen,
          {
            backend: "claude",
            sessionId: this.sessionId,
            direction: "incoming",
            messageKind: "parse_error",
            messageName: "ndjson",
            rawPreview: line,
          },
          (message) => this.browserMessageCb?.({ type: "error", message }),
        );
        continue;
      }

      if (isDuplicateCLIMessage(msg, line, this.dedupState, CLI_DEDUP_WINDOW)) {
        continue;
      }

      this.routeCLIMessage(msg);
    }
  }

  // -- IBackendAdapter: send() -- browser -> CLI translation ------------------

  send(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        return this.handleOutgoingUserMessage(msg);

      case "permission_response":
        return this.handleOutgoingPermissionResponse(msg);

      case "interrupt":
        return this.handleOutgoingInterrupt();

      case "set_model":
        return this.handleOutgoingSetModel(msg.model);

      case "set_permission_mode":
        return this.handleOutgoingSetPermissionMode(msg.mode);

      case "set_ai_validation":
        // AI validation state is managed at the bridge/session level, not
        // forwarded to the CLI. Return true to indicate acceptance.
        return true;

      case "mcp_get_status":
        return this.handleOutgoingMcpGetStatus();

      case "mcp_toggle":
        return this.handleOutgoingMcpToggle(msg.serverName, msg.enabled);

      case "mcp_reconnect":
        return this.handleOutgoingMcpReconnect(msg.serverName);

      case "mcp_set_servers":
        return this.handleOutgoingMcpSetServers(msg.servers);

      case "end_session":
        return this.handleOutgoingEndSession((msg as { reason?: string }).reason);

      case "stop_task":
        return this.handleOutgoingStopTask((msg as { task_id: string }).task_id);

      case "update_environment_variables":
        return this.handleOutgoingUpdateEnvVars((msg as { variables: Record<string, string> }).variables);

      case "session_subscribe":
      case "session_ack":
        // These are handled at the bridge level -- never forwarded to the backend.
        return false;

      default:
        return false;
    }
  }

  // -- Outgoing message handlers (browser -> NDJSON) --------------------------

  private handleOutgoingUserMessage(
    msg: {
      type: "user_message";
      content: string;
      session_id?: string;
      attachments?: { name: string; media_type: string; data: string; size: number }[];
    },
  ): boolean {
    // Dispatch each attachment by media type:
    //   image/*           → inline as { type: "image", source: { base64 } } block
    //   everything else   → write to <cwd>/.companion-uploads/<id>-<name> and
    //                       reference by relative path so the model can Read it
    //
    // PDFs and other documents are staged to disk (not inlined as base64
    // `document` blocks): inlining pushes the whole file into every turn's
    // context — expensive and context-blowing for large files — and the user's
    // expectation is that uploads land in the working dir and Claude is told
    // where. Claude's Read tool handles PDFs from disk. This mirrors the Codex
    // adapter, which also inlines only images and stages everything else.
    let content: string | unknown[];
    if (msg.attachments?.length) {
      const blocks: unknown[] = [];
      const stagedRefs: string[] = [];

      for (const att of msg.attachments) {
        if (att.media_type.startsWith("image/")) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: att.media_type, data: att.data },
          });
        } else {
          // Stage to disk; if no cwd yet, fall back to a textual mention so the
          // user isn't silently dropped. (Should be rare since system_init
          // arrives before the first user message.)
          const stagedRef = this.stageAttachmentToDisk(att);
          if (stagedRef) {
            stagedRefs.push(stagedRef);
          } else {
            stagedRefs.push(`(${att.name} — ${att.size} bytes; could not stage to disk)`);
          }
        }
      }

      const augmentedText = stagedRefs.length > 0
        ? `${msg.content}\n\nAttached files (in working directory):\n${stagedRefs.map((r) => `- ${r}`).join("\n")}`
        : msg.content;
      blocks.push({ type: "text", text: augmentedText });
      content = blocks;
    } else {
      content = msg.content;
    }

    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: msg.session_id || "",
    });
    // Propagate delivery success so the bridge re-queues an undelivered prompt
    // (write to a dying stdio pipe) rather than treating send() as delivery.
    const delivered = this.sendToBackend(ndjson);
    if (delivered) {
      // A turn is now outstanding: arm the turn-stall check. Only armed on
      // actual delivery, so an undelivered prompt can't start the clock against
      // a CLI that was never asked to do anything.
      this.turnInFlight = true;
      this.lastTurnOutputAt = Date.now();
      this.pendingToolUses.clear();
    }
    return delivered;
  }

  /**
   * Decode a base64 attachment and write it under <cwd>/.companion-uploads/.
   * Returns the relative path the model should use (e.g.
   * "./.companion-uploads/abc1234-report.csv") or null if staging failed.
   */
  private stageAttachmentToDisk(att: { name: string; media_type: string; data: string; size: number }): string | null {
    if (!this.sessionCwd) {
      log.warn("claude-adapter", "Cannot stage attachment: session cwd is not known yet", {
        sessionId: this.sessionId,
        attachmentName: att.name,
        attachmentSize: att.size,
        mediaType: att.media_type,
      });
      return null;
    }
    try {
      const stagingDir = join(this.sessionCwd, ".companion-uploads");
      mkdirSync(stagingDir, { recursive: true });
      // Sanitize filename: strip path separators, collapse weird chars
      const safeName = basename(att.name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const id = randomUUID().slice(0, 8);
      const finalName = `${id}-${safeName}`;
      const fullPath = join(stagingDir, finalName);
      writeFileSync(fullPath, Buffer.from(att.data, "base64"));
      log.info("claude-adapter", "Staged attachment to disk", {
        sessionId: this.sessionId,
        attachmentName: att.name,
        size: att.size,
        path: fullPath,
      });
      return `./.companion-uploads/${finalName}`;
    } catch (err) {
      log.error("claude-adapter", "Failed to stage attachment", {
        sessionId: this.sessionId,
        attachmentName: att.name,
        cwd: this.sessionCwd,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private handleOutgoingPermissionResponse(
    msg: {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: unknown[];
      message?: string;
    },
  ): boolean {
    if (msg.behavior === "allow") {
      const response: Record<string, unknown> = {
        behavior: "allow",
        updatedInput: msg.updated_input ?? {},
      };
      if (msg.updated_permissions?.length) {
        response.updatedPermissions = msg.updated_permissions;
      }
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response,
        },
      });
      this.sendToBackend(ndjson);
    } else {
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by user",
          },
        },
      });
      this.sendToBackend(ndjson);
    }
    return true;
  }

  private handleOutgoingInterrupt(): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToBackend(ndjson);
    // The user abandoned the turn, so stop holding it against the CLI.
    this.turnInFlight = false;
    this.pendingToolUses.clear();
    return true;
  }

  private handleOutgoingSetModel(model: string): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingSetPermissionMode(mode: string): boolean {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    });
    this.sendToBackend(ndjson);
    return true;
  }

  private handleOutgoingMcpGetStatus(): boolean {
    this.sendControlRequest(
      { subtype: "mcp_status" },
      {
        subtype: "mcp_status",
        resolve: (response) => {
          const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
          this.browserMessageCb?.({ type: "mcp_status", servers });
        },
      },
    );
    return true;
  }

  private handleOutgoingMcpToggle(serverName: string, enabled: boolean): boolean {
    this.sendControlRequest({ subtype: "mcp_toggle", serverName, enabled });
    // Refresh MCP status after a delay to pick up the change
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 500);
    return true;
  }

  private handleOutgoingMcpReconnect(serverName: string): boolean {
    this.sendControlRequest({ subtype: "mcp_reconnect", serverName });
    // Refresh MCP status after a delay to pick up the reconnection
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 1000);
    return true;
  }

  private handleOutgoingMcpSetServers(servers: Record<string, unknown>): boolean {
    this.sendControlRequest({ subtype: "mcp_set_servers", servers });
    // Refresh MCP status after a delay to pick up the new server config
    setTimeout(() => this.handleOutgoingMcpGetStatus(), 2000);
    return true;
  }

  private handleOutgoingEndSession(reason?: string): boolean {
    this.sendControlRequest({ subtype: "end_session", ...(reason ? { reason } : {}) });
    return true;
  }

  private handleOutgoingStopTask(taskId: string): boolean {
    this.sendControlRequest({ subtype: "stop_task", task_id: taskId });
    return true;
  }

  private handleOutgoingUpdateEnvVars(variables: Record<string, string>): boolean {
    const ndjson = JSON.stringify({
      type: "update_environment_variables",
      variables,
    });
    this.sendToBackend(ndjson);
    return true;
  }

  // -- CLI message routing (NDJSON -> BrowserIncomingMessage) -----------------

  private routeCLIMessage(msg: CLIMessage): void {
    // Any frame at all — keep_alive included — proves the transport is alive
    // and clears any outstanding silence probe. This is deliberately broader
    // than the activity tracking below: `keep_alive` is not *work*, but it is
    // proof the CLI is still answering, which is all the probe asks.
    this.lastInboundAt = Date.now();
    this.probeSentAt = null;

    // Turn progress is tracked separately: a CLI can keep answering control
    // requests long after its turn has died (see TURN_STALL_AFTER_MS), so only
    // frames that represent actual turn work count here.
    if (isTurnOutput(msg.type)) {
      this.lastTurnOutputAt = Date.now();
    }
    this.trackToolCalls(msg);
    if (msg.type === "result") {
      this.turnInFlight = false;
      this.pendingToolUses.clear();
    }

    // Track activity for idle detection (skip keepalives -- they don't indicate real work)
    if (msg.type !== "keep_alive") {
      this.onActivityUpdate?.();
    }

    // Track whether the last substantive message was a turn-ending `result`, so
    // the stdout-EOF handler can tell a clean end-of-turn shutdown apart from a
    // mid-stream wedge. `result` marks end-of-turn; any other substantive turn
    // activity clears it. Transport-level noise (`keep_alive`, `system`) is
    // ignored so trailing status/keepalive lines after a result don't mask it.
    if (msg.type === "result") {
      this.lastInboundWasResult = true;
    } else if (msg.type !== "keep_alive" && msg.type !== "system") {
      this.lastInboundWasResult = false;
    }

    switch (msg.type) {
      case "system":
        this.handleSystemMessage(msg);
        break;

      case "assistant":
        this.handleAssistantMessage(msg);
        break;

      case "result":
        this.handleResultMessage(msg);
        break;

      case "stream_event":
        this.handleStreamEvent(msg);
        break;

      case "control_request":
        this.handleControlRequest(msg);
        break;

      case "control_response":
        this.handleControlResponse(msg);
        break;

      case "tool_progress":
        this.handleToolProgress(msg);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(msg);
        break;

      case "auth_status":
        this.handleAuthStatus(msg);
        break;

      case "keep_alive":
        // Silently consume keepalives
        break;

      case "user":
        // CLI echoes back user messages (including tool_result blocks from
        // subagents). These are purely informational — the bridge already
        // persists user messages from the browser side. Silently drop them
        // to avoid rendering raw tool_result JSON in the chat UI.
        break;

      case "rate_limit_event": {
        // Previously discarded. It is the only signal we get about plan-window
        // usage, and recorded traffic shows it does fire in anger (14 warning
        // and 3 rejected events across 200 samples) — while the UI said nothing
        // and the logs kept no record.
        const info = (msg as CLIRateLimitEventMessage).rate_limit_info ?? {};
        // Only non-`allowed` states are logged: `allowed` arrives constantly and
        // would drown the log, whereas a warning or rejection is exactly what a
        // later investigation needs to find.
        if (info.status && info.status !== "allowed") {
          log.warn("claude-adapter", "API rate limit", {
            sessionId: this.sessionId,
            status: info.status,
            utilization: info.utilization,
            rateLimitType: info.rateLimitType,
            resetsAt: info.resetsAt,
            isUsingOverage: info.isUsingOverage,
          });
        }
        this.browserMessageCb?.({ type: "rate_limit", info });
        break;
      }

      case "control_cancel_request":
        this.handleControlCancelRequest(msg as CLIControlCancelRequestMessage);
        break;

      case "streamlined_text":
        this.handleStreamlinedText(msg as CLIStreamlinedTextMessage);
        break;

      case "streamlined_tool_use_summary":
        this.handleStreamlinedToolUseSummary(msg as CLIStreamlinedToolUseSummaryMessage);
        break;

      case "prompt_suggestion":
        this.handlePromptSuggestion(msg as CLIPromptSuggestionMessage);
        break;

      default:
        reportProtocolDrift(
          this.protocolDriftSeen,
          {
            backend: "claude",
            sessionId: this.sessionId,
            direction: "incoming",
            messageKind: "message",
            messageName: (msg as { type?: string }).type || "unknown",
            rawPreview: JSON.stringify(msg),
          },
          (message) => this.browserMessageCb?.({ type: "error", message }),
        );
        break;
    }
  }

  // -- System message handling ------------------------------------------------

  private handleSystemMessage(msg: CLISystemMessage): void {
    if (msg.subtype === "init") {
      this.handleSystemInit(msg as CLISystemInitMessage);
      return;
    }

    if (msg.subtype === "status") {
      const statusMsg = msg as { subtype: "status"; status: "compacting" | null; permissionMode?: string; uuid: string; session_id: string };
      // Include permissionMode in the emitted message so the bridge can update session state
      const statusChange: Record<string, unknown> = {
        type: "status_change",
        status: statusMsg.status ?? null,
      };
      if (statusMsg.permissionMode) {
        statusChange.permissionMode = statusMsg.permissionMode;
      }
      this.browserMessageCb?.(statusChange as BrowserIncomingMessage);
      return;
    }

    if (msg.subtype === "compact_boundary") {
      const m = msg as CLICompactBoundaryMessage;
      this.emitSystemEvent({
        subtype: "compact_boundary",
        compact_metadata: m.compact_metadata,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "task_notification") {
      const m = msg as CLITaskNotificationMessage;
      this.emitSystemEvent({
        subtype: "task_notification",
        task_id: m.task_id,
        status: m.status,
        output_file: m.output_file,
        summary: m.summary,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "files_persisted") {
      const m = msg as CLIFilesPersistedMessage;
      this.emitSystemEvent({
        subtype: "files_persisted",
        files: m.files,
        failed: m.failed,
        processed_at: m.processed_at,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_started") {
      const m = msg as CLIHookStartedMessage;
      this.emitSystemEvent({
        subtype: "hook_started",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_progress") {
      const m = msg as CLIHookProgressMessage;
      // hook_progress is transient -- emitted but not persisted in message history.
      // The bridge handler decides on persistence based on message type.
      this.emitSystemEvent({
        subtype: "hook_progress",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        stdout: m.stdout,
        stderr: m.stderr,
        output: m.output,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    if (msg.subtype === "hook_response") {
      const m = msg as CLIHookResponseMessage;
      this.emitSystemEvent({
        subtype: "hook_response",
        hook_id: m.hook_id,
        hook_name: m.hook_name,
        hook_event: m.hook_event,
        output: m.output,
        stdout: m.stdout,
        stderr: m.stderr,
        exit_code: m.exit_code,
        outcome: m.outcome,
        uuid: m.uuid,
        session_id: m.session_id,
      });
      return;
    }

    // Unknown system subtypes are intentionally ignored until we map them.
  }

  private handleSystemInit(msg: CLISystemInitMessage): void {
    // Cache cwd for subsequent attachment staging
    if (msg.cwd) this.sessionCwd = msg.cwd;

    // Emit session metadata so the bridge can update session state
    this.sessionMetaCb?.({
      cliSessionId: msg.session_id,
      model: msg.model,
      cwd: msg.cwd,
    });

    // Emit session_init to browsers with CLI-provided fields only.
    // The bridge's attachBackendAdapter handler will merge these into the
    // canonical session state (which owns git info, cost, etc.) and broadcast.
    this.browserMessageCb?.({
      type: "session_init",
      session: {
        session_id: msg.session_id,
        model: msg.model,
        cwd: msg.cwd,
        tools: msg.tools,
        permissionMode: msg.permissionMode,
        claude_code_version: msg.claude_code_version,
        mcp_servers: msg.mcp_servers,
        agents: msg.agents ?? [],
        slash_commands: msg.slash_commands ?? [],
        skills: msg.skills ?? [],
      } as SessionState,
    });

    // Flush any NDJSON messages queued before the CLI was initialized
    // (e.g. user sent a message while the CLI was still starting up).
    if (this.pendingMessages.length > 0) {
      console.log(
        `[claude-adapter] Flushing ${this.pendingMessages.length} queued message(s) after init for session ${this.sessionId}`,
      );
      const queued = this.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendRaw(ndjson);
      }
    }
  }

  // -- Assistant, result, stream ----------------------------------------------

  private handleAssistantMessage(msg: CLIAssistantMessage): void {
    // Diagnostic: the CLI fabricates a synthetic, no-op assistant turn
    // (model "<synthetic>", typically text "No response requested.") when a
    // resume replays an injected meta-continuation instead of running the
    // user's real prompt. This is a prime "stuck session" signature — surface
    // it in the Companion server log so the next error search has the full
    // context (the browser only sees the forwarded message).
    if (msg.message?.model === "<synthetic>") {
      const text = Array.isArray(msg.message.content)
        ? msg.message.content
            .map((b) => (b && b.type === "text" ? b.text : ""))
            .join("")
            .slice(0, 120)
        : "";
      log.warn("claude-adapter", "synthetic no-op assistant turn (resume replayed a meta-continuation, not the user's prompt)", {
        sessionId: this.sessionId,
        stopReason: msg.message.stop_reason,
        text,
        parentToolUseId: msg.parent_tool_use_id,
      });
    }
    this.browserMessageCb?.({
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
    });
  }

  private handleResultMessage(msg: CLIResultMessage): void {
    this.browserMessageCb?.({
      type: "result",
      data: msg,
    });
  }

  private handleStreamEvent(msg: CLIStreamEventMessage): void {
    this.browserMessageCb?.({
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  // -- Control request (permission) -------------------------------------------

  private handleControlRequest(msg: CLIControlRequestMessage): void {
    if (msg.request.subtype === "can_use_tool") {
      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        title: msg.request.title,
        display_name: msg.request.display_name,
        blocked_path: msg.request.blocked_path,
        decision_reason: msg.request.decision_reason,
        timestamp: Date.now(),
      };

      this.browserMessageCb?.({
        type: "permission_request",
        request: perm,
      });
    }
  }

  // -- Control cancel request ------------------------------------------------

  private handleControlCancelRequest(msg: CLIControlCancelRequestMessage): void {
    // Clean up any pending async control request in the adapter
    this.pendingControlRequests.delete(msg.request_id);
    // Emit permission_cancelled so the bridge removes from pendingPermissions
    this.browserMessageCb?.({
      type: "permission_cancelled",
      request_id: msg.request_id,
    });
  }

  // -- Streamlined messages (simplified output mode) -------------------------

  private handleStreamlinedText(msg: CLIStreamlinedTextMessage): void {
    this.browserMessageCb?.({
      type: "streamlined_text",
      text: msg.text,
    } as BrowserIncomingMessage);
  }

  private handleStreamlinedToolUseSummary(msg: CLIStreamlinedToolUseSummaryMessage): void {
    this.browserMessageCb?.({
      type: "streamlined_tool_use_summary",
      tool_summary: msg.tool_summary,
    } as BrowserIncomingMessage);
  }

  // -- Prompt suggestions ----------------------------------------------------

  private handlePromptSuggestion(msg: CLIPromptSuggestionMessage): void {
    this.browserMessageCb?.({
      type: "prompt_suggestion",
      suggestions: msg.suggestions,
    } as BrowserIncomingMessage);
  }

  // -- Control response (for pending control requests like MCP status) --------

  private handleControlResponse(msg: CLIControlResponseMessage): void {
    const reqId = msg.response.request_id;
    const pending = this.pendingControlRequests.get(reqId);
    if (!pending) return;
    this.pendingControlRequests.delete(reqId);
    if (msg.response.subtype === "error") {
      console.warn(
        `[claude-adapter] Control request ${pending.subtype} failed: ${msg.response.error}`,
      );
      return;
    }
    pending.resolve(msg.response.response ?? {});
  }

  // -- Tool progress & summary ------------------------------------------------

  private handleToolProgress(msg: CLIToolProgressMessage): void {
    this.browserMessageCb?.({
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(msg: CLIToolUseSummaryMessage): void {
    this.browserMessageCb?.({
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  // -- Auth status ------------------------------------------------------------

  private handleAuthStatus(msg: CLIAuthStatusMessage): void {
    this.browserMessageCb?.({
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  // -- Helpers ----------------------------------------------------------------

  /**
   * Emit a system_event BrowserIncomingMessage to browsers.
   */
  private emitSystemEvent(
    event: Extract<BrowserIncomingMessage, { type: "system_event" }>["event"],
  ): void {
    this.browserMessageCb?.({
      type: "system_event",
      event,
      timestamp: Date.now(),
    });
  }

  /**
   * Send a control_request to the CLI and optionally track the pending response.
   */
  private sendControlRequest(
    request: Record<string, unknown>,
    onResponse?: { subtype: string; resolve: (response: unknown) => void },
  ): void {
    const requestId = randomUUID();
    if (onResponse) {
      this.pendingControlRequests.set(requestId, onResponse);
    }
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    });
    this.sendToBackend(ndjson);
  }

  /**
   * Send a raw NDJSON string to the CLI, bypassing the BrowserOutgoingMessage
   * translation layer. Used for Claude-specific control requests (e.g. initialize)
   * that don't map to a BrowserOutgoingMessage type.
   */
  sendRawNDJSON(ndjson: string): void {
    this.sendToBackend(ndjson);
  }

  /**
   * Send an NDJSON string to the CLI. If the CLI socket is not yet connected,
   * queues the message for later delivery (flushed in attachWebSocket).
   */
  private sendToBackend(ndjson: string): boolean {
    if (!this.isConnected()) {
      console.log(
        `[claude-adapter] CLI not yet connected for session ${this.sessionId}, queuing message`,
      );
      this.pendingMessages.push(ndjson);
      // Safely queued in the adapter's own pre-init buffer — the caller should
      // NOT also re-queue it (returning true means "handled, don't re-queue").
      return true;
    }
    // In stdio mode, send the one-time initialize handshake before the first
    // real message (enables the can_use_tool permission flow).
    if (this.transportKind === "stdio") this.ensureStdioInitialized(ndjson);
    return this.sendRaw(ndjson);
  }

  /**
   * Low-level send: writes NDJSON to the active transport with a newline
   * delimiter and records the outgoing message. Assumes the transport is
   * connected (callers gate on isConnected() / flush after attach).
   */
  private sendRaw(ndjson: string): boolean {
    // Record raw outgoing CLI message
    this.recorder?.record(
      this.sessionId, "out", ndjson, "cli", "claude", "",
    );
    try {
      // NDJSON requires a newline delimiter
      if (this.transportKind === "stdio") {
        // A null writer means the transport is gone (process exiting/exited)
        // even though isConnected() may not have flipped yet. Report failure so
        // the caller re-queues the message instead of losing it down a dead pipe.
        if (!this.stdioWriter) return false;
        this.stdioWriter.write(new TextEncoder().encode(ndjson + "\n"));
      } else {
        if (!this.cliSocket) return false;
        this.cliSocket.send(ndjson + "\n");
      }
      return true;
    } catch (err) {
      console.error(
        `[claude-adapter] Failed to send to CLI for session ${this.sessionId}:`,
        err,
      );
      return false;
    }
  }
}
