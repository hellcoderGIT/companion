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
 */
export function getSystemMemory(): SystemMemoryInfo {
  let total = os.totalmem();
  let available = os.freemem();

  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const totalKb = readMeminfoKb(meminfo, "MemTotal");
    const availableKb = readMeminfoKb(meminfo, "MemAvailable");
    if (totalKb !== null && availableKb !== null) {
      total = totalKb * 1024;
      available = availableKb * 1024;
    }
  } catch {
    // Not Linux, or /proc/meminfo unavailable — keep the os module values.
  }

  const used = Math.max(0, total - available);
  const used_percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
  return {
    total_bytes: total,
    used_bytes: used,
    available_bytes: available,
    used_percent,
  };
}
