import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mocks ────────────────────────────────────────────────────────────────────
// fetchClaudeModels spawns the Claude Code CLI in stdio stream-json mode and
// sends a single `initialize` control_request. We mock node:child_process
// spawn with a fake child that replays the CLI's control_response, plus
// path-resolver / fs so no real binary or PATH is touched.

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

const mockResolveBinary = vi.hoisted(() => vi.fn((_n: string) => "/usr/bin/claude" as string | null));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  getEnrichedPath: () => "/usr/bin:/bin",
}));

// statSync drives the cache key (binary path + mtime): a changed mtime means
// the CLI was upgraded and the cache must be bypassed.
const mockStatSync = vi.hoisted(() => vi.fn((_p: string) => ({ mtimeMs: 1 })));
vi.mock("node:fs", () => ({ statSync: mockStatSync }));

import { parseClaudeInitModels, fetchClaudeModels, _resetClaudeModelsCache } from "./claude-models.js";

// Trimmed copy of the real `models` array from a Claude Code 2.1.306
// initialize response: a "default" alias, alias entries (opus/fable/haiku)
// carrying resolvedModel, and explicit-ID entries — one of which (Haiku 4.5)
// has no effort support.
const CLI_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest", supportsThinkingOff: true },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Everyday", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
];

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stdin: { write: (line: string) => void };
  kill: ReturnType<typeof vi.fn>;
}

// A fake CLI process: when the code under test writes the initialize
// control_request to stdin, it answers with a control_response echoing the
// request_id (preceded by an unrelated line, as the real CLI may emit other
// frames first). Behavior is configurable for failure branches.
function makeFakeChild(opts: {
  models?: unknown;
  subtype?: string;
  onInit?: (child: FakeChild) => void;
} = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = {
    write: (line: string) => {
      const msg = JSON.parse(line);
      if (msg.request?.subtype !== "initialize") return;
      if (opts.onInit) { opts.onInit(child); return; }
      const response = {
        type: "control_response",
        response: { subtype: opts.subtype ?? "success", request_id: msg.request_id, response: { models: opts.models ?? CLI_MODELS } },
      };
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from('{"type":"system","subtype":"other"}\nnot json\n'));
        child.stdout.emit("data", Buffer.from(JSON.stringify(response) + "\n"));
      });
    },
  };
  return child;
}

describe("parseClaudeInitModels", () => {
  // Core contract: concrete IDs (not aliases), nice display names, the
  // "default" alias collapsed into an isDefault flag on its target, which is
  // floated first so the picker defaults to the CLI's recommendation.
  it("keys by resolvedModel, drops the default alias, dedupes, and floats the default first", () => {
    const models = parseClaudeInitModels(CLI_MODELS);

    expect(models.map((m) => m.value)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
    ]);
    expect(models[0]).toMatchObject({ label: "Opus 5.5", isDefault: true });
    expect(models[1].isDefault).toBeUndefined();
  });

  // Effort levels are per-model: Opus 4.6 lacks xhigh, Haiku 4.5 has no effort
  // control at all (empty list → the effort picker offers only "Default").
  it("exposes per-model effort levels, empty when the model has no effort support", () => {
    const byId = Object.fromEntries(parseClaudeInitModels(CLI_MODELS).map((m) => [m.value, m]));
    expect(byId["claude-opus-4-6"].efforts).toEqual(["low", "medium", "high", "max"]);
    expect(byId["claude-haiku-4-5-20251001"].efforts).toEqual([]);
  });

  // Forward-compat: a brand-new model the Companion has never heard of is
  // surfaced as-is — the whole point of reading the list from the CLI.
  it("passes through unknown future models", () => {
    const models = parseClaudeInitModels([{ value: "fable", resolvedModel: "claude-fable-9-9", displayName: "Fable 9.9" }]);
    expect(models).toEqual([{ value: "claude-fable-9-9", label: "Fable 9.9", description: "", efforts: [] }]);
  });

  it("falls back to value when resolvedModel is absent, and to the id for the label", () => {
    expect(parseClaudeInitModels([{ value: "claude-x" }])[0]).toMatchObject({ value: "claude-x", label: "claude-x" });
  });

  it("returns [] for malformed payloads", () => {
    expect(parseClaudeInitModels(undefined)).toEqual([]);
    expect(parseClaudeInitModels({})).toEqual([]);
    expect(parseClaudeInitModels([null, 42, "x", {}])).toEqual([]);
  });
});

describe("fetchClaudeModels", () => {
  beforeEach(() => {
    _resetClaudeModelsCache();
    mockSpawn.mockReset();
    mockResolveBinary.mockReset().mockReturnValue("/usr/bin/claude");
    mockStatSync.mockReset().mockReturnValue({ mtimeMs: 1 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Happy path: spawns the CLI in stdio stream-json mode with no-side-effect
  // flags, sends only initialize (no user message → no API call), parses the
  // models, and kills the throwaway process.
  it("probes the CLI via initialize and returns parsed models", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const models = await fetchClaudeModels();

    expect(models[0].value).toBe("claude-opus-5-5");
    const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("/usr/bin/claude");
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--no-session-persistence", "--strict-mcp-config"]));
    expect(child.kill).toHaveBeenCalled();
  });

  // Cache: a second call doesn't respawn; an upgraded binary (new mtime) does.
  it("caches per binary mtime and refreshes after a CLI upgrade", async () => {
    mockSpawn.mockImplementation(() => makeFakeChild());

    await fetchClaudeModels();
    await fetchClaudeModels();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockStatSync.mockReturnValue({ mtimeMs: 2 });
    await fetchClaudeModels();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  // TTL is 12h: still cached just before it, re-probed just after (covers
  // account/settings changes that alter the list without a CLI upgrade).
  it("re-probes after the 12h TTL but not before", async () => {
    vi.useFakeTimers();
    mockSpawn.mockImplementation(() => makeFakeChild());
    const H = 60 * 60 * 1000;

    await fetchClaudeModels();
    vi.advanceTimersByTime(12 * H - 1000);
    await fetchClaudeModels();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await fetchClaudeModels();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("returns [] without spawning when the claude binary is missing", async () => {
    mockResolveBinary.mockReturnValue(null);
    expect(await fetchClaudeModels()).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns [] on an error control_response", async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ subtype: "error" }));
    expect(await fetchClaudeModels()).toEqual([]);
  });

  it("returns [] when the process exits or errors before responding", async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ onInit: (c) => c.emit("exit", 1) }));
    expect(await fetchClaudeModels()).toEqual([]);
    mockSpawn.mockReturnValue(makeFakeChild({ onInit: (c) => c.emit("error", new Error("x")) }));
    expect(await fetchClaudeModels()).toEqual([]);
  });

  // A wedged CLI must not hang the HTTP route: the timeout resolves to [].
  it("returns [] after the timeout when the CLI never answers", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild({ onInit: () => { /* silent */ } });
    mockSpawn.mockReturnValue(child);

    const p = fetchClaudeModels({ timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);

    expect(await p).toEqual([]);
    expect(child.kill).toHaveBeenCalled();
  });

  // Failed probes must not be cached, so the next picker load retries.
  it("does not cache an empty result", async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild({ subtype: "error" }));
    expect(await fetchClaudeModels()).toEqual([]);
    mockSpawn.mockReturnValueOnce(makeFakeChild());
    expect((await fetchClaudeModels()).length).toBeGreaterThan(0);
  });
});
