import { statfsSync } from "node:fs";
import { COMPANION_HOME } from "./paths.js";

export interface SystemDiskInfo {
  /** Total size of the filesystem holding COMPANION_HOME, in bytes. */
  total_bytes: number;
  /** Space in use (total - available), in bytes. */
  used_bytes: number;
  /** Space available to this (unprivileged) user, in bytes. */
  available_bytes: number;
  /** Used percentage of total, 0–100, rounded to one decimal. */
  used_percent: number;
  /** Path the figures were measured for. */
  path: string;
}

/**
 * Snapshot of free space on the filesystem that holds the Companion data
 * directory — that's the volume sessions, recordings and logs actually grow
 * into, which is not necessarily the one holding "/".
 *
 * Deliberately uses statfs(2) rather than shelling out to `df`, and never
 * walks the tree the way `du` would: this is a single syscall against the
 * already-in-memory superblock (~0.1ms, no disk I/O), so it is safe to call
 * on a poll interval and needs no caching layer.
 *
 * We report `bavail` (blocks free to unprivileged users) rather than `bfree`,
 * which excludes the root-reserved reserve. That mirrors how getSystemMemory()
 * prefers MemAvailable over MemFree: both answer "how much can I actually
 * still use" rather than "how much is technically unallocated". It is also why
 * this can read a percent or two above `df` for the same filesystem.
 */
export function getSystemDisk(): SystemDiskInfo | null {
  try {
    const stats = statfsSync(COMPANION_HOME);
    // bsize is the preferred I/O block size that blocks/bavail are counted in.
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    const used = Math.max(0, total - available);
    const used_percent =
      total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
    return {
      total_bytes: total,
      used_bytes: used,
      available_bytes: available,
      used_percent,
      path: COMPANION_HOME,
    };
  } catch {
    // statfs is unavailable (very old runtime) or the path does not exist yet
    // on a first run. The meter is best-effort — the route returns 204 and the
    // UI renders nothing rather than showing a bogus zeroed bar.
    return null;
  }
}
