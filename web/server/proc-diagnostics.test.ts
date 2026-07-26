import { describe, it, expect, vi, afterEach } from "vitest";
import { captureProcState, isProcAvailable } from "./proc-diagnostics.js";

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
