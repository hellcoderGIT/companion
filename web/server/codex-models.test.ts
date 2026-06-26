import { vi, describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mocks ────────────────────────────────────────────────────────────────────
// fetchCodexModels spawns `codex app-server` and speaks JSON-RPC over stdio.
// We mock node:child_process spawn with a fake child that replays the Codex
// handshake, plus path-resolver / fs so no real binary or PATH is touched.

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

const mockResolveBinary = vi.hoisted(() => vi.fn((_n: string) => "/usr/bin/codex" as string | null));
const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/bin"));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  getEnrichedPath: mockGetEnrichedPath,
}));

const mockExistsSync = vi.hoisted(() => vi.fn(() => false));
const mockRealpathSync = vi.hoisted(() => vi.fn((p: string) => p));
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  realpathSync: mockRealpathSync,
}));

import { parseCodexModelList, fetchCodexModels, _resetCodexModelsCache } from "./codex-models.js";

// A fake ChildProcess that drives the Codex initialize → model/list handshake.
// When the code under test writes `initialize`/`model/list` to stdin, the fake
// replays the corresponding responses on stdout. Behavior is configurable to
// exercise error/timeout/empty branches.
function makeFakeChild(opts: {
  modelListResult?: unknown;
  onInit?: (child: FakeChild) => void; // override default init handling (e.g. emit error)
  respondToModelList?: boolean; // default true
} = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  const respondToModelList = opts.respondToModelList !== false;

  child.stdin = {
    write: (line: string) => {
      let msg: { method?: string; id?: number };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method === "initialize") {
        if (opts.onInit) { opts.onInit(child); return; }
        // Ack initialize so the code sends initialized + model/list.
        queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 1, result: {} }) + "\n")));
      } else if (msg.method === "model/list" && respondToModelList) {
        const result = opts.modelListResult ?? {
          data: [
            { id: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier", hidden: false, isDefault: true },
            { id: "gpt-5.3-codex", displayName: "gpt-5.3-codex", description: "Codex", hidden: false },
          ],
        };
        queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, result }) + "\n")));
      }
    },
  };
  return child;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stdin: { write: (line: string) => void };
  kill: ReturnType<typeof vi.fn>;
}

// These tests validate the pure parsing of the Codex app-server `model/list`
// RPC payload into the UI's { value, label, description } model-option shape.
// The payload fixtures mirror the real shape emitted by `codex app-server`
// (id/displayName/description/hidden/isDefault), captured from codex 0.142.x.
describe("parseCodexModelList", () => {
  it("maps id/displayName/description and floats the default model first", () => {
    const result = {
      data: [
        { id: "gpt-5.3-codex", displayName: "gpt-5.3-codex", description: "Codex model", hidden: false },
        { id: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier model", hidden: false, isDefault: true },
      ],
    };

    const models = parseCodexModelList(result);

    // gpt-5.5 is the default and must be first so getDefaultModel() picks it.
    expect(models).toEqual([
      { value: "gpt-5.5", label: "GPT-5.5", description: "Frontier model", isDefault: true },
      { value: "gpt-5.3-codex", label: "gpt-5.3-codex", description: "Codex model", isDefault: false },
    ]);
  });

  it("filters out hidden models", () => {
    const result = {
      data: [
        { id: "gpt-5.5", displayName: "GPT-5.5", hidden: false },
        { id: "gpt-5-legacy", displayName: "Legacy", hidden: true },
      ],
    };

    const models = parseCodexModelList(result);

    expect(models.map((m) => m.value)).toEqual(["gpt-5.5"]);
  });

  it("falls back to id for label and empty string for missing description", () => {
    const result = { data: [{ id: "gpt-5.5" }] };

    const models = parseCodexModelList(result);

    expect(models[0]).toEqual({ value: "gpt-5.5", label: "gpt-5.5", description: "", isDefault: false });
  });

  it("uses `model` when `id` is absent", () => {
    const result = { data: [{ model: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" }] };

    const models = parseCodexModelList(result);

    expect(models[0].value).toBe("gpt-5.4-mini");
  });

  it("skips entries without an id or model slug", () => {
    const result = { data: [{ displayName: "Nameless" }, { id: "gpt-5.5" }] };

    const models = parseCodexModelList(result);

    expect(models.map((m) => m.value)).toEqual(["gpt-5.5"]);
  });

  it("returns an empty array for malformed or missing payloads", () => {
    expect(parseCodexModelList(undefined)).toEqual([]);
    expect(parseCodexModelList(null)).toEqual([]);
    expect(parseCodexModelList({})).toEqual([]);
    expect(parseCodexModelList({ data: "not-an-array" })).toEqual([]);
    expect(parseCodexModelList({ data: [null, 42, "x"] })).toEqual([]);
  });
});

describe("fetchCodexModels", () => {
  beforeEach(() => {
    _resetCodexModelsCache();
    mockSpawn.mockReset();
    mockResolveBinary.mockReset().mockReturnValue("/usr/bin/codex");
    mockGetEnrichedPath.mockReset().mockReturnValue("/usr/bin:/bin");
    mockExistsSync.mockReset().mockReturnValue(false);
    mockRealpathSync.mockReset().mockImplementation((p: string) => p);
  });

  it("performs the handshake and returns parsed models", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const models = await fetchCodexModels();

    expect(models.map((m) => m.value)).toEqual(["gpt-5.5", "gpt-5.3-codex"]);
    // Spawns `codex app-server` (bare, no --enable flags).
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("app-server");
    // The short-lived process is cleaned up.
    expect(child.kill).toHaveBeenCalled();
  });

  it("returns [] when the codex binary cannot be resolved", async () => {
    mockResolveBinary.mockReturnValue(null);

    const models = await fetchCodexModels();

    expect(models).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("uses the sibling-node shim when a bundled node exists next to the binary", async () => {
    // existsSync(true) => the binary dir has a sibling `node`; spawn node + script.
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockReturnValue("/usr/lib/codex/codex.js");
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    await fetchCodexModels();

    const cmd = mockSpawn.mock.calls[0][0] as string;
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(cmd).toBe("/usr/bin/node");
    expect(args[0]).toBe("/usr/lib/codex/codex.js");
    expect(args).toContain("app-server");
  });

  it("returns [] and stops when the process emits an error", async () => {
    const child = makeFakeChild({ onInit: (c) => c.emit("error", new Error("spawn failed")) });
    mockSpawn.mockReturnValue(child);

    const models = await fetchCodexModels();

    expect(models).toEqual([]);
  });

  it("returns [] when the process exits before answering model/list", async () => {
    const child = makeFakeChild({ onInit: (c) => c.emit("exit", 1) });
    mockSpawn.mockReturnValue(child);

    const models = await fetchCodexModels();

    expect(models).toEqual([]);
  });

  it("times out and returns [] when the process never responds", async () => {
    // respondToModelList:false and a no-op init => nothing ever comes back.
    const child = makeFakeChild({ onInit: () => { /* swallow init, never reply */ } });
    mockSpawn.mockReturnValue(child);

    const models = await fetchCodexModels({ timeoutMs: 20 });

    expect(models).toEqual([]);
  });

  it("returns [] when spawn itself throws", async () => {
    mockSpawn.mockImplementation(() => { throw new Error("ENOENT"); });

    const models = await fetchCodexModels();

    expect(models).toEqual([]);
  });

  it("caches successful results and does not respawn within the TTL", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const first = await fetchCodexModels();
    const second = await fetchCodexModels();

    expect(first).toEqual(second);
    // Second call served from cache — spawn only happened once.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty results (retries on next call)", async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild({ modelListResult: { data: [] } }));
    const empty = await fetchCodexModels();
    expect(empty).toEqual([]);

    // A subsequent call should spawn again (empty results are not cached).
    mockSpawn.mockReturnValueOnce(makeFakeChild());
    const models = await fetchCodexModels();
    expect(models.map((m) => m.value)).toEqual(["gpt-5.5", "gpt-5.3-codex"]);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
