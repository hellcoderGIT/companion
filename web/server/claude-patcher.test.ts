import { describe, it, expect } from "vitest";
import { replaceAllBytes, PATCHED_BINARY_MARKER, _PATCHER_PATHS_FOR_TEST, _internalForTest } from "./claude-patcher.js";

const { ORIGINAL_HOSTNAME, PATCHED_HOSTNAME } = _PATCHER_PATHS_FOR_TEST;

describe("replaceAllBytes", () => {
  // The patcher's core invariant: substitution must be length-preserving so
  // that bundle offsets (V8 bytecode caches, source maps, etc.) don't shift.
  it("rejects mismatched lengths", () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(() => replaceAllBytes(buf, new Uint8Array([1]), new Uint8Array([1, 2])))
      .toThrow(/equal lengths/);
  });

  it("replaces every occurrence in place", () => {
    const enc = new TextEncoder();
    const haystack = enc.encode("AA bb AA cc AA");
    const from = enc.encode("AA");
    const to = enc.encode("ZZ");
    const { out, replacements } = replaceAllBytes(haystack, from, to);
    expect(replacements).toBe(3);
    expect(new TextDecoder().decode(out)).toBe("ZZ bb ZZ cc ZZ");
  });

  it("returns a fresh buffer rather than mutating input (caller safety)", () => {
    const enc = new TextEncoder();
    const original = enc.encode("AA bb");
    const snapshot = new Uint8Array(original);
    replaceAllBytes(original, enc.encode("AA"), enc.encode("ZZ"));
    // The original buffer must be untouched — patcher writes the patched copy
    // to a separate file and must never modify the user's installed binary.
    expect(original).toEqual(snapshot);
  });

  it("handles zero occurrences cleanly", () => {
    const enc = new TextEncoder();
    const haystack = enc.encode("nothing here");
    const { out, replacements } = replaceAllBytes(haystack, enc.encode("AA"), enc.encode("ZZ"));
    expect(replacements).toBe(0);
    expect(new TextDecoder().decode(out)).toBe("nothing here");
  });
});

describe("patch hostname constants", () => {
  // The whole approach hinges on these two strings being the same byte length.
  // If a future Claude release renames the staging host, the replacement string
  // here must stay 27 bytes — that's the size of the marker we look up at
  // runtime in claude-compat-checker.ts.
  it("ORIGINAL_HOSTNAME and PATCHED_HOSTNAME are the same byte length", () => {
    const enc = new TextEncoder();
    expect(enc.encode(ORIGINAL_HOSTNAME).length).toBe(enc.encode(PATCHED_HOSTNAME).length);
  });

  it("PATCHED_HOSTNAME matches the marker checked by the compat checker", () => {
    expect(PATCHED_HOSTNAME).toBe(PATCHED_BINARY_MARKER);
  });

  it("PATCHED_HOSTNAME canonicalizes to [::1] via the same URL parser the Claude validator uses", () => {
    // This test pins the whole technique: both ORIGINAL_HOSTNAME (in KU5 at
    // Claude build time) and PATCHED_HOSTNAME (after our byte-replace) must
    // run through new URL().hostname and converge on the same value at the
    // --sdk-url check point. theshadow27/mcp-cli#1808 documented this; we
    // assert it here so a future refactor can't quietly break it.
    const patchedAsHost = new URL(`https://${PATCHED_HOSTNAME}`).hostname;
    const literalLoopback = new URL("https://[::1]").hostname;
    expect(patchedAsHost).toBe(literalLoopback); // both "[::1]"
  });
});

describe("countOccurrences (internal)", () => {
  // Sanity check the substring search — the patcher uses this to validate
  // that the binary contains the expected number of hostname occurrences
  // before going through with a patch.
  it("counts non-overlapping matches", () => {
    const enc = new TextEncoder();
    const buf = enc.encode("xxx-AA-yyy-AA-zzz");
    expect(_internalForTest.countOccurrences(buf, enc.encode("AA"))).toBe(2);
  });

  it("returns 0 on empty needle searches in larger buffers", () => {
    const enc = new TextEncoder();
    const buf = enc.encode("nothing matches");
    expect(_internalForTest.countOccurrences(buf, enc.encode("ABC"))).toBe(0);
  });
});
