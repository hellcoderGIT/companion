import { describe, it, expect } from "vitest";
import {
  parseClaudeVersion,
  compareVersions,
  formatVersion,
  isIncompatibleVersion,
  isKnownGoodVersion,
  pickPinTarget,
  KNOWN_GOOD_MAX,
  KNOWN_BAD_MIN,
} from "./claude-versions.js";

describe("parseClaudeVersion", () => {
  // Validates parsing across the two formats Claude has shipped:
  // the modern "X.Y.Z (Claude Code)" form and the older "Claude Code X.Y.Z" form.
  it("parses modern format from `claude --version`", () => {
    expect(parseClaudeVersion("2.1.142 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 142 });
  });

  it("parses legacy format", () => {
    expect(parseClaudeVersion("Claude Code 2.1.119")).toEqual({ major: 2, minor: 1, patch: 119 });
  });

  it("tolerates trailing whitespace and newlines from stdout", () => {
    expect(parseClaudeVersion("2.1.120\n")).toEqual({ major: 2, minor: 1, patch: 120 });
  });

  it("returns null when no version-like substring is present", () => {
    expect(parseClaudeVersion("Unknown command: --version")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major then minor then patch", () => {
    expect(compareVersions({ major: 2, minor: 1, patch: 120 }, { major: 2, minor: 1, patch: 121 })).toBe(-1);
    expect(compareVersions({ major: 2, minor: 1, patch: 121 }, { major: 2, minor: 1, patch: 120 })).toBe(1);
    expect(compareVersions({ major: 2, minor: 1, patch: 120 }, { major: 2, minor: 1, patch: 120 })).toBe(0);
    expect(compareVersions({ major: 1, minor: 9, patch: 999 }, { major: 2, minor: 0, patch: 0 })).toBe(-1);
  });
});

describe("isIncompatibleVersion / isKnownGoodVersion", () => {
  // The lockdown shipped in 2.1.121. 2.1.120 is the last working version.
  // These tests pin those boundary semantics so the constants don't silently drift.
  it("treats 2.1.120 as the last known-good version", () => {
    expect(isKnownGoodVersion({ major: 2, minor: 1, patch: 120 })).toBe(true);
    expect(isIncompatibleVersion({ major: 2, minor: 1, patch: 120 })).toBe(false);
  });

  it("treats 2.1.121 as the first incompatible version", () => {
    expect(isKnownGoodVersion({ major: 2, minor: 1, patch: 121 })).toBe(false);
    expect(isIncompatibleVersion({ major: 2, minor: 1, patch: 121 })).toBe(true);
  });

  it("treats 2.1.142 (currently-shipped) as incompatible", () => {
    expect(isIncompatibleVersion({ major: 2, minor: 1, patch: 142 })).toBe(true);
  });

  it("aligns with the exported constants", () => {
    expect(KNOWN_GOOD_MAX).toEqual({ major: 2, minor: 1, patch: 120 });
    expect(KNOWN_BAD_MIN).toEqual({ major: 2, minor: 1, patch: 121 });
  });
});

describe("pickPinTarget", () => {
  // Companion offers to pin to "the latest cached version that still works".
  // Important to skip incompatible versions even if they're newest on disk.
  it("returns the highest known-good version from a mixed list", () => {
    const result = pickPinTarget([
      { major: 2, minor: 1, patch: 119 },
      { major: 2, minor: 1, patch: 120 },
      { major: 2, minor: 1, patch: 142 },
    ]);
    expect(result).toEqual({ major: 2, minor: 1, patch: 120 });
  });

  it("ignores incompatible versions even if they're the newest available", () => {
    const result = pickPinTarget([
      { major: 2, minor: 1, patch: 130 },
      { major: 2, minor: 1, patch: 119 },
    ]);
    expect(result).toEqual({ major: 2, minor: 1, patch: 119 });
  });

  it("returns null when no candidate is known-good", () => {
    expect(pickPinTarget([{ major: 2, minor: 1, patch: 142 }])).toBeNull();
    expect(pickPinTarget([])).toBeNull();
  });
});

describe("formatVersion", () => {
  it("renders X.Y.Z without prefix", () => {
    expect(formatVersion({ major: 2, minor: 1, patch: 120 })).toBe("2.1.120");
  });
});
