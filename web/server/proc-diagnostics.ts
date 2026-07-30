// Kernel-level process diagnostics for wedged CLI processes.
//
// When a CLI wedges, its stdout is closed and it emits nothing on stderr (see
// claude-adapter's wedge handling). With both output channels gone, the only
// remaining signal about *why* it is still alive is kernel state, so we read it
// from /proc immediately before killing the process.
//
// Everything here is best-effort and must never throw: this runs on a recovery
// path, and a diagnostic that breaks recovery is worse than no diagnostic.

import { readFileSync, readdirSync, readlinkSync } from "node:fs";

/** A point-in-time snapshot of kernel state for a process. */
export interface ProcSnapshot {
  /** Scheduler state, e.g. "S (sleeping)", "R (running)", "Z (zombie)", "D (disk sleep)". */
  state?: string;
  /** Thread count. A live-threads-but-no-output process looks different from a zombie. */
  threads?: number;
  /** Resident set size as reported by /proc (e.g. "123456 kB"). */
  vmRSS?: string;
  /**
   * Kernel wait channel — the syscall the process is blocked in. This is the
   * discriminating field: a process blocked writing to a full pipe, parked in a
   * futex, and spinning in userspace are three different bugs.
   */
  wchan?: string;
  /** Open file descriptor count for this process. */
  fdCount?: number;
  /**
   * Live descendants at capture time. This is the field that separates the two
   * reasons a process sits in `ep_poll` with stdout closed: a genuine wedge is
   * idle with NO children, whereas a CLI still reaping MCP stdio servers has
   * children mid-exit. Without it, both look identical.
   */
  descendants?: ProcDescendant[];
  /** Why the snapshot is incomplete, when it is. */
  error?: string;
}

/** A live descendant process, as seen from /proc. */
export interface ProcDescendant {
  pid: number;
  /** Command name from /proc/<pid>/comm, e.g. "npm exec", "node", "chrome". */
  comm?: string;
  /** Scheduler state letter, e.g. "S", "R", "Z". "Z" means mid-reap. */
  state?: string;
}

/** Read the direct children of a pid via /proc/<pid>/task/<tid>/children. */
function readChildren(pid: number): number[] {
  const kids: number[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
        if (!raw) continue;
        for (const part of raw.split(/\s+/)) {
          const child = Number(part);
          if (Number.isInteger(child) && child > 0) kids.push(child);
        }
      } catch {
        // Thread exited between readdir and read.
      }
    }
  } catch {
    // Process gone, or kernel built without CONFIG_PROC_CHILDREN.
  }
  return kids;
}

/**
 * Walk the descendant tree of a pid, breadth-first.
 *
 * Bounded by `maxNodes` because this runs on the kill path — a runaway tree
 * must not stall recovery. MCP stdio servers are the expected population here
 * (2-3 per CLI, sometimes with their own children, e.g. headless chromium).
 */
export function getDescendants(
  pid: number | undefined,
  maxNodes = 32,
): ProcDescendant[] {
  if (pid === undefined || !isProcAvailable()) return [];

  const found: ProcDescendant[] = [];
  const seen = new Set<number>([pid]);
  let frontier = readChildren(pid);

  while (frontier.length > 0 && found.length < maxNodes) {
    const next: number[] = [];
    for (const child of frontier) {
      if (seen.has(child) || found.length >= maxNodes) continue;
      seen.add(child);

      const entry: ProcDescendant = { pid: child };
      try {
        entry.comm = readFileSync(`/proc/${child}/comm`, "utf8").trim();
      } catch {
        // Already reaped — still worth reporting the pid.
      }
      try {
        const status = readFileSync(`/proc/${child}/status`, "utf8");
        const line = status.split("\n").find((l) => l.startsWith("State:"));
        if (line) entry.state = line.split(":")[1]?.trim().split(" ")[0];
      } catch {
        // Same.
      }
      found.push(entry);
      next.push(...readChildren(child));
    }
    frontier = next;
  }

  return found;
}

/**
 * Whether a process still has live descendants.
 *
 * Used to decide how long to wait for a CLI to shut down: one that is still
 * reaping MCP subprocesses deserves the generous grace, regardless of whether
 * the last message it sent happened to be a `result`.
 */
export function hasLiveDescendants(pid: number | undefined): boolean {
  if (pid === undefined || !isProcAvailable()) return false;
  return readChildren(pid).length > 0;
}

/**
 * Count live descendants without reading per-process detail.
 *
 * Cheaper than getDescendants() because it skips the comm/status reads, so it
 * is safe to call on a poll loop. Used to tell *progress* (the count is
 * dropping, teardown is working) from a *stall* (the count is stuck, nothing is
 * happening) — which is what decides whether waiting longer is worthwhile.
 */
export function countDescendants(
  pid: number | undefined,
  maxNodes = 256,
): number {
  if (pid === undefined || !isProcAvailable()) return 0;

  let count = 0;
  const seen = new Set<number>([pid]);
  let frontier = readChildren(pid);

  while (frontier.length > 0 && count < maxNodes) {
    const next: number[] = [];
    for (const child of frontier) {
      if (seen.has(child) || count >= maxNodes) continue;
      seen.add(child);
      count++;
      next.push(...readChildren(child));
    }
    frontier = next;
  }

  return count;
}

/** True when /proc-based introspection is available (Linux only). */
export function isProcAvailable(): boolean {
  return process.platform === "linux";
}

/** Command-line markers identifying a CLI-spawned stdio MCP server. */
const MCP_CMDLINE_MARKERS = ["dev-mcp", "playwright/mcp", "mcp-server", "@modelcontextprotocol"];

/**
 * Find MCP server processes that no longer belong to a live CLI.
 *
 * Per-kill reaping (see `ClaudeAdapter.reapOrphans`) handles the steady state,
 * but it cannot clean up after the server itself dies: if companion is killed,
 * restarted or OOM-killed, every CLI it owned is orphaned along with that CLI's
 * MCP children, and nothing is left holding the reference needed to reap them.
 * They then sit there for the lifetime of the host, holding memory no one can
 * reclaim — 123 such processes across 11.9 GB were found on a 23 GB production
 * box.
 *
 * An MCP stdio server whose parent is not a `claude` process has no client and
 * can never acquire one, which makes it unambiguously safe to terminate.
 */
export function findOrphanedMcpProcesses(): ProcDescendant[] {
  if (!isProcAvailable()) return [];

  const orphans: ProcDescendant[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }

  for (const entry of pids) {
    const pid = Number(entry);
    if (pid === process.pid) continue;

    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue; // Exited mid-scan.
    }
    if (!MCP_CMDLINE_MARKERS.some((m) => cmdline.includes(m))) continue;

    // Parent still a live claude process → it has a client; leave it alone.
    let ppid: number | undefined;
    try {
      ppid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[3]);
    } catch {
      continue;
    }
    if (ppid && ppid !== 1) {
      try {
        if (readFileSync(`/proc/${ppid}/cmdline`, "utf8").includes("claude")) continue;
      } catch {
        // Parent vanished between reads — treat as orphaned.
      }
    }

    const orphan: ProcDescendant = { pid };
    try {
      orphan.comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      // Best-effort label only.
    }
    orphans.push(orphan);
  }

  return orphans;
}

/**
 * Capture kernel state for a pid. Returns `{ error }` rather than throwing when
 * the platform has no /proc or the process has already exited (the common race:
 * it exits between the liveness check and this call).
 */
export function captureProcState(pid: number | undefined): ProcSnapshot {
  if (pid === undefined) return { error: "no_pid" };
  if (!isProcAvailable()) return { error: `unsupported_platform:${process.platform}` };

  const snapshot: ProcSnapshot = {};
  let readAnything = false;

  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    readAnything = true;
    for (const line of status.split("\n")) {
      const [rawKey, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (!value) continue;
      if (rawKey === "State") snapshot.state = value;
      else if (rawKey === "Threads") snapshot.threads = Number(value) || undefined;
      else if (rawKey === "VmRSS") snapshot.vmRSS = value;
    }
  } catch {
    // Process exited, or /proc entry vanished mid-read.
  }

  try {
    // wchan has no trailing newline and reads as "0" for a running process.
    const wchan = readFileSync(`/proc/${pid}/wchan`, "utf8").trim();
    readAnything = true;
    if (wchan) snapshot.wchan = wchan;
  } catch {
    // Requires the process to still exist; ignore if it does not.
  }

  try {
    snapshot.fdCount = readdirSync(`/proc/${pid}/fd`).length;
    readAnything = true;
  } catch {
    // Reading another process's fd dir can fail on permissions; not fatal.
  }

  const descendants = getDescendants(pid);
  if (descendants.length > 0) {
    snapshot.descendants = descendants;
    readAnything = true;
  }

  if (!readAnything) snapshot.error = "process_gone_or_unreadable";
  return snapshot;
}

/**
 * Does the process still hold its stdout (fd 1) open?
 *
 * The discriminating probe for a mid-stream stdout EOF. A pipe only EOFs at
 * the read end once every write end is closed — so if OUR reader reported EOF
 * while the CLI's fd 1 is still open, the "EOF" was synthetic on the reader
 * (Bun stream) side, not the CLI closing its output. That distinction decides
 * whether a "wedged" kill is recovering from a real CLI failure or destroying
 * a healthy process because of our own stream handling. Production sampling
 * showed every wedge-kill victim was healthy (S/ep_poll), which is what
 * motivated recording this at kill time.
 *
 * Returns true if fd 1 is open, false if it is definitely gone (fd closed or
 * process exited), and null when it cannot be determined (non-Linux,
 * permissions).
 */
export function stdoutFdOpen(pid: number | undefined | null): boolean | null {
  if (!pid || process.platform !== "linux") return null;
  try {
    readlinkSync(`/proc/${pid}/fd/1`);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ESRCH" ? false : null;
  }
}
