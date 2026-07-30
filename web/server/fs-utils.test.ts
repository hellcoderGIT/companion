import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countFileLines,
  countFileLinesAsync,
  countFileLinesCached,
  cachedFileLines,
  type FileLinesCacheEntry,
} from "./fs-utils.js";

function makeTmpFile(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
  const path = join(dir, "file.log");
  writeFileSync(path, content);
  return { dir, path };
}

describe("countFileLinesAsync", () => {
  // The async counter exists because the sync one reads whole files on the
  // event loop (a 5-minute rotation scan of a multi-hundred-MB dir starved
  // live CLI stdio streams). It must agree with the sync counter exactly.
  it("matches countFileLines on the same content", async () => {
    const { dir, path } = makeTmpFile("a\nb\nc\nno-trailing-newline");
    try {
      expect(await countFileLinesAsync(path)).toBe(countFileLines(path));
      expect(await countFileLinesAsync(path)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves 0 for a missing file instead of throwing", async () => {
    expect(await countFileLinesAsync("/nonexistent/definitely/missing.log")).toBe(0);
  });

  it("counts across chunk boundaries on a file larger than one chunk", async () => {
    // 2.5MB of 100-byte lines crosses the 1MB highWaterMark multiple times.
    const line = "x".repeat(99) + "\n";
    const { dir, path } = makeTmpFile(line.repeat(25_000));
    try {
      expect(await countFileLinesAsync(path)).toBe(25_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("countFileLinesCached", () => {
  // Rotated log/recording files are immutable, so a (size, mtime) match must
  // serve from cache without re-reading — that is the whole point: in steady
  // state only the actively-written file is ever re-counted.
  it("serves an unchanged file from cache and recounts after append", async () => {
    const { dir, path } = makeTmpFile("1\n2\n");
    const cache = new Map<string, FileLinesCacheEntry>();
    try {
      expect(await countFileLinesCached(path, cache)).toBe(2);
      expect(cache.size).toBe(1);

      // Poison the cached count to prove the second call does NOT re-read.
      const entry = cache.get(path)!;
      cache.set(path, { ...entry, lines: 999 });
      expect(await countFileLinesCached(path, cache)).toBe(999);

      // Append (size changes) → cache invalidated → real recount.
      appendFileSync(path, "3\n4\n");
      expect(await countFileLinesCached(path, cache)).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 and drops the cache entry for a deleted file", async () => {
    const { dir, path } = makeTmpFile("1\n");
    const cache = new Map<string, FileLinesCacheEntry>();
    try {
      await countFileLinesCached(path, cache);
      rmSync(path);
      expect(await countFileLinesCached(path, cache)).toBe(0);
      expect(cache.has(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cachedFileLines", () => {
  it("returns the cached count on a hit and null on a miss", async () => {
    const { dir, path } = makeTmpFile("1\n2\n3\n");
    const cache = new Map<string, FileLinesCacheEntry>();
    try {
      // Cold cache → miss.
      expect(cachedFileLines(path, cache)).toBeNull();
      // Warm via the async path → hit.
      await countFileLinesCached(path, cache);
      expect(cachedFileLines(path, cache)).toBe(3);
      // Stale after append → miss again (must not serve a wrong count).
      appendFileSync(path, "4\n");
      expect(cachedFileLines(path, cache)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
