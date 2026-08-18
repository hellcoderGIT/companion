import { describe, it, expect } from "vitest";
import { getSystemMemory } from "./system-memory.js";

// getSystemMemory reads real machine memory (via /proc/meminfo on Linux, else
// the os module). We can't assert exact byte counts, but the invariants below
// must always hold regardless of platform.
describe("getSystemMemory", () => {
  it("returns a coherent snapshot with sane invariants", () => {
    const m = getSystemMemory();

    // Total memory is a positive number.
    expect(m.total_bytes).toBeGreaterThan(0);

    // used + available never exceeds total, and neither is negative.
    expect(m.used_bytes).toBeGreaterThanOrEqual(0);
    expect(m.available_bytes).toBeGreaterThanOrEqual(0);
    expect(m.used_bytes).toBeLessThanOrEqual(m.total_bytes);
    expect(m.available_bytes).toBeLessThanOrEqual(m.total_bytes);

    // used = total - available by construction.
    expect(m.used_bytes).toBe(Math.max(0, m.total_bytes - m.available_bytes));
  });

  it("reports used_percent in 0–100 rounded to one decimal", () => {
    const m = getSystemMemory();
    expect(m.used_percent).toBeGreaterThanOrEqual(0);
    expect(m.used_percent).toBeLessThanOrEqual(100);
    // At most one decimal place.
    expect(Math.round(m.used_percent * 10)).toBe(m.used_percent * 10);
  });

  // Swap is read from the same /proc/meminfo snapshot as RAM. A host may have
  // no swap at all, in which case every swap field must be 0 — the UI keys off
  // swap_total_bytes === 0 to hide the meter entirely.
  it("returns coherent swap figures, or zeroes when swap is absent", () => {
    const m = getSystemMemory();

    expect(m.swap_total_bytes).toBeGreaterThanOrEqual(0);
    expect(m.swap_used_bytes).toBeGreaterThanOrEqual(0);

    if (m.swap_total_bytes === 0) {
      // No swap configured (or a non-Linux host): must not report phantom use.
      expect(m.swap_used_bytes).toBe(0);
      expect(m.swap_used_percent).toBe(0);
      return;
    }

    // Used swap can never exceed the configured total, even though SwapFree
    // can briefly exceed SwapTotal during swapoff — that's what the clamp is for.
    expect(m.swap_used_bytes).toBeLessThanOrEqual(m.swap_total_bytes);
    expect(m.swap_used_percent).toBeGreaterThanOrEqual(0);
    expect(m.swap_used_percent).toBeLessThanOrEqual(100);
    expect(Math.round(m.swap_used_percent * 10)).toBe(m.swap_used_percent * 10);
  });

  it("keeps swap independent of the RAM figures", () => {
    // MemAvailable deliberately excludes swap, so a swapping box shows healthy
    // RAM headroom while thrashing. Guards against a refactor that folds swap
    // into used_bytes and hides exactly the condition we want to surface.
    const m = getSystemMemory();
    expect(m.used_bytes).toBe(Math.max(0, m.total_bytes - m.available_bytes));
  });
});
