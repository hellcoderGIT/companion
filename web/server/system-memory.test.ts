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
});
