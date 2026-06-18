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
import { mkdirSync, writeFileSync } from "node:fs";
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
import { parseNDJSON, isDuplicateCLIMessage } from "./ws-bridge-cli-ingest.js";
import type { CLIDedupState } from "./ws-bridge-cli-ingest.js";
import { reportProtocolDrift } from "./protocol-monitor.js";

// --- Constants ----------------------------------------------------------------

/** Number of recent CLI message hashes to track for deduplication on WS reconnect. */
const CLI_DEDUP_WINDOW = 2000;

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
  // image/* and application/pdf) inside the working directory so the model
  // can Read them via its file tools. Initially set by the bridge at
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
    },
  ) {
    this.sessionId = sessionId;
    this.recorder = opts?.recorder ?? null;
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
      // be revived on this process. If the child somehow lingers (e.g. it
      // stopped emitting after a fatal API error such as a 429 but never
      // exited), kill it so `proc.exited` resolves and the launcher's
      // `session:exited` → proactive `--resume` relaunch can recover it. Left
      // alive, the process would keep `handleAutoRelaunch`'s PID-liveness guard
      // satisfied, blocking every relaunch path indefinitely.
      const proc = this.stdioProc;
      if (proc && proc.exitCode === null && !proc.killed) {
        log.warn("claude-adapter", "stdout closed while process still alive; killing stale process", {
          sessionId: this.sessionId,
          pid: proc.pid,
        });
        try {
          proc.kill();
        } catch {
          // Process may have exited between the check and the kill.
        }
      }
      this.notifyStdioDisconnect();
    }
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
    //   application/pdf   → inline as { type: "document", source: { base64 } } block
    //   everything else   → write to <cwd>/.companion-uploads/<id>-<name> and
    //                       reference by relative path so the model can Read it
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
        } else if (att.media_type === "application/pdf") {
          blocks.push({
            type: "document",
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
    this.sendToBackend(ndjson);
    return true;
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
    // Track activity for idle detection (skip keepalives -- they don't indicate real work)
    if (msg.type !== "keep_alive") {
      this.onActivityUpdate?.();
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

      case "rate_limit_event":
        // Rate-limit status from Claude API (allowed/throttled). Silently
        // consumed — no user-facing action needed.
        break;

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
  private sendToBackend(ndjson: string): void {
    if (!this.isConnected()) {
      console.log(
        `[claude-adapter] CLI not yet connected for session ${this.sessionId}, queuing message`,
      );
      this.pendingMessages.push(ndjson);
      return;
    }
    // In stdio mode, send the one-time initialize handshake before the first
    // real message (enables the can_use_tool permission flow).
    if (this.transportKind === "stdio") this.ensureStdioInitialized(ndjson);
    this.sendRaw(ndjson);
  }

  /**
   * Low-level send: writes NDJSON to the active transport with a newline
   * delimiter and records the outgoing message. Assumes the transport is
   * connected (callers gate on isConnected() / flush after attach).
   */
  private sendRaw(ndjson: string): void {
    // Record raw outgoing CLI message
    this.recorder?.record(
      this.sessionId, "out", ndjson, "cli", "claude", "",
    );
    try {
      // NDJSON requires a newline delimiter
      if (this.transportKind === "stdio") {
        this.stdioWriter?.write(new TextEncoder().encode(ndjson + "\n"));
      } else {
        this.cliSocket!.send(ndjson + "\n");
      }
    } catch (err) {
      console.error(
        `[claude-adapter] Failed to send to CLI for session ${this.sessionId}:`,
        err,
      );
    }
  }
}
