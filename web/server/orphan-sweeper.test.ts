import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFindOrphans = vi.hoisted(() =>
  vi.fn((): { pid: number; comm?: string }[] => []),
);
vi.mock("./proc-diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proc-diagnostics.js")>()),
  findOrphanedMcpProcesses: mockFindOrphans,
}));

import {
  sweepOrphanedMcpProcesses,
  startOrphanSweeper,
  stopOrphanSweeper,
} from "./orphan-sweeper.js";

/**
 * Orphans left behind when companion itself dies. Per-kill reaping cannot cover
 * this: the CLIs and their MCP children are all orphaned at once and nothing
 * remains holding the reference needed to clean them up.
 */
describe("sweepOrphanedMcpProcesses", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let signalled: { pid: number; sig: unknown }[];

  beforeEach(() => {
    signalled = [];
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: unknown) => {
      if (sig === 0) return true;
      signalled.push({ pid, sig });
      return true;
    }) as unknown as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    mockFindOrphans.mockReturnValue([]);
    vi.useRealTimers();
  });

  it("terminates every orphaned MCP server it finds", () => {
    mockFindOrphans.mockReturnValue([
      { pid: 501, comm: "npm exec" },
      { pid: 502, comm: "chrome" },
    ]);

    expect(sweepOrphanedMcpProcesses()).toBe(2);
    expect(signalled).toEqual([
      { pid: 501, sig: "SIGTERM" },
      { pid: 502, sig: "SIGTERM" },
    ]);
  });

  it("escalates to SIGKILL for processes that ignore SIGTERM", () => {
    vi.useFakeTimers();
    mockFindOrphans.mockReturnValue([{ pid: 503 }]);

    sweepOrphanedMcpProcesses();
    expect(signalled).toEqual([{ pid: 503, sig: "SIGTERM" }]);

    vi.advanceTimersByTime(5100);
    expect(signalled).toContainEqual({ pid: 503, sig: "SIGKILL" });
  });

  it("is a no-op when nothing is orphaned", () => {
    mockFindOrphans.mockReturnValue([]);

    expect(sweepOrphanedMcpProcesses()).toBe(0);
    expect(signalled).toEqual([]);
  });

  it("never throws when the scan fails, so startup is not blocked", () => {
    mockFindOrphans.mockImplementation(() => {
      throw new Error("/proc unreadable");
    });

    expect(() => sweepOrphanedMcpProcesses()).not.toThrow();
    expect(sweepOrphanedMcpProcesses()).toBe(0);
  });

  it("tolerates a process that exits between the scan and the signal", () => {
    killSpy.mockImplementation(((pid: number, sig?: unknown) => {
      if (sig === "SIGTERM" && pid === 504) throw new Error("ESRCH");
      if (sig === 0) return true;
      signalled.push({ pid, sig });
      return true;
    }) as unknown as typeof process.kill);
    mockFindOrphans.mockReturnValue([{ pid: 504 }, { pid: 505 }]);

    expect(sweepOrphanedMcpProcesses()).toBe(1);
    expect(signalled).toEqual([{ pid: 505, sig: "SIGTERM" }]);
  });
});

/**
 * The periodic schedule. A startup-only sweep leaves a gap: a CLI the kernel
 * OOM-kills mid-run orphans its MCP children with nobody to reap them, and they
 * then accumulate for the rest of the server's uptime — which is how a
 * production box reached 123 orphans across 11.9 GB inside a single run.
 */
describe("startOrphanSweeper", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let signalled: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    signalled = [];
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: unknown) => {
      if (sig === 0) return true;
      if (sig === "SIGTERM") signalled.push(pid);
      return true;
    }) as unknown as typeof process.kill);
  });

  afterEach(() => {
    stopOrphanSweeper();
    killSpy.mockRestore();
    mockFindOrphans.mockReturnValue([]);
    vi.useRealTimers();
  });

  it("sweeps immediately and then on each interval", () => {
    mockFindOrphans.mockReturnValue([{ pid: 601 }]);

    startOrphanSweeper();
    expect(signalled).toEqual([601]); // startup sweep

    vi.advanceTimersByTime(600_000);
    expect(signalled).toEqual([601, 601]); // first periodic run

    vi.advanceTimersByTime(600_000);
    expect(signalled).toEqual([601, 601, 601]);
  });

  it("stops sweeping once cancelled", () => {
    mockFindOrphans.mockReturnValue([{ pid: 602 }]);

    const stop = startOrphanSweeper();
    expect(signalled).toEqual([602]);

    stop();
    vi.advanceTimersByTime(1_800_000);
    expect(signalled).toEqual([602]); // no further sweeps
  });

  it("replaces the schedule rather than stacking a second one", () => {
    mockFindOrphans.mockReturnValue([{ pid: 603 }]);

    startOrphanSweeper();
    startOrphanSweeper();
    signalled.length = 0; // ignore the two startup sweeps

    vi.advanceTimersByTime(600_000);
    expect(signalled).toEqual([603]); // one interval fired, not two
  });
});
