import os from "node:os";
import { readFileSync } from "node:fs";

export interface SystemMemoryInfo {
  /** Total physical memory, in bytes. */
  total_bytes: number;
  /** Memory in use (total - available), in bytes. */
  used_bytes: number;
  /** Memory available for new allocations, in bytes. */
  available_bytes: number;
  /** Used percentage of total, 0–100, rounded to one decimal. */
  used_percent: number;
  /**
   * Total swap, in bytes. 0 when no swap is configured, or on platforms where
   * we cannot read it — callers should treat 0 as "no swap meter to show".
   */
  swap_total_bytes: number;
  /** Swap in use (total - free), in bytes. */
  swap_used_bytes: number;
  /** Used percentage of swap, 0–100, rounded to one decimal. 0 when no swap. */
  swap_used_percent: number;
}

/**
 * Parse a "Key:   12345 kB" line from /proc/meminfo into bytes.
 */
function readMeminfoKb(meminfo: string, key: string): number | null {
  const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
  return match ? Number(match[1]) : null;
}

/**
 * Snapshot of system memory usage. On Linux we read /proc/meminfo and use
 * MemAvailable, which accounts for reclaimable page cache and therefore
 * reflects true OOM headroom far better than os.freemem(). Everywhere else
 * (or if /proc is unreadable) we fall back to the os module.
 *
 * Swap comes from the same single /proc/meminfo read, so reporting it costs
 * nothing extra. It is worth surfacing separately rather than folding into the
 * RAM figure: a box that has begun swapping heavily is already thrashing, and
 * because MemAvailable excludes swap the RAM meter alone cannot show it. Swap
 * exhaustion on top of high RAM use is the state immediately preceding the OOM
 * killer, which is exactly what these meters exist to warn about.
 */
export function getSystemMemory(): SystemMemoryInfo {
  let total = os.totalmem();
  let available = os.freemem();
  let swapTotal = 0;
  let swapUsed = 0;

  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const totalKb = readMeminfoKb(meminfo, "MemTotal");
    const availableKb = readMeminfoKb(meminfo, "MemAvailable");
    if (totalKb !== null && availableKb !== null) {
      total = totalKb * 1024;
      available = availableKb * 1024;
    }
    const swapTotalKb = readMeminfoKb(meminfo, "SwapTotal");
    const swapFreeKb = readMeminfoKb(meminfo, "SwapFree");
    if (swapTotalKb !== null && swapFreeKb !== null) {
      swapTotal = swapTotalKb * 1024;
      // Clamp: SwapFree can momentarily exceed SwapTotal mid-swapoff.
      swapUsed = Math.max(0, swapTotal - swapFreeKb * 1024);
    }
  } catch {
    // Not Linux, or /proc/meminfo unavailable — keep the os module values.
    // The os module exposes no swap figures, so swap stays 0 (= "unknown",
    // rendered as no meter) rather than being reported as 0-bytes-used.
  }

  const used = Math.max(0, total - available);
  const used_percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
  const swap_used_percent =
    swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0;
  return {
    total_bytes: total,
    used_bytes: used,
    available_bytes: available,
    used_percent,
    swap_total_bytes: swapTotal,
    swap_used_bytes: swapUsed,
    swap_used_percent,
  };
}
