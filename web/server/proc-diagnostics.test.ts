import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  captureProcState,
  isProcAvailable,
  getDescendants,
  hasLiveDescendants,
  countDescendants,
  findOrphanedMcpProcesses,
  stdoutFdOpen,
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

  /**
   * countDescendants drives the adaptive teardown wait in claude-adapter: a
   * falling count means teardown is progressing and the process must NOT be
   * killed, however long it takes. A count that stops falling is what ends the
   * wait. So the critical property is that the count actually tracks reality.
   */
  it("countDescendants returns 0 for undefined pid and non-Linux", () => {
    expect(countDescendants(undefined)).toBe(0);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(countDescendants(1)).toBe(0);
  });

  it.runIf(isLinux)("countDescendants drops as children exit", async () => {
    // This is the exact signal the adaptive wait keys on. If the count did not
    // fall as children are reaped, a healthy teardown would look like a stall
    // and get killed — the bug this replaces.
    const a = spawn("sleep", ["30"], { stdio: "ignore" });
    const b = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 150));

    const withBoth = countDescendants(process.pid);
    expect(withBoth).toBeGreaterThanOrEqual(2);

    a.kill("SIGKILL");
    await new Promise((r) => a.on("exit", r));
    await new Promise((r) => setTimeout(r, 150));

    const withOne = countDescendants(process.pid);
    expect(withOne).toBeLessThan(withBoth);

    b.kill("SIGKILL");
    await new Promise((r) => b.on("exit", r));
    await new Promise((r) => setTimeout(r, 150));

    expect(countDescendants(process.pid)).toBeLessThan(withOne);
  });

  it.runIf(isLinux)("countDescendants stays steady while a child keeps running", async () => {
    // The case that broke the drop-based test. A background tool call (bash ->
    // gh -> tail in the captured kill) holds a *steady* descendant count for as
    // long as it runs — it never falls, because nothing is being reaped. Any
    // logic keyed on a falling count reads this as a stall and kills a process
    // that is actively working. awaitTeardown therefore treats count > 0 as
    // busy, so this steady-state must be observable as non-zero over time.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 150));

    const first = countDescendants(process.pid);
    expect(first).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 400));
    const second = countDescendants(process.pid);
    // Still alive, still counted, and not decreasing — the signal that a
    // drop-based test would misread.
    expect(second).toBeGreaterThan(0);
    expect(second).toBeGreaterThanOrEqual(first);

    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
  });

  it.runIf(isLinux)("countDescendants is bounded by maxNodes", () => {
    // Bounds the poll-loop cost: this runs every 500ms during teardown.
    expect(countDescendants(1, 3)).toBeLessThanOrEqual(3);
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

/**
 * Orphaned-MCP detection. This drives a sweeper that SIGTERMs whatever it
 * returns, so both directions matter: missing an orphan leaks memory (a
 * production host reached 123 orphans across 11.9 GB), but a false positive
 * kills a live MCP server out from under a working session.
 */
describe("findOrphanedMcpProcesses", () => {
  const spawned: ReturnType<typeof spawn>[] = [];

  afterEach(async () => {
    for (const p of spawned.splice(0)) {
      try {
        p.kill("SIGKILL");
        await new Promise((r) => p.on("exit", r));
      } catch {
        // Already gone.
      }
    }
  });

  it("returns empty on platforms without /proc", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(findOrphanedMcpProcesses()).toEqual([]);
  });

  it.runIf(isLinux)("never throws and returns a well-formed list", () => {
    // Runs against the real /proc of whatever host this is, so it must tolerate
    // processes exiting mid-scan — the scan races every other process on the box.
    const orphans = findOrphanedMcpProcesses();
    expect(Array.isArray(orphans)).toBe(true);
    for (const o of orphans) {
      expect(typeof o.pid).toBe("number");
      expect(o.pid).toBeGreaterThan(0);
    }
  });

  it.runIf(isLinux)("detects a process whose cmdline marks it an MCP server with no CLI parent", async () => {
    // `exec -a` sets argv[0], reproducing the cmdline shape of a CLI-spawned
    // stdio MCP server. Its parent here is the test runner, not a `claude`
    // process, so it is exactly the orphan the sweeper targets.
    const child = spawn("/bin/bash", [
      "-c",
      "exec -a 'npm exec @modelcontextprotocol/server-test' sleep 30",
    ], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 300));

    const orphans = findOrphanedMcpProcesses();
    expect(orphans.some((o) => o.pid === child.pid)).toBe(true);
  });

  it.runIf(isLinux)("ignores processes with no MCP marker in their cmdline", async () => {
    // The false-positive guard: an ordinary child must never be swept, or the
    // sweeper would kill unrelated processes on the host.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 300));

    const orphans = findOrphanedMcpProcesses();
    expect(orphans.some((o) => o.pid === child.pid)).toBe(false);
  });

  it.runIf(isLinux)("labels findings with comm where readable", async () => {
    const child = spawn("/bin/bash", [
      "-c",
      "exec -a 'mcp-server-label-test' sleep 30",
    ], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 300));

    const found = findOrphanedMcpProcesses().find((o) => o.pid === child.pid);
    expect(found).toBeDefined();
    // comm is the executable name (truncated to 15 chars by the kernel), not
    // argv[0] — it is a label for the log line, not the match key.
    expect(typeof found?.comm).toBe("string");
  });
});

describe("stdoutFdOpen", () => {
  const spawned: ReturnType<typeof spawn>[] = [];

  afterEach(() => {
    for (const p of spawned.splice(0)) {
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  // This probe decides how a mid-stream stdout EOF is attributed: a pipe only
  // EOFs at the read end when every write end has closed, so "our reader saw
  // EOF but fd 1 is still open" proves a reader-side (server) stream failure
  // rather than a CLI wedge. Production sampling showed every wedge-kill
  // victim healthy — this is the field that finally distinguishes the cases.
  it.runIf(isLinux)("returns true for a live process holding stdout open", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 100));
    expect(stdoutFdOpen(child.pid)).toBe(true);
  });

  it.runIf(isLinux)("returns false when the process closed its own stdout", async () => {
    // exec 1>&- closes fd 1 in the shell itself, then keeps the process alive.
    const child = spawn("/bin/bash", ["-c", "exec 1>&-; sleep 30"], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 300));
    expect(stdoutFdOpen(child.pid)).toBe(false);
  });

  it.runIf(isLinux)("returns false for an exited process", async () => {
    const child = spawn("true", [], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 300));
    expect(stdoutFdOpen(child.pid)).toBe(false);
  });

  it("returns null for a missing pid and never throws", () => {
    expect(stdoutFdOpen(undefined)).toBeNull();
    expect(stdoutFdOpen(null)).toBeNull();
    expect(stdoutFdOpen(0)).toBeNull();
  });
});
