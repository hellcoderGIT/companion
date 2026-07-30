import { readFileSync, createReadStream, statSync } from "node:fs";

/** Count newlines in a file. Fast: reads raw buffer, counts 0x0A bytes.
 *
 * Synchronous — reads the ENTIRE file on the event loop. Only safe for small
 * files or cold paths. Periodic rotation over multi-hundred-MB log/recording
 * directories must use `countFileLinesAsync`/`countFileLinesCached` instead:
 * measured on a production box, sync counting of 66MB logs + 385MB recordings
 * every 5 minutes stalled the event loop long enough to starve live CLI
 * stdio streams.
 */
export function countFileLines(path: string): number {
  try {
    const buf = readFileSync(path);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Count newlines in a file without monopolizing the event loop.
 *
 * Streams the file in 1MB chunks; between chunks the event loop is free to
 * service WebSocket frames and child-process stdio. Resolves 0 on any error
 * (missing file, permission) — counting is always best-effort here.
 */
export function countFileLinesAsync(path: string): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(path, { highWaterMark: 1 << 20 });
    } catch {
      resolve(0);
      return;
    }
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) count++;
      }
    });
    stream.on("error", () => resolve(0));
    stream.on("end", () => resolve(count));
  });
}

/** Cache entry for `countFileLinesCached`: valid while size AND mtime match. */
export interface FileLinesCacheEntry {
  size: number;
  mtimeMs: number;
  lines: number;
}

/**
 * Count newlines with a stat-validated cache.
 *
 * Rotated log/recording files are append-only while active and immutable once
 * rotated, so an unchanged (size, mtime) pair means the cached count is still
 * exact. In steady state only the currently-written file misses the cache,
 * turning the periodic rotation scan from "re-read every byte of the
 * directory" into one stat per file plus one streamed read of the active file.
 */
export async function countFileLinesCached(
  path: string,
  cache: Map<string, FileLinesCacheEntry>,
): Promise<number> {
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    cache.delete(path);
    return 0;
  }

  const cached = cache.get(path);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return cached.lines;
  }

  const lines = await countFileLinesAsync(path);
  cache.set(path, { size, mtimeMs, lines });
  return lines;
}

/**
 * Synchronous cache lookup: returns the cached line count if still valid,
 * or null on a miss. Lets on-demand sync paths (REST listings) reuse counts
 * warmed by the periodic async scan without re-reading files.
 */
export function cachedFileLines(
  path: string,
  cache: Map<string, FileLinesCacheEntry>,
): number | null {
  try {
    const st = statSync(path);
    const cached = cache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return cached.lines;
    }
  } catch {
    cache.delete(path);
  }
  return null;
}
