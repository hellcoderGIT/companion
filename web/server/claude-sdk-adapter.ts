/**
 * SdkClaudeAdapter — the Claude Code transport built on the official
 * `@anthropic-ai/claude-agent-sdk` instead of a hand-rolled stdio bridge.
 *
 * Why this exists: the stdio transport in `ClaudeAdapter` reverse-engineers
 * the CLI's stream-json protocol and owns raw process lifecycle, which is
 * where every transport-level failure this project has debugged lived
 * (spurious stdout EOFs, wedge-kill heuristics, handshake drift across CLI
 * versions). The Agent SDK is Anthropic's maintained implementation of the
 * same protocol: it spawns the same `claude` binary, uses the same
 * subscription credentials, and tracks CLI protocol changes upstream.
 *
 * Design: this class REUSES ClaudeAdapter's entire message brain — routing
 * (`handleRawMessage`), outbound translation (`send` → `handleOutgoing*` →
 * `sendRaw`), recording, and pre-connect queueing — and swaps only the byte
 * transport:
 *
 *   inbound:  SDK async-generator messages → JSON.stringify → handleRawMessage
 *   outbound: sendRaw override parses the NDJSON the base class built and
 *             dispatches it to the SDK (input stream / Query control methods)
 *
 * Because the SDK's message objects ARE the CLI's stream-json frames, the
 * bridge and frontend see byte-identical traffic to the stdio transport.
 *
 * Selection is per spawn: `settings.claudeTransport === "sdk"` (see
 * cli-launcher). Switching the setting and hitting Reconnect migrates a live
 * session between transports via `--resume`.
 */
import { randomUUID } from "node:crypto";
import {
  query,
  type Options as SdkOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "./claude-adapter.js";
import { log } from "./logger.js";
import { AsyncMessageQueue } from "./async-message-queue.js";

export interface SdkAttachOptions {
  model?: string;
  permissionMode?: string;
  /** Reasoning-effort level (low|medium|high|xhigh|max). */
  effort?: string;
  cwd?: string;
  /** Claude-internal session id to resume. */
  resume?: string;
  /** Resume only up to this message UUID (fork points). */
  resumeSessionAt?: string;
  /** Fork to a new session id instead of continuing `resume`. */
  forkSession?: boolean;
  env?: Record<string, string>;
  /** Path to the installed `claude` binary, so the SDK drives the same
   *  logged-in CLI (and the same subscription auth) as the stdio transport. */
  claudeBinary?: string;
}

export class SdkClaudeAdapter extends ClaudeAdapter {
  private sdkQuery: Query | null = null;
  private inputQueue = new AsyncMessageQueue<SDKUserMessage>();
  private abortController = new AbortController();
  private sdkActive = false;
  /** Pending canUseTool resolvers keyed by the synthetic request_id shown to the bridge. */
  private pendingPermissionResolvers = new Map<string, (r: PermissionResult) => void>();
  private exitCb: ((code: number | null) => void) | null = null;
  /** Collects the CLI's stderr (via the SDK callback) for exit classification. */
  private stderrSink: ((data: string) => void) | null = null;

  constructor(
    sessionId: string,
    opts?: ConstructorParameters<typeof ClaudeAdapter>[1] & {
      onStderr?: (data: string) => void;
    },
  ) {
    super(sessionId, opts);
    this.stderrSink = opts?.onStderr ?? null;
  }

  /** Launcher registers this to mirror the stdio path's `proc.exited` handling. */
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  /** Hard-stop the underlying CLI (the SDK terminates its child process). */
  abort(): void {
    this.abortController.abort();
    this.inputQueue.close();
  }

  attachSdk(options: SdkAttachOptions): void {
    this.transportKind = "sdk";
    this.sdkActive = true;

    const sdkOptions: SdkOptions = {
      abortController: this.abortController,
      includePartialMessages: true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode
        ? { permissionMode: options.permissionMode as PermissionMode }
        : {}),
      ...(options.effort ? { effort: options.effort as SdkOptions["effort"] } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.resumeSessionAt ? { resumeSessionAt: options.resumeSessionAt } : {}),
      ...(options.forkSession ? { forkSession: true } : {}),
      ...(options.claudeBinary ? { pathToClaudeCodeExecutable: options.claudeBinary } : {}),
      // Preserve the full server environment: the CLI resolves subscription
      // OAuth credentials itself, exactly like the stdio transport. (Do NOT
      // inject ANTHROPIC_API_KEY here — it would silently switch sessions
      // from subscription windows to metered API billing.)
      env: { ...(process.env as Record<string, string>), ...(options.env ?? {}) },
      stderr: (data: string) => this.stderrSink?.(data),
      canUseTool: (toolName, input, cbOptions) =>
        this.handleCanUseTool(toolName, input, cbOptions),
    };

    this.sdkQuery = query({ prompt: this.inputQueue, options: sdkOptions });
    void this.pumpMessages(this.sdkQuery);

    // Flush anything the bridge queued before the transport attached.
    for (const ndjson of this.pendingMessages.splice(0)) {
      this.sendRaw(ndjson);
    }
  }

  /** Route every SDK message through the same brain as CLI stdout lines. */
  private async pumpMessages(q: Query): Promise<void> {
    let exitCode: number | null = 0;
    try {
      for await (const message of q) {
        this.handleRawMessage(JSON.stringify(message));
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        // Intentional kill (launcher/relaunch): report like a SIGTERM'd child.
        exitCode = 143;
      } else {
        exitCode = 1;
        log.error("claude-sdk-adapter", "SDK query terminated with error", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.sdkActive = false;
      this.sdkQuery = null;
      this.inputQueue.close();
      for (const resolve of this.pendingPermissionResolvers.values()) {
        resolve({ behavior: "deny", message: "Session ended" });
      }
      this.pendingPermissionResolvers.clear();
      // Same single-shot disconnect contract as the stdio transport.
      if (!this.disconnectFired) {
        this.disconnectFired = true;
        this.disconnectCb?.();
      }
      this.exitCb?.(exitCode);
    }
  }

  // ── Permissions: SDK callback ⇆ existing bridge round-trip ────────────────

  /**
   * The SDK surfaces permission prompts as a callback instead of raw
   * `can_use_tool` control_request frames. Re-synthesize the frame the CLI
   * would have sent so the bridge's permission UI, AI validation, and
   * cancellation flows run unchanged; the bridge's eventual
   * `control_response` is intercepted in `sendRaw` and resolves the callback.
   */
  private handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    cbOptions: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: unknown;
      title?: string;
      tool_use_id?: string;
    },
  ): Promise<PermissionResult> {
    const requestId = `sdkperm-${randomUUID()}`;
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissionResolvers.set(requestId, resolve);

      cbOptions.signal.addEventListener("abort", () => {
        if (!this.pendingPermissionResolvers.delete(requestId)) return;
        // Mirror the CLI's cancel frame so the bridge clears its pending UI.
        this.handleRawMessage(
          JSON.stringify({ type: "control_cancel_request", request_id: requestId }),
        );
        resolve({ behavior: "deny", message: "Request cancelled" });
      });

      this.handleRawMessage(
        JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: {
            subtype: "can_use_tool",
            tool_name: toolName,
            input,
            permission_suggestions: cbOptions.suggestions,
            blocked_path: cbOptions.blockedPath,
            decision_reason: cbOptions.decisionReason,
            title: cbOptions.title,
            tool_use_id: cbOptions.tool_use_id,
          },
        }),
      );
    });
  }

  // ── Transport overrides ───────────────────────────────────────────────────

  isConnected(): boolean {
    return this.sdkActive;
  }

  async disconnect(): Promise<void> {
    // Mirrors the stdio contract: mark the transport gone; the launcher owns
    // the hard kill (abort()). Closing the input stream lets the CLI finish
    // its current turn and exit cleanly.
    this.sdkActive = false;
    this.inputQueue.close();
  }

  /**
   * The base class hands every outbound frame here as NDJSON. Parse it back
   * and dispatch to the SDK: user messages into the input stream, control
   * requests onto the Query's control methods, and permission
   * control_responses into the pending canUseTool resolvers.
   */
  protected sendRaw(ndjson: string): boolean {
    this.recorder?.record(this.sessionId, "out", ndjson, "cli", "claude", "");

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ndjson) as Record<string, unknown>;
    } catch {
      return false;
    }

    switch (msg.type) {
      case "user": {
        const m = msg as unknown as { message: SDKUserMessage["message"]; parent_tool_use_id?: string | null };
        this.inputQueue.push({
          type: "user",
          message: m.message,
          parent_tool_use_id: m.parent_tool_use_id ?? null,
        } as SDKUserMessage);
        return true;
      }

      case "control_response":
        return this.resolvePermissionFromControlResponse(msg);

      case "control_request":
        return this.dispatchControlRequest(msg);

      default:
        log.warn("claude-sdk-adapter", "Unsupported outbound frame for SDK transport; dropped", {
          sessionId: this.sessionId,
          frameType: String(msg.type),
        });
        return false;
    }
  }

  private resolvePermissionFromControlResponse(msg: Record<string, unknown>): boolean {
    const response = (msg as {
      response?: { request_id?: string; response?: Record<string, unknown> };
    }).response;
    const requestId = response?.request_id;
    if (!requestId) return false;
    const resolve = this.pendingPermissionResolvers.get(requestId);
    if (!resolve) {
      // Not a permission reply we own (e.g. a stray late response) — ignore.
      return true;
    }
    this.pendingPermissionResolvers.delete(requestId);
    const inner = response?.response ?? {};
    if (inner.behavior === "allow") {
      resolve({
        behavior: "allow",
        updatedInput: (inner.updatedInput as Record<string, unknown>) ?? {},
        ...(Array.isArray(inner.updatedPermissions) && inner.updatedPermissions.length
          ? { updatedPermissions: inner.updatedPermissions as PermissionUpdate[] }
          : {}),
      });
    } else {
      resolve({
        behavior: "deny",
        message: typeof inner.message === "string" ? inner.message : "Denied by user",
      });
    }
    return true;
  }

  /** Map the CLI control protocol onto the SDK Query's methods. */
  private dispatchControlRequest(msg: Record<string, unknown>): boolean {
    const requestId = String(msg.request_id ?? "");
    const request = (msg.request ?? {}) as Record<string, unknown>;
    const subtype = String(request.subtype ?? "");
    const q = this.sdkQuery;
    if (!q) return false;

    const respond = (payload: Record<string, unknown> = {}) => {
      this.handleRawMessage(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: payload },
        }),
      );
    };
    const respondError = (error: string) => {
      this.handleRawMessage(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "error", request_id: requestId, error },
        }),
      );
    };

    switch (subtype) {
      case "interrupt":
        q.interrupt().then(() => respond()).catch((e) => respondError(String(e)));
        return true;
      case "set_model":
        q.setModel(request.model as string | undefined)
          .then(() => respond())
          .catch((e) => respondError(String(e)));
        return true;
      case "set_permission_mode":
        q.setPermissionMode(request.mode as PermissionMode)
          .then(() => respond())
          .catch((e) => respondError(String(e)));
        return true;
      case "mcp_status":
        q.mcpServerStatus()
          .then((servers) => respond({ mcpServers: servers }))
          .catch((e) => respondError(String(e)));
        return true;
      case "end_session":
        // Graceful shutdown: stop feeding input; the CLI ends on its own.
        this.inputQueue.close();
        respond();
        return true;
      default:
        // Honest failure beats silent drop: the bridge's resolver (if any)
        // gets an error response instead of timing out.
        respondError(`Control subtype "${subtype}" is not supported by the SDK transport`);
        return true;
    }
  }
}
