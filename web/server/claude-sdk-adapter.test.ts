import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub Bun.hash for vitest (runs under Node, not Bun) — the shared CLI-message
// dedup in ws-bridge-cli-ingest hashes raw lines with it. Same stub as
// ws-bridge-cli-ingest.test.ts.
if (typeof globalThis.Bun === "undefined") {
  (globalThis as unknown as { Bun: { hash: (s: string) => bigint } }).Bun = {
    hash: (input: string) => {
      let h = 0n;
      for (let i = 0; i < input.length; i++) {
        h = (h * 31n + BigInt(input.charCodeAt(i))) & 0xffffffffffffn;
      }
      return h;
    },
  };
}

/**
 * SdkClaudeAdapter tests — the switchable Agent-SDK transport.
 *
 * These verify the adapter's core contract: it must be wire-compatible with
 * the stdio ClaudeAdapter from the bridge's point of view. The SDK itself is
 * mocked with a controllable async generator + method spies, so every test
 * exercises the real base-class routing (handleRawMessage / handleOutgoing*)
 * end to end without spawning a CLI.
 */

// Controllable stand-in for the SDK's Query async generator.
class MockQuery {
  private buffer: unknown[] = [];
  private waiters: Array<{
    resolve: (r: IteratorResult<unknown>) => void;
    reject: (e: Error) => void;
  }> = [];
  private done = false;
  private error: Error | null = null;
  interrupt = vi.fn(async () => undefined);
  setModel = vi.fn(async () => undefined);
  setPermissionMode = vi.fn(async () => undefined);
  mcpServerStatus = vi.fn(async () => [{ name: "test-mcp", status: "connected" }]);

  emit(msg: unknown): void {
    const w = this.waiters.shift();
    if (w) w.resolve({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  end(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  /** Make the generator reject — how the live SDK surfaces an abort/crash. */
  fail(err: Error): void {
    this.error = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.error) return Promise.reject(this.error);
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift(), done: false });
    }
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<unknown>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(e: unknown): Promise<IteratorResult<unknown>> {
    return Promise.reject(e);
  }
}

const mockState = vi.hoisted(() => ({
  lastQuery: null as unknown,
  lastParams: null as { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> } | null,
  canUseTool: null as
    | ((toolName: string, input: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>)
    | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((params: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    mockState.lastParams = params;
    mockState.canUseTool = (params.options?.canUseTool as typeof mockState.canUseTool) ?? null;
    return mockState.lastQuery;
  }),
}));

import { SdkClaudeAdapter } from "./claude-sdk-adapter.js";

async function drainInput(iterable: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  const it = iterable[Symbol.asyncIterator]();
  for (let i = 0; i < count; i++) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

function makeAdapter() {
  const q = new MockQuery();
  mockState.lastQuery = q;
  const adapter = new SdkClaudeAdapter("test-session");
  const browserMessages: Array<Record<string, unknown>> = [];
  adapter.onBrowserMessage((m) => browserMessages.push(m as unknown as Record<string, unknown>));
  const disconnects: number[] = [];
  adapter.onDisconnect(() => disconnects.push(Date.now()));
  const exits: Array<number | null> = [];
  adapter.onExit((code) => exits.push(code));
  adapter.attachSdk({ model: "claude-opus-5", permissionMode: "bypassPermissions", cwd: "/tmp" });
  return { adapter, q, browserMessages, disconnects, exits };
}

beforeEach(() => {
  mockState.lastQuery = null;
  mockState.lastParams = null;
  mockState.canUseTool = null;
});

describe("SdkClaudeAdapter", () => {
  it("reports connected after attach and passes core options to the SDK", () => {
    const { adapter } = makeAdapter();
    expect(adapter.isConnected()).toBe(true);
    const opts = mockState.lastParams?.options ?? {};
    expect(opts.model).toBe("claude-opus-5");
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.includePartialMessages).toBe(true);
    // Env must inherit the process env (subscription auth resolution).
    expect((opts.env as Record<string, string>).PATH).toBeDefined();
  });

  it("forwards user messages into the SDK input stream", async () => {
    const { adapter } = makeAdapter();
    adapter.send({
      type: "user_message",
      content: "hello there",
    } as never);
    const [first] = (await drainInput(mockState.lastParams!.prompt, 1)) as Array<{
      type: string;
      message: { role: string };
      parent_tool_use_id: null;
    }>;
    expect(first.type).toBe("user");
    expect(first.message.role).toBe("user");
    expect(first.parent_tool_use_id).toBeNull();
  });

  it("routes inbound SDK messages through the shared message brain", async () => {
    const { q, browserMessages } = makeAdapter();
    q.emit({
      type: "assistant",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }] },
      session_id: "cli-sess-1",
    });
    await vi.waitFor(() => {
      expect(browserMessages.some((m) => m.type === "assistant")).toBe(true);
    });
  });

  it("maps interrupt to Query.interrupt()", async () => {
    const { adapter, q } = makeAdapter();
    adapter.send({ type: "interrupt" } as never);
    await vi.waitFor(() => expect(q.interrupt).toHaveBeenCalledOnce());
  });

  it("maps set_model and set_permission_mode to the Query methods", async () => {
    const { adapter, q } = makeAdapter();
    adapter.send({ type: "set_model", model: "claude-sonnet-5" } as never);
    adapter.send({ type: "set_permission_mode", mode: "acceptEdits" } as never);
    await vi.waitFor(() => {
      expect(q.setModel).toHaveBeenCalledWith("claude-sonnet-5");
      expect(q.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    });
  });

  it("serves mcp_get_status from Query.mcpServerStatus()", async () => {
    const { adapter, q, browserMessages } = makeAdapter();
    adapter.send({ type: "mcp_get_status" } as never);
    await vi.waitFor(() => {
      expect(q.mcpServerStatus).toHaveBeenCalledOnce();
      const status = browserMessages.find((m) => m.type === "mcp_status");
      expect(status).toBeDefined();
      expect((status?.servers as Array<{ name: string }>)[0]?.name).toBe("test-mcp");
    });
  });

  it("round-trips canUseTool through the bridge permission flow (allow)", async () => {
    const { adapter, browserMessages } = makeAdapter();
    expect(mockState.canUseTool).toBeTypeOf("function");

    const resultPromise = mockState.canUseTool!(
      "Bash",
      { command: "ls" },
      { signal: new AbortController().signal, suggestions: [] },
    );

    // The adapter must synthesize the CLI's can_use_tool frame for the bridge.
    const req = await vi.waitFor(() => {
      const r = browserMessages.find((m) => m.type === "permission_request");
      expect(r).toBeDefined();
      return r as { request: { request_id: string; tool_name: string } };
    });
    expect(req.request.tool_name).toBe("Bash");

    // Bridge answers like it would for the stdio transport.
    adapter.send({
      type: "permission_response",
      request_id: req.request.request_id,
      behavior: "allow",
      updated_input: { command: "ls -la" },
    } as never);

    const result = (await resultPromise) as { behavior: string; updatedInput: Record<string, unknown> };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toEqual({ command: "ls -la" });
  });

  it("round-trips canUseTool deny with the user's message", async () => {
    const { adapter, browserMessages } = makeAdapter();
    const resultPromise = mockState.canUseTool!(
      "Write",
      { file_path: "/etc/passwd" },
      { signal: new AbortController().signal },
    );
    const req = await vi.waitFor(() => {
      const r = browserMessages.find((m) => m.type === "permission_request");
      expect(r).toBeDefined();
      return r as { request: { request_id: string } };
    });
    adapter.send({
      type: "permission_response",
      request_id: req.request.request_id,
      behavior: "deny",
      message: "nope",
    } as never);
    const result = (await resultPromise) as { behavior: string; message: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe("nope");
  });

  it("cancelling via the SDK abort signal clears the pending permission in the bridge", async () => {
    const { browserMessages } = makeAdapter();
    const ac = new AbortController();
    const resultPromise = mockState.canUseTool!("Bash", { command: "ls" }, { signal: ac.signal });
    await vi.waitFor(() => {
      expect(browserMessages.some((m) => m.type === "permission_request")).toBe(true);
    });
    ac.abort();
    const result = (await resultPromise) as { behavior: string };
    expect(result.behavior).toBe("deny");
    await vi.waitFor(() => {
      expect(browserMessages.some((m) => m.type === "permission_cancelled")).toBe(true);
    });
  });

  it("fires disconnect + exit(0) when the SDK stream ends cleanly", async () => {
    const { adapter, q, disconnects, exits } = makeAdapter();
    q.end();
    await vi.waitFor(() => {
      expect(disconnects.length).toBe(1);
      expect(exits).toEqual([0]);
    });
    expect(adapter.isConnected()).toBe(false);
  });

  it("reports exit 143 when aborted (kill path), mirroring a SIGTERM'd child", async () => {
    const { adapter, q, exits } = makeAdapter();
    // Simulate the SDK generator rejecting after abort, as it does live.
    adapter.abort();
    q.fail(new Error("aborted"));
    await vi.waitFor(() => expect(exits).toEqual([143]));
  });

  it("queues messages sent before attach and flushes them on attach", async () => {
    const q = new MockQuery();
    mockState.lastQuery = q;
    const adapter = new SdkClaudeAdapter("late-attach");
    adapter.onBrowserMessage(() => {});
    // Not attached yet — send queues instead of dropping.
    adapter.send({ type: "user_message", content: "early" } as never);
    adapter.attachSdk({});
    const [first] = (await drainInput(mockState.lastParams!.prompt, 1)) as Array<{
      message: { content: unknown };
    }>;
    expect(JSON.stringify(first.message.content)).toContain("early");
  });
});
