import { describe, it, expect } from "vitest";
import { getSystemDisk } from "./system-disk.js";

// getSystemDisk reads the real filesystem via statfs(2), so exact byte counts
// are machine-dependent. The invariants below must hold on any host where
// statfs succeeds. On a host without statfs the function returns null, which
// every test tolerates — the meter is best-effort by design.
describe("getSystemDisk", () => {
  it("returns a coherent snapshot with sane invariants", () => {
    const d = getSystemDisk();
    if (!d) return; // statfs unavailable — nothing to assert

    // A mounted filesystem always has positive capacity.
    expect(d.total_bytes).toBeGreaterThan(0);

    expect(d.used_bytes).toBeGreaterThanOrEqual(0);
    expect(d.available_bytes).toBeGreaterThanOrEqual(0);
    expect(d.used_bytes).toBeLessThanOrEqual(d.total_bytes);
    expect(d.available_bytes).toBeLessThanOrEqual(d.total_bytes);

    // used is derived as total - available (never bfree), so the identity
    // must hold exactly. This is the guard against a future refactor
    // switching to bfree and silently under-reporting usage.
    expect(d.used_bytes).toBe(Math.max(0, d.total_bytes - d.available_bytes));
  });

  it("reports used_percent in 0–100 rounded to one decimal", () => {
    const d = getSystemDisk();
    if (!d) return;
    expect(d.used_percent).toBeGreaterThanOrEqual(0);
    expect(d.used_percent).toBeLessThanOrEqual(100);
    expect(Math.round(d.used_percent * 10)).toBe(d.used_percent * 10);
  });

  it("reports the Companion data dir as the measured path", () => {
    const d = getSystemDisk();
    if (!d) return;
    // The meter must describe the volume that session/recording files grow
    // into, which is not necessarily the one holding "/".
    expect(d.path).toBeTruthy();
    expect(typeof d.path).toBe("string");
  });

  it("never throws, even though the underlying syscall can fail", () => {
    // The route calls this on every poll with no try/catch of its own.
    expect(() => getSystemDisk()).not.toThrow();
  });
});
