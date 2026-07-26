import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  captureProcState,
  isProcAvailable,
  getDescendants,
  hasLiveDescendants,
} from "./proc-diagnostics.js";

/**
 * These tests cover the diagnostic that runs on the wedge-kill recovery path in
 * claude-adapter.ts. The overriding requirement is that it NEVER throws — it
 * executes immediately before a SIGTERM that unblocks a stuck session, so a
 * diagnostic that raises would turn a recoverable wedge into a dead session.
 *
 * CI runs on both ubuntu-latest and macos-latest, and macOS has no /proc at
 * all, so every test here must pass on a platform where the feature is inert.
 */

const isLinux = process.platform === "linux";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isProcAvailable", () => {
  // /proc is a Linux-only filesystem; on macOS the whole capture must no-op.
  it("reports availability based on platform", () => {
    expect(isProcAvailable()).toBe(process.platform === "linux");
  });
});

describe("captureProcState", () => {
  it("returns no_pid when the pid is undefined", () => {
    // Bun's Subprocess.pid is optional, so undefined is reachable in practice.
    expect(captureProcState(undefined)).toEqual({ error: "no_pid" });
  });

  it("never throws for a pid that does not exist", () => {
    // The common race: the process exits between the liveness check and the
    // capture. This must degrade to a marker, not an exception.
    const snapshot = captureProcState(2_147_483_646);
    expect(() => snapshot).not.toThrow();
    if (isLinux) {
      expect(snapshot.error).toBe("process_gone_or_unreadable");
    }
  });

  it("degrades cleanly on platforms without /proc", () => {
    // Simulate macOS regardless of the host we are running on, so this
    // assertion is meaningful in both CI matrix legs.
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(captureProcState(1)).toEqual({ error: "unsupported_platform:darwin" });
  });

  it.runIf(isLinux)("captures live kernel state for the current process", () => {
    // Uses our own pid, which is guaranteed to exist and be readable. This is
    // the field set the wedge investigation actually needs: `state` and `wchan`
    // together distinguish a process blocked on a full pipe from one parked in
    // a futex or spinning in userspace.
    const snapshot = captureProcState(process.pid);

    expect(snapshot.error).toBeUndefined();
    // e.g. "R (running)" or "S (sleeping)" — always parenthesised on Linux.
    expect(snapshot.state).toMatch(/^[A-Z] \(/);
    expect(snapshot.threads).toBeGreaterThan(0);
    expect(snapshot.fdCount).toBeGreaterThan(0);
    // VmRSS is reported in kB by /proc; absent only for kernel threads.
    expect(snapshot.vmRSS).toMatch(/kB$/);
  });

  it.runIf(isLinux)("returns a plain object safe to embed in a log payload", () => {
    // The snapshot is passed straight into log.warn, which JSON-serialises it.
    const snapshot = captureProcState(process.pid);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(JSON.stringify(snapshot)).toContain("state");
  });
});

/**
 * Descendant detection is what replaced `lastInboundWasResult` as the grace
 * discriminator in claude-adapter. Its correctness decides whether a CLI that
 * is mid-teardown gets the generous grace or gets SIGTERMed at 2s — the latter
 * being the bug that killed users' turns.
 */
describe("getDescendants / hasLiveDescendants", () => {
  it("returns empty for undefined pid without throwing", () => {
    expect(getDescendants(undefined)).toEqual([]);
    expect(hasLiveDescendants(undefined)).toBe(false);
  });

  it("returns empty on platforms without /proc", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(getDescendants(1)).toEqual([]);
    expect(hasLiveDescendants(1)).toBe(false);
  });

  it("returns empty for a pid that does not exist", () => {
    expect(getDescendants(2_147_483_646)).toEqual([]);
    expect(hasLiveDescendants(2_147_483_646)).toBe(false);
  });

  it.runIf(isLinux)("detects a live child and reports it gone after exit", async () => {
    // Mirrors the real shape: a parent holding a child that has not yet reaped.
    // `sleep` stands in for an MCP stdio server still shutting down.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 150)); // let the fork land in /proc

    expect(hasLiveDescendants(process.pid)).toBe(true);
    const descendants = getDescendants(process.pid);
    const found = descendants.find((d) => d.pid === child.pid);
    expect(found).toBeDefined();
    expect(found?.comm).toBe("sleep");
    // A running-but-idle child reports S (sleeping), not Z (reaped).
    expect(found?.state).toBe("S");

    // After the child exits and is reaped, it must no longer count — otherwise
    // a genuinely wedged process would be granted the long grace forever.
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    await new Promise((r) => setTimeout(r, 150));

    expect(getDescendants(process.pid).some((d) => d.pid === child.pid)).toBe(false);
  });

  it.runIf(isLinux)("bounds the walk so a large tree cannot stall the kill path", () => {
    // maxNodes is a safety bound: this runs immediately before a kill that
    // unblocks a stuck session, so it must terminate regardless of tree size.
    expect(getDescendants(1, 2).length).toBeLessThanOrEqual(2);
  });

  it.runIf(isLinux)("includes descendants in the captured snapshot", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 150));

    const snapshot = captureProcState(process.pid);
    expect(snapshot.descendants?.some((d) => d.pid === child.pid)).toBe(true);
    expect(() => JSON.stringify(snapshot)).not.toThrow();

    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
  });
});
