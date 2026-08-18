import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock usage-limits ─────────────────────────────────────────────────────
vi.mock("../usage-limits.js", () => ({
  getUsageLimits: vi.fn(async () => ({
    five_hour: null,
    seven_day: null,
    extra_usage: null,
  })),
}));

// ─── Mock update-checker ───────────────────────────────────────────────────
vi.mock("../update-checker.js", () => ({
  getUpdateState: vi.fn(() => ({
    currentVersion: "1.0.0",
    latestVersion: null,
    lastChecked: 0,
    isServiceMode: false,
    checking: false,
    updateInProgress: false,
    channel: "stable",
  })),
  checkForUpdate: vi.fn(async () => {}),
  isUpdateAvailable: vi.fn(() => false),
  setUpdateInProgress: vi.fn(),
}));

// ─── Mock service ──────────────────────────────────────────────────────────
vi.mock("../service.js", () => ({
  refreshServiceDefinition: vi.fn(),
}));

// ─── Mock claude-compat checker ────────────────────────────────────────────
// The compat routes gate the post-2.1.121 --sdk-url lockdown workarounds.
// Everything here touches the real Claude binary on disk, so it is mocked
// wholesale — these tests exercise the route logic, never the filesystem.
vi.mock("../claude-compat-checker.js", () => ({
  checkCompat: vi.fn(async () => {}),
  getCompatState: vi.fn(() => ({
    installedVersion: "2.1.130",
    installedPath: "/usr/local/bin/claude",
    isIncompatible: true,
    isPatched: false,
    availableKnownGood: ["2.1.119", "2.1.120"],
    suggestedPinTarget: "2.1.120",
    lastChecked: 0,
    error: null,
  })),
}));

// ─── Mock claude-patcher ───────────────────────────────────────────────────
vi.mock("../claude-patcher.js", () => ({
  pinToVersion: vi.fn(async () => ({ ok: true })),
  patchBinary: vi.fn(async () => ({
    ok: true,
    patchedPath: "/usr/local/bin/claude",
    replacements: 3,
  })),
  unpatch: vi.fn(async () => ({ ok: true, target: "2.1.130" })),
}));

// ─── Mock settings-manager ─────────────────────────────────────────────────
vi.mock("../settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    claudeBridgeMode: "none",
    claudeBridgeIngressUrl: "",
    claudeCompatBannerDismissedVersion: "",
    dockerAutoUpdate: false,
  })),
  updateSettings: vi.fn(),
}));

// ─── Mock cli-ingress-server ───────────────────────────────────────────────
// Starting the real one binds a TLS listener.
vi.mock("../cli-ingress-server.js", () => ({
  startCliIngressServer: vi.fn(async () => ({
    urlPrefix: "wss://[::1]:8443",
    stop: vi.fn(),
  })),
}));

import { Hono } from "hono";
import { getUsageLimits } from "../usage-limits.js";
import {
  getUpdateState,
  checkForUpdate,
  isUpdateAvailable,
  setUpdateInProgress,
} from "../update-checker.js";
import { registerSystemRoutes } from "./system-routes.js";
import { checkCompat, getCompatState } from "../claude-compat-checker.js";
import { pinToVersion, patchBinary, unpatch } from "../claude-patcher.js";
import { getSettings, updateSettings } from "../settings-manager.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a mock CliLauncher with vi.fn() stubs for the methods used by system routes. */
function createMockLauncher() {
  return {
    getSession: vi.fn(() => undefined as any),
    isAlive: vi.fn(() => false),
  };
}

/** Build a mock WsBridge with vi.fn() stubs for the methods used by system routes. */
function createMockWsBridge() {
  return {
    getSession: vi.fn(() => undefined as any),
    getCodexRateLimits: vi.fn(() => null),
    injectUserMessage: vi.fn(),
  };
}

/** Build a mock TerminalManager with vi.fn() stubs for the methods used by system routes. */
function createMockTerminalManager() {
  return {
    getInfo: vi.fn(() => null as { id: string; cwd: string } | null),
    spawn: vi.fn(() => "terminal-123"),
    kill: vi.fn(),
  };
}

// ─── Test setup ────────────────────────────────────────────────────────────

let app: Hono;
let launcher: ReturnType<typeof createMockLauncher>;
let wsBridge: ReturnType<typeof createMockWsBridge>;
let terminalManager: ReturnType<typeof createMockTerminalManager>;

/** Default compat state: an incompatible CLI with a known-good pin target. */
function defaultCompatState() {
  return {
    installedVersion: "2.1.130",
    installedPath: "/usr/local/bin/claude",
    isIncompatible: true,
    isPatched: false,
    availableKnownGood: ["2.1.119", "2.1.120"],
    suggestedPinTarget: "2.1.120",
    lastChecked: 0,
    error: null,
  };
}

beforeEach(() => {
  // clearAllMocks() resets call history but NOT implementations, so a
  // mockReturnValue set inside one test leaks into every later one. Restoring
  // the defaults here keeps the suite order-independent.
  vi.clearAllMocks();
  vi.mocked(getCompatState).mockReturnValue(defaultCompatState() as any);
  vi.mocked(pinToVersion).mockResolvedValue({ ok: true } as any);
  vi.mocked(patchBinary).mockResolvedValue({
    ok: true,
    patchedPath: "/usr/local/bin/claude",
    replacements: 3,
  } as any);
  vi.mocked(unpatch).mockResolvedValue({ ok: true, target: "2.1.130" } as any);
  vi.mocked(getSettings).mockReturnValue({
    claudeBridgeMode: "none",
    claudeBridgeIngressUrl: "",
    claudeCompatBannerDismissedVersion: "",
    dockerAutoUpdate: false,
  } as any);

  launcher = createMockLauncher();
  wsBridge = createMockWsBridge();
  terminalManager = createMockTerminalManager();

  app = new Hono();
  const api = new Hono();
  registerSystemRoutes(api, {
    launcher: launcher as any,
    wsBridge: wsBridge as any,
    terminalManager: terminalManager as any,
    updateCheckStaleMs: 60_000,
  });
  app.route("/api", api);
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/usage-limits
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/usage-limits", () => {
  it("returns usage limits from the global getter", async () => {
    const limits = {
      five_hour: { utilization: 0.5, resets_at: "2026-01-01T00:00:00Z" },
      seven_day: null,
      extra_usage: null,
    };
    vi.mocked(getUsageLimits).mockResolvedValue(limits as any);

    const res = await app.request("/api/usage-limits");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour.utilization).toBe(0.5);
    expect(json.seven_day).toBeNull();
    expect(getUsageLimits).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sessions/:id/usage-limits
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/sessions/:id/usage-limits", () => {
  it("returns codex rate limits when the session is a codex backend", async () => {
    // When the session's backendType is "codex", we should return mapped codex limits
    wsBridge.getSession.mockReturnValue({ backendType: "codex" } as any);
    wsBridge.getCodexRateLimits.mockReturnValue({
      primary: { usedPercent: 0.42, windowDurationMins: 300, resetsAt: 1700000000 },
      secondary: null,
    } as any);

    const res = await app.request("/api/sessions/codex-sess-1/usage-limits");

    expect(res.status).toBe(200);
    const json = await res.json();
    // Primary limit should be mapped to five_hour
    expect(json.five_hour).not.toBeNull();
    expect(json.five_hour.utilization).toBe(0.42);
    // Secondary was null, so seven_day should be null
    expect(json.seven_day).toBeNull();
    expect(json.extra_usage).toBeNull();
    // Should NOT have called getUsageLimits (we used codex-specific path)
    expect(getUsageLimits).not.toHaveBeenCalled();
  });

  it("returns empty limits when codex session has no rate limit data", async () => {
    wsBridge.getSession.mockReturnValue({ backendType: "codex" } as any);
    wsBridge.getCodexRateLimits.mockReturnValue(null);

    const res = await app.request("/api/sessions/codex-sess-2/usage-limits");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ five_hour: null, seven_day: null, extra_usage: null });
  });

  // When codex rate limits have timestamps in epoch milliseconds (>1e12),
  // they should pass through without conversion.
  it("passes through millisecond timestamps from codex rate limits", async () => {
    wsBridge.getSession.mockReturnValue({ backendType: "codex" } as any);
    const msTimestamp = 1700000000000; // already in ms
    wsBridge.getCodexRateLimits.mockReturnValue({
      primary: { usedPercent: 0.8, windowDurationMins: 300, resetsAt: msTimestamp },
      secondary: { usedPercent: 0.3, windowDurationMins: 10080, resetsAt: msTimestamp },
    } as any);

    const res = await app.request("/api/sessions/codex-ms/usage-limits");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour.utilization).toBe(0.8);
    expect(json.five_hour.resets_at).toBe(new Date(msTimestamp).toISOString());
    expect(json.seven_day.utilization).toBe(0.3);
    expect(json.seven_day.resets_at).toBe(new Date(msTimestamp).toISOString());
  });

  it("falls back to global usage limits for non-codex sessions", async () => {
    // A claude-type session should use the global getUsageLimits
    wsBridge.getSession.mockReturnValue({ backendType: "claude" } as any);
    vi.mocked(getUsageLimits).mockResolvedValue({
      five_hour: { utilization: 0.1, resets_at: null },
      seven_day: null,
      extra_usage: null,
    } as any);

    const res = await app.request("/api/sessions/claude-sess-1/usage-limits");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour.utilization).toBe(0.1);
    expect(getUsageLimits).toHaveBeenCalled();
  });

  it("falls back to global usage limits when session is not found", async () => {
    // When wsBridge.getSession returns undefined, should still return global limits
    wsBridge.getSession.mockReturnValue(undefined);
    vi.mocked(getUsageLimits).mockResolvedValue({
      five_hour: null,
      seven_day: null,
      extra_usage: null,
    } as any);

    const res = await app.request("/api/sessions/unknown/usage-limits");

    expect(res.status).toBe(200);
    expect(getUsageLimits).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/update-check
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/update-check", () => {
  it("calls checkForUpdate when lastChecked is 0 (stale)", async () => {
    // lastChecked=0 means never checked, so it should trigger a refresh
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: null,
      lastChecked: 0,
      isServiceMode: false,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(false);

    const res = await app.request("/api/update-check");

    expect(res.status).toBe(200);
    expect(checkForUpdate).toHaveBeenCalled();
    const json = await res.json();
    expect(json.currentVersion).toBe("1.0.0");
    expect(json.updateAvailable).toBe(false);
    expect(json.channel).toBe("stable");
  });

  it("does NOT call checkForUpdate when lastChecked is recent (not stale)", async () => {
    // Set lastChecked to "now" so it is within the 60s stale window
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      lastChecked: Date.now(),
      isServiceMode: false,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(false);

    const res = await app.request("/api/update-check");

    expect(res.status).toBe(200);
    expect(checkForUpdate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/update-check
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/update-check", () => {
  it("always calls checkForUpdate regardless of staleness", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      lastChecked: Date.now(),
      isServiceMode: true,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(true);

    const res = await app.request("/api/update-check", { method: "POST" });

    expect(res.status).toBe(200);
    expect(checkForUpdate).toHaveBeenCalled();
    const json = await res.json();
    expect(json.updateAvailable).toBe(true);
    expect(json.isServiceMode).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/update
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/update", () => {
  it("returns 400 when not running in service mode", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      lastChecked: Date.now(),
      isServiceMode: false,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });

    const res = await app.request("/api/update", { method: "POST" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/service mode/i);
  });

  it("returns 400 when no update is available", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      lastChecked: Date.now(),
      isServiceMode: true,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(false);

    const res = await app.request("/api/update", { method: "POST" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no update/i);
  });

  it("returns 409 when an update is already in progress", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      lastChecked: Date.now(),
      isServiceMode: true,
      checking: false,
      updateInProgress: true,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(true);

    const res = await app.request("/api/update", { method: "POST" });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already in progress/i);
  });

  it("starts the update when all preconditions are met", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      lastChecked: Date.now(),
      isServiceMode: true,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(true);

    const res = await app.request("/api/update", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toMatch(/restart/i);
    expect(setUpdateInProgress).toHaveBeenCalledWith(true);
  });

  // Exercises the async setTimeout callback inside the update handler.
  // Mocks Bun.spawn to simulate a successful install + restart.
  it("runs the install and restart flow inside the deferred callback", async () => {
    vi.useFakeTimers();

    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      lastChecked: Date.now(),
      isServiceMode: true,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(true);

    // Mock Bun.spawn for the install command
    const mockSpawn = vi.fn()
      .mockReturnValueOnce({
        exited: Promise.resolve(0),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
      })
      // Second call is the restart command
      .mockReturnValueOnce({
        exited: Promise.resolve(0),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
      });
    // @ts-expect-error -- Bun global mock
    globalThis.Bun = { spawn: mockSpawn };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(200);

    // Advance past the 100ms setTimeout that starts the install
    await vi.advanceTimersByTimeAsync(150);

    // The install spawn should have been called
    expect(mockSpawn).toHaveBeenCalledWith(
      ["bun", "install", "-g", "@hellcoder/companion@2.0.0"],
      expect.anything(),
    );

    // Advance past the 500ms exit timeout
    await vi.advanceTimersByTimeAsync(600);

    vi.useRealTimers();
    exitSpy.mockRestore();
    // @ts-expect-error -- cleanup Bun global mock
    delete globalThis.Bun;
  });

  // When the install command fails, setUpdateInProgress should be reset.
  it("resets updateInProgress when install fails", async () => {
    vi.useFakeTimers();

    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      lastChecked: Date.now(),
      isServiceMode: true,
      checking: false,
      updateInProgress: false,
      channel: "stable",
    });
    vi.mocked(isUpdateAvailable).mockReturnValue(true);

    const stderrStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("install error"));
        controller.close();
      },
    });
    const mockSpawn = vi.fn().mockReturnValueOnce({
      exited: Promise.resolve(1),
      stdout: new ReadableStream(),
      stderr: stderrStream,
    });
    // @ts-expect-error -- Bun global mock
    globalThis.Bun = { spawn: mockSpawn };

    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(200);

    await vi.advanceTimersByTimeAsync(150);

    // After failed install, setUpdateInProgress should be called with false
    expect(setUpdateInProgress).toHaveBeenCalledWith(false);

    vi.useRealTimers();
    // @ts-expect-error -- cleanup Bun global mock
    delete globalThis.Bun;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/terminal
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/terminal", () => {
  it("returns active: false when no terminal is running", async () => {
    terminalManager.getInfo.mockReturnValue(null);

    const res = await app.request("/api/terminal");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.active).toBe(false);
  });

  it("returns terminal info when a terminal is running", async () => {
    terminalManager.getInfo.mockReturnValue({ id: "t-42", cwd: "/home/user" });

    const res = await app.request("/api/terminal");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.active).toBe(true);
    expect(json.terminalId).toBe("t-42");
    expect(json.cwd).toBe("/home/user");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/terminal/spawn
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/terminal/spawn", () => {
  it("spawns a terminal and returns its id", async () => {
    terminalManager.spawn.mockReturnValue("new-terminal-id");

    const res = await app.request("/api/terminal/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.terminalId).toBe("new-terminal-id");
    expect(terminalManager.spawn).toHaveBeenCalledWith(
      "/workspace",
      undefined,
      undefined,
      expect.objectContaining({}),
    );
  });

  it("returns 400 when cwd is missing", async () => {
    const res = await app.request("/api/terminal/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/cwd/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/terminal/kill
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/terminal/kill", () => {
  it("kills the specified terminal", async () => {
    const res = await app.request("/api/terminal/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminalId: "t-42" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(terminalManager.kill).toHaveBeenCalledWith("t-42");
  });

  it("returns 400 when terminalId is missing", async () => {
    const res = await app.request("/api/terminal/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/terminalId/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/:id/message
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/sessions/:id/message", () => {
  it("injects a user message into a running session", async () => {
    launcher.getSession.mockReturnValue({ id: "sess-1" } as any);
    launcher.isAlive.mockReturnValue(true);

    const res = await app.request("/api/sessions/sess-1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello world" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.sessionId).toBe("sess-1");
    expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("sess-1", "hello world");
  });

  it("returns 404 when the session does not exist", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/missing/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it("returns 400 when the session is not running", async () => {
    launcher.getSession.mockReturnValue({ id: "sess-1" } as any);
    launcher.isAlive.mockReturnValue(false);

    const res = await app.request("/api/sessions/sess-1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/not running/i);
  });

  it("returns 400 when content is missing or empty", async () => {
    launcher.getSession.mockReturnValue({ id: "sess-1" } as any);
    launcher.isAlive.mockReturnValue(true);

    // Empty content field
    const res1 = await app.request("/api/sessions/sess-1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "   " }),
    });
    expect(res1.status).toBe(400);
    const json1 = await res1.json();
    expect(json1.error).toMatch(/content/i);

    // Missing content field entirely
    const res2 = await app.request("/api/sessions/sess-1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(400);
    const json2 = await res2.json();
    expect(json2.error).toMatch(/content/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/system/memory  and  GET /api/system/disk
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/system/memory", () => {
  it("returns a memory snapshot including swap fields", async () => {
    const res = await app.request("/api/system/memory");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.total_bytes).toBeGreaterThan(0);
    expect(json.used_bytes).toBeLessThanOrEqual(json.total_bytes);
    // Swap must always be present, even on a host with none configured —
    // the UI keys off swap_total_bytes === 0 to hide the meter.
    expect(typeof json.swap_total_bytes).toBe("number");
    expect(typeof json.swap_used_bytes).toBe("number");
    expect(typeof json.swap_used_percent).toBe("number");
  });
});

describe("GET /api/system/disk", () => {
  it("returns a disk snapshot for the Companion data volume", async () => {
    const res = await app.request("/api/system/disk");
    expect(res.status).toBe(200);
    const json = await res.json();

    // getSystemDisk returns null when statfs is unavailable; the route passes
    // that through as JSON null rather than an empty 204 body.
    if (json === null) return;

    expect(json.total_bytes).toBeGreaterThan(0);
    expect(json.used_bytes).toBe(json.total_bytes - json.available_bytes);
    expect(json.used_percent).toBeGreaterThanOrEqual(0);
    expect(json.used_percent).toBeLessThanOrEqual(100);
    expect(typeof json.path).toBe("string");
  });

  it("always responds 200 with a JSON body, never an empty 204", async () => {
    // The browser client calls res.json() unconditionally — an empty body
    // would throw and log a spurious API failure on every poll.
    const res = await app.request("/api/system/disk");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/update — guard branches only
// ═══════════════════════════════════════════════════════════════════════════

// The success path spawns `bun install -g` and calls process.exit(), so these
// tests deliberately cover only the three refusal branches.
describe("POST /api/update (guards)", () => {
  it("returns 400 when not running as a service", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0", latestVersion: "1.1.0", lastChecked: 0,
      isServiceMode: false, checking: false, updateInProgress: false, channel: "stable",
    } as any);

    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/service mode/i);
    expect(setUpdateInProgress).not.toHaveBeenCalled();
  });

  it("returns 400 when no update is available", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0", latestVersion: "1.0.0", lastChecked: 0,
      isServiceMode: true, checking: false, updateInProgress: false, channel: "stable",
    } as any);
    vi.mocked(isUpdateAvailable).mockReturnValue(false);

    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no update/i);
  });

  it("returns 409 when an update is already in progress", async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      currentVersion: "1.0.0", latestVersion: "1.1.0", lastChecked: 0,
      isServiceMode: true, checking: false, updateInProgress: true, channel: "stable",
    } as any);
    vi.mocked(isUpdateAvailable).mockReturnValue(true);

    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already in progress/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Terminal routes
// ═══════════════════════════════════════════════════════════════════════════

describe("terminal routes", () => {
  it("GET /api/terminal reports inactive when no terminal exists", async () => {
    terminalManager.getInfo.mockReturnValue(null);
    const res = await app.request("/api/terminal");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });

  it("GET /api/terminal returns the terminal id and cwd when active", async () => {
    terminalManager.getInfo.mockReturnValue({ id: "t-1", cwd: "/repo" });
    const res = await app.request("/api/terminal?terminalId=t-1");
    expect(await res.json()).toEqual({ active: true, terminalId: "t-1", cwd: "/repo" });
    expect(terminalManager.getInfo).toHaveBeenCalledWith("t-1");
  });

  it("POST /api/terminal/spawn requires a cwd", async () => {
    const res = await app.request("/api/terminal/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cwd/i);
    expect(terminalManager.spawn).not.toHaveBeenCalled();
  });

  it("POST /api/terminal/spawn passes dimensions and container through", async () => {
    const res = await app.request("/api/terminal/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", cols: 120, rows: 40, containerId: "c-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ terminalId: "terminal-123" });
    expect(terminalManager.spawn).toHaveBeenCalledWith("/repo", 120, 40, { containerId: "c-1" });
  });

  it("POST /api/terminal/kill requires a terminalId", async () => {
    // Covers both a missing body and a whitespace-only id.
    const res1 = await app.request("/api/terminal/kill", { method: "POST" });
    expect(res1.status).toBe(400);

    const res2 = await app.request("/api/terminal/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminalId: "  " }),
    });
    expect(res2.status).toBe(400);
    expect(terminalManager.kill).not.toHaveBeenCalled();
  });

  it("POST /api/terminal/kill kills the named terminal", async () => {
    const res = await app.request("/api/terminal/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminalId: "t-1" }),
    });
    expect(res.status).toBe(200);
    expect(terminalManager.kill).toHaveBeenCalledWith("t-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Claude compatibility routes (--sdk-url lockdown workarounds)
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/claude-compat", () => {
  it("refreshes when the cached state is stale, then returns the payload", async () => {
    // lastChecked === 0 means "never checked" — must trigger a refresh.
    const res = await app.request("/api/claude-compat");
    expect(res.status).toBe(200);
    expect(checkCompat).toHaveBeenCalled();

    const json = await res.json();
    expect(json.installedVersion).toBe("2.1.130");
    expect(json.isIncompatible).toBe(true);
    expect(json.suggestedPinTarget).toBe("2.1.120");
    // Settings-derived fields are merged into the same payload.
    expect(json.bridgeMode).toBe("none");
    expect(json.bannerDismissedVersion).toBe("");
  });

  it("skips the refresh when the cached state is fresh", async () => {
    vi.mocked(getCompatState).mockReturnValue({
      installedVersion: "2.1.130", installedPath: "/usr/local/bin/claude",
      isIncompatible: false, isPatched: false, availableKnownGood: [],
      suggestedPinTarget: "", lastChecked: Date.now(), error: null,
    } as any);

    await app.request("/api/claude-compat");
    expect(checkCompat).not.toHaveBeenCalled();
  });
});

describe("POST /api/claude-compat/refresh", () => {
  it("always re-checks and returns the fresh payload", async () => {
    const res = await app.request("/api/claude-compat/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    expect(checkCompat).toHaveBeenCalled();
    expect((await res.json()).installedVersion).toBe("2.1.130");
  });
});

describe("POST /api/claude-compat/pin", () => {
  it("pins to the suggested target and disables patched bridge mode", async () => {
    const res = await app.request("/api/claude-compat/pin", { method: "POST" });
    expect(res.status).toBe(200);
    expect(pinToVersion).toHaveBeenCalledWith("2.1.120");

    // Pinning returns to a non-validator binary, so the bridge must be turned
    // off — otherwise the CLI keeps being pointed at wss://[::1].
    expect(updateSettings).toHaveBeenCalledWith({
      claudeBridgeMode: "none",
      claudeBridgeIngressUrl: "",
    });
    expect((await res.json()).pinnedTo).toBe("2.1.120");
  });

  it("honours an explicit version from the body", async () => {
    await app.request("/api/claude-compat/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "2.1.119" }),
    });
    expect(pinToVersion).toHaveBeenCalledWith("2.1.119");
  });

  it("returns 400 when no known-good version is available to pin to", async () => {
    vi.mocked(getCompatState).mockReturnValue({
      installedVersion: "2.1.130", installedPath: "/usr/local/bin/claude",
      isIncompatible: true, isPatched: false, availableKnownGood: [],
      suggestedPinTarget: "", lastChecked: 0, error: null,
    } as any);

    const res = await app.request("/api/claude-compat/pin", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/known-good/i);
    expect(pinToVersion).not.toHaveBeenCalled();
  });

  it("surfaces a pin failure as 400", async () => {
    vi.mocked(pinToVersion).mockResolvedValue({ ok: false, error: "download failed" } as any);
    const res = await app.request("/api/claude-compat/pin", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("download failed");
  });
});

describe("POST /api/claude-compat/patch", () => {
  it("patches the binary, starts the ingress listener and persists the URL", async () => {
    const res = await app.request("/api/claude-compat/patch", { method: "POST" });
    expect(res.status).toBe(200);
    expect(patchBinary).toHaveBeenCalled();

    const json = await res.json();
    expect(json.replacements).toBe(3);
    expect(updateSettings).toHaveBeenCalledWith({
      claudeBridgeMode: "patched",
      claudeBridgeIngressUrl: "wss://[::1]:8443",
    });
  });

  it("returns 400 when the binary cannot be patched", async () => {
    vi.mocked(patchBinary).mockResolvedValue({ ok: false, error: "unknown layout" } as any);
    const res = await app.request("/api/claude-compat/patch", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown layout");
  });
});

describe("POST /api/claude-compat/unpatch", () => {
  it("restores the binary and clears bridge settings", async () => {
    const res = await app.request("/api/claude-compat/unpatch", { method: "POST" });
    expect(res.status).toBe(200);
    expect(unpatch).toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({
      claudeBridgeMode: "none",
      claudeBridgeIngressUrl: "",
    });
    expect((await res.json()).target).toBe("2.1.130");
  });

  it("returns 400 when unpatching fails", async () => {
    vi.mocked(unpatch).mockResolvedValue({ ok: false, error: "no backup" } as any);
    const res = await app.request("/api/claude-compat/unpatch", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no backup");
  });
});

describe("POST /api/claude-compat/dismiss-banner", () => {
  it("records the explicitly supplied version", async () => {
    const res = await app.request("/api/claude-compat/dismiss-banner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "2.1.131" }),
    });
    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      claudeCompatBannerDismissedVersion: "2.1.131",
    });
  });

  it("falls back to the currently installed version", async () => {
    const res = await app.request("/api/claude-compat/dismiss-banner", { method: "POST" });
    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      claudeCompatBannerDismissedVersion: "2.1.130",
    });
  });

  it("returns 400 when there is no version to record", async () => {
    vi.mocked(getCompatState).mockReturnValue({
      installedVersion: null, installedPath: null, isIncompatible: false,
      isPatched: false, availableKnownGood: [], suggestedPinTarget: "",
      lastChecked: 0, error: null,
    } as any);

    const res = await app.request("/api/claude-compat/dismiss-banner", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/version/i);
  });
});
