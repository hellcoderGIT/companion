// Kernel-level process diagnostics for wedged CLI processes.
//
// When a CLI wedges, its stdout is closed and it emits nothing on stderr (see
// claude-adapter's wedge handling). With both output channels gone, the only
// remaining signal about *why* it is still alive is kernel state, so we read it
// from /proc immediately before killing the process.
//
// Everything here is best-effort and must never throw: this runs on a recovery
// path, and a diagnostic that breaks recovery is worse than no diagnostic.

import { readFileSync, readdirSync } from "node:fs";

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
  /** Why the snapshot is incomplete, when it is. */
  error?: string;
}

/** True when /proc-based introspection is available (Linux only). */
export function isProcAvailable(): boolean {
  return process.platform === "linux";
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

  if (!readAnything) snapshot.error = "process_gone_or_unreadable";
  return snapshot;
}
