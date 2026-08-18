// Tests for the MagicUI watcher: digest building, flush triggers, the
// one-turn-in-flight merge discipline, server-generated decision log
// entries, and manager opt-in reconciliation.
//
// The Agent SDK query() is replaced by an injectable fake that consumes the
// watcher's streaming input queue and replies per test script — no network,
// no subprocess.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildDigest,
  MagicUiWatcher,
  MagicUiWatcherManager,
} from "./magic-ui-watcher.js";
import { emptyMagicUiState, type MagicUiDashboardState } from "./magic-ui-types.js";
import type { MagicUiStore } from "./magic-ui-store.js";
import type { BrowserIncomingMessage, SessionState } from "./session-types.js";
import { companionBus } from "./event-bus.js";

vi.mock("./path-resolver.js", () => ({
  resolveBinary: () => "/usr/bin/claude-fake",
  getEnrichedPath: () => process.env.PATH ?? "",
}));

// Settings used by the manager's reconcile path.
const mockSettings = { magicUiEnabled: true, magicUiModel: "claude-haiku-4-5" };
vi.mock("./settings-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings-manager.js")>();
  return { ...actual, getSettings: () => ({ ...actual.getSettings(), ...mockSettings }) };
});
vi.mock("./claude-cli-runner.js", () => ({
  isClaudeCliAvailable: () => true,
  runClaudePrompt: vi.fn(),
}));

function fakeStore(initial?: MagicUiDashboardState) {
  return {
    saved: [] as MagicUiDashboardState[],
    load: vi.fn(() => initial ?? emptyMagicUiState(0)),
    save: vi.fn(function (this: unknown, _id: string, state: MagicUiDashboardState) {
      store.saved.push(state);
    }),
    flush: vi.fn(),
    flushAll: vi.fn(),
    remove: vi.fn(),
  };
}
let store: ReturnType<typeof fakeStore>;

/** Fake SDK query: consumes the prompt queue; for each user message calls
 *  the responder and yields an assistant + result frame. */
function makeFakeQuery(responder: (text: string) => string | Promise<string>) {
  const received: string[] = [];
  const fn = (({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    async function* gen() {
      for await (const m of prompt) {
        const text = typeof m.message.content === "string" ? m.message.content : "";
        received.push(text);
        const reply = await responder(text);
        yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] }, parent_tool_use_id: null };
        yield { type: "result", subtype: "success" };
      }
    }
    return gen();
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { fn, received };
}

function assistantMsg(text: string, tools: Array<{ name: string; input: Record<string, unknown> }> = []): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...tools.map((t, i) => ({ type: "tool_use", id: `t${i}`, name: t.name, input: t.input })),
      ],
    },
    parent_tool_use_id: null,
  } as unknown as BrowserIncomingMessage;
}

const OPS_REPLY = '```json\n[{"op":"set_slot","slot":"hero","html":"<p>Refactoring auth</p>","area":"hero"}]\n```';

let broadcasts: Array<{ sessionId: string; msg: BrowserIncomingMessage }>;
function makeWatcher(responder: (text: string) => string | Promise<string>) {
  const { fn, received } = makeFakeQuery(responder);
  const watcher = new MagicUiWatcher("sess-1", {
    broadcast: (sessionId, msg) => broadcasts.push({ sessionId, msg }),
    store: store as unknown as MagicUiStore,
    model: "claude-haiku-4-5",
    queryFn: fn,
  });
  return { watcher, received };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  broadcasts = [];
  store = fakeStore();
  mockSettings.magicUiEnabled = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildDigest", () => {
  it("assembles a compact digest and enforces the size budget", () => {
    const digest = buildDigest({
      texts: ["Refactored the auth middleware", "x".repeat(1_000)],
      tools: [{ name: "Edit", summary: "Edit(src/auth.ts)" }],
      files: new Set(["src/auth.ts"]),
      permissionLines: ["PENDING PERMISSION wanted: Bash — rm -rf dist"],
      resultLine: "92s, 6 turns",
      firstEventAt: 1,
    }, 7);
    expect(digest).toContain("TURN DIGEST #7");
    expect(digest).toContain("Refactored the auth middleware");
    expect(digest).toContain("Edit(src/auth.ts)");
    expect(digest).toContain("files touched: src/auth.ts");
    expect(digest).toContain("PENDING PERMISSION");
    expect(digest).toContain("result: 92s, 6 turns");
    // Long assistant text is truncated per-snippet
    expect(digest).toContain("…");
    expect(digest.length).toBeLessThanOrEqual(4_100);
  });
});

describe("MagicUiWatcher", () => {
  it("broadcasts the initial snapshot on start", () => {
    const { watcher } = makeWatcher(() => "[]");
    watcher.start();
    expect(broadcasts.some((b) => b.msg.type === "magic_ui_state")).toBe(true);
    watcher.stop();
  });

  it("flushes a digest on turn end and applies the reply ops", async () => {
    const { watcher, received } = makeWatcher(() => OPS_REPLY);
    watcher.start();
    watcher.onAssistantMessage(assistantMsg("Working on auth", [{ name: "Edit", input: { file_path: "src/auth.ts" } }]));
    watcher.onResult({ type: "result", data: { duration_ms: 5000, num_turns: 2 } } as unknown as BrowserIncomingMessage);

    await waitFor(() => watcher.state.version > 0 && !!watcher.state.slots.hero);
    expect(received[0]).toContain("Working on auth");
    expect(received[0]).toContain("Edit(src/auth.ts)");
    expect(watcher.state.slots.hero.html).toContain("Refactoring auth");
    // persisted + broadcast
    expect(store.save).toHaveBeenCalled();
    expect(broadcasts.filter((b) => b.msg.type === "magic_ui_state").length).toBeGreaterThan(1);
    watcher.stop();
  });

  it("flushes immediately when a permission arrives", async () => {
    const { watcher, received } = makeWatcher(() => "[]");
    watcher.start();
    watcher.onPermissionRequested({
      request_id: "r1",
      tool_name: "Bash",
      input: { command: "rm -rf dist" },
      tool_use_id: "t1",
      timestamp: 1,
    });
    await waitFor(() => received.length === 1);
    expect(received[0]).toContain("PENDING PERMISSION wanted: Bash");
    expect(received[0]).toContain("rm -rf dist");
    watcher.stop();
  });

  it("keeps one turn in flight and merges digests queued behind it", async () => {
    let releaseFirst: (v: string) => void = () => {};
    let call = 0;
    const { watcher, received } = makeWatcher((text) => {
      call += 1;
      if (call === 1) return new Promise<string>((resolve) => { releaseFirst = () => resolve("[]"); void text; });
      return "[]";
    });
    watcher.start();
    // First flush → in flight (responder blocks)
    watcher.onAssistantMessage(assistantMsg("first chunk"));
    watcher.onResult({ type: "result" } as unknown as BrowserIncomingMessage);
    await waitFor(() => received.length === 1);
    // Two more flushes while in flight → merged into ONE pending digest
    watcher.onAssistantMessage(assistantMsg("second chunk"));
    watcher.onResult({ type: "result" } as unknown as BrowserIncomingMessage);
    watcher.onAssistantMessage(assistantMsg("third chunk"));
    watcher.onResult({ type: "result" } as unknown as BrowserIncomingMessage);
    expect(received.length).toBe(1);
    releaseFirst("[]");
    await waitFor(() => received.length === 2);
    expect(received[1]).toContain("second chunk");
    expect(received[1]).toContain("third chunk");
    watcher.stop();
  });

  it("appends server-generated decision entries without involving the model", () => {
    const { watcher } = makeWatcher(() => "[]");
    watcher.start();
    watcher.onPermissionResolved({
      behavior: "allow",
      resolvedBy: "user",
      toolName: "AskUserQuestion",
      answers: { "Which DB?": "Postgres" },
    });
    expect(watcher.state.decisionLog[0]).toMatchObject({
      source: "user",
      title: "Answered the agent's question",
      behavior: "allow",
    });
    expect(watcher.state.decisionLog[0].detail).toContain("Which DB? → Postgres");

    watcher.onPermissionResolved({ behavior: "deny", resolvedBy: "ai", toolName: "Bash", reason: "dangerous" });
    expect(watcher.state.decisionLog[0]).toMatchObject({ source: "ai_auto", title: "Bash", behavior: "deny" });
    watcher.stop();
  });

  it("ignores unparseable replies without corrupting state", async () => {
    const { watcher, received } = makeWatcher(() => "sorry, I cannot do that");
    watcher.start();
    const versionBefore = watcher.state.version;
    watcher.onAssistantMessage(assistantMsg("hello"));
    watcher.onResult({ type: "result" } as unknown as BrowserIncomingMessage);
    await waitFor(() => received.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(watcher.state.version).toBe(versionBefore);
    watcher.stop();
  });
});

describe("MagicUiWatcherManager", () => {
  function makeManager(sessionState: SessionState | undefined) {
    const { fn } = makeFakeQuery(() => "[]");
    return new MagicUiWatcherManager({
      broadcast: (sessionId, msg) => broadcasts.push({ sessionId, msg }),
      getSessionState: () => sessionState,
      store: store as unknown as MagicUiStore,
      queryFn: fn,
    });
  }

  const activeSession = { session_id: "sess-1", magicUiActive: true } as SessionState;

  it("starts a watcher when the session opts in and stops it on opt-out", () => {
    const manager = makeManager(activeSession);
    companionBus.emit("magic-ui:setting-changed", { sessionId: "sess-1", magicUiActive: true });
    expect(broadcasts.some((b) => b.msg.type === "magic_ui_state")).toBe(true);

    broadcasts = [];
    activeSession.magicUiActive = false;
    companionBus.emit("magic-ui:setting-changed", { sessionId: "sess-1", magicUiActive: false });
    // stop() broadcasts a final stopped-status snapshot
    const last = broadcasts.filter((b) => b.msg.type === "magic_ui_state").pop();
    expect((last?.msg as { state: MagicUiDashboardState }).state.status).toBe("stopped");
    activeSession.magicUiActive = true;
    manager.shutdown();
  });

  it("lazily starts a watcher when messages arrive for an opted-in session", async () => {
    const manager = makeManager({ session_id: "sess-1", magicUiActive: true } as SessionState);
    companionBus.emit("message:assistant", { sessionId: "sess-1", message: assistantMsg("hi") });
    expect(broadcasts.some((b) => b.msg.type === "magic_ui_state")).toBe(true);
    manager.shutdown();
  });

  it("does not start watchers for sessions that did not opt in", () => {
    const manager = makeManager({ session_id: "sess-1", magicUiActive: null } as SessionState);
    companionBus.emit("message:assistant", { sessionId: "sess-1", message: assistantMsg("hi") });
    expect(broadcasts.length).toBe(0);
    manager.shutdown();
  });

  it("serves persisted snapshots on sync requests even without an active watcher", () => {
    const persisted: MagicUiDashboardState = { ...emptyMagicUiState(1), version: 4 };
    store = fakeStore(persisted);
    const manager = makeManager({ session_id: "sess-1", magicUiActive: null } as SessionState);
    companionBus.emit("magic-ui:sync-requested", { sessionId: "sess-1" });
    const snap = broadcasts.find((b) => b.msg.type === "magic_ui_state");
    expect((snap?.msg as { state: MagicUiDashboardState }).state.version).toBe(4);
    manager.shutdown();
  });
});

// The watcher's query can die at any time (SDK error, auth failure, killed
// subprocess). handleCrash retries it with exponential backoff and gives up
// into a "degraded" status after MAX_CRASH_RETRIES, so a permanently broken
// watcher stops burning tokens instead of hot-looping forever.
describe("MagicUiWatcher crash handling", () => {
  /** A query that always throws, counting how many times it was started. */
  function makeCrashingQuery() {
    let calls = 0;
    const fn = (() => {
      calls += 1;
      // eslint-disable-next-line require-yield
      async function* gen(): AsyncGenerator<never> {
        throw new Error("query exploded");
      }
      return gen();
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    return { fn, calls: () => calls };
  }

  function makeCrashWatcher() {
    const { fn, calls } = makeCrashingQuery();
    const watcher = new MagicUiWatcher("sess-1", {
      broadcast: (sessionId, msg) => broadcasts.push({ sessionId, msg }),
      store: store as unknown as MagicUiStore,
      model: "claude-haiku-4-5",
      queryFn: fn,
    });
    return { watcher, calls };
  }

  it("retries a crashed query with exponential backoff, then degrades", async () => {
    vi.useFakeTimers();
    try {
      const { watcher, calls } = makeCrashWatcher();
      watcher.start();

      // First attempt crashes almost immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls()).toBe(1);

      // Backoff is 2s, then 4s, then 8s — capped at 30s. Nothing should
      // restart before the delay elapses.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls()).toBe(2);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(calls()).toBe(3);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(calls()).toBe(4);

      // The 4th crash exceeds MAX_CRASH_RETRIES (3): give up rather than
      // retry a 5th time, and surface the failure to the browser.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls()).toBe(4);

      const last = broadcasts.at(-1);
      expect((last?.msg as { state: MagicUiDashboardState }).state.status).toBe("degraded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry after the watcher has been stopped", async () => {
    vi.useFakeTimers();
    try {
      const { watcher, calls } = makeCrashWatcher();
      watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls()).toBe(1);

      // A stop() racing a pending backoff must win — otherwise a stopped
      // session keeps spawning Haiku queries in the background.
      watcher.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
