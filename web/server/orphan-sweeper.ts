/**
 * Startup sweep for MCP servers orphaned by a previous companion run.
 *
 * Each `claude --print` CLI spawns 2-3 stdio MCP children (e.g. @shopify/dev-mcp,
 * @playwright/mcp plus its headless chromium). Signals go to a pid rather than a
 * tree, so when a CLI dies its children are re-parented to init. `ClaudeAdapter`
 * now reaps them on its own kill path, but that only covers kills companion
 * performs while it is running. If companion itself is restarted, crashes or is
 * OOM-killed, every CLI it owned is orphaned together with those children and
 * nothing remains that could clean them up.
 *
 * Left alone they persist for the life of the host. A production box was found
 * holding 123 such processes across 11.9 GB of 23 GB total, which starved the
 * live CLIs of CPU and memory until they stopped answering — producing exactly
 * the stall and wedge symptoms that cause more kills, and so more orphans.
 *
 * Running this once at startup breaks that cycle. An MCP stdio server whose
 * parent is not a `claude` process has no client and can never acquire one, so
 * terminating it is unambiguously safe.
 */
import { findOrphanedMcpProcesses } from "./proc-diagnostics.js";
import { log } from "./logger.js";

/** Grace before escalating; chromium and npm wrappers often ignore SIGTERM. */
const SWEEP_SIGKILL_AFTER_MS = Number(process.env.COMPANION_SWEEP_SIGKILL_AFTER_MS) || 5000;

/**
 * How often to re-run the sweep while the server is up.
 *
 * A startup sweep alone leaves a gap: a CLI killed by something other than this
 * process — the kernel OOM killer is the common one on a loaded host — orphans
 * its MCP children with nobody to reap them, and they then accumulate for the
 * rest of the server's uptime. That is exactly how a production box reached 123
 * orphans across 11.9 GB inside a single run. The scan is a cheap /proc walk, so
 * running it periodically costs nothing measurable.
 */
const SWEEP_INTERVAL_MS = Number(process.env.COMPANION_SWEEP_INTERVAL_MS) || 600_000;

/**
 * Terminate every MCP server process with no live CLI parent.
 *
 * Never throws: a failure to tidy up must not prevent the server from starting.
 * Returns the number of processes signalled, for logging and tests.
 */
export function sweepOrphanedMcpProcesses(): number {
  let orphans: ReturnType<typeof findOrphanedMcpProcesses>;
  try {
    orphans = findOrphanedMcpProcesses();
  } catch (err) {
    log.warn("orphan-sweeper", "scan failed; skipping sweep", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  if (orphans.length === 0) return 0;

  const signalled: number[] = [];
  for (const o of orphans) {
    try {
      process.kill(o.pid, "SIGTERM");
      signalled.push(o.pid);
    } catch {
      // Exited between the scan and the signal.
    }
  }

  if (signalled.length === 0) return 0;

  log.info("orphan-sweeper", "reaped MCP servers orphaned by a previous run", {
    count: signalled.length,
    comms: [...new Set(orphans.map((o) => o.comm).filter(Boolean))].slice(0, 5),
  });

  setTimeout(() => {
    for (const pid of signalled) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone, which is the desired outcome.
      }
    }
  }, SWEEP_SIGKILL_AFTER_MS).unref?.();

  return signalled.length;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sweep at startup, then periodically for as long as the server runs.
 *
 * Returns a stop function, so tests and shutdown paths can clear the timer.
 * Calling this twice replaces the existing schedule rather than stacking a
 * second one.
 */
export function startOrphanSweeper(): () => void {
  stopOrphanSweeper();
  sweepOrphanedMcpProcesses();
  sweepTimer = setInterval(() => sweepOrphanedMcpProcesses(), SWEEP_INTERVAL_MS);
  // Housekeeping must never hold the process open.
  (sweepTimer as unknown as { unref?: () => void }).unref?.();
  return stopOrphanSweeper;
}

/** Cancel the periodic sweep, if one is scheduled. */
export function stopOrphanSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
