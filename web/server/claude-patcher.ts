/**
 * Two compatibility actions exposed to the UI:
 *
 *   pinToVersion(v) — re-point ~/.local/bin/claude at a cached known-good
 *     version of the binary. No binary modification. Fast and reversible.
 *
 *   patchBinary() — copy the currently-installed binary to a sibling
 *     "<version>.patched" file, byte-replace `claude-staging.fedstart.com`
 *     with `[000:000:000:000:000:0:0:1]` (4 occurrences, length-preserving),
 *     and atomically swap the ~/.local/bin/claude symlink to point at the
 *     patched copy. After this, the CLI accepts `wss://[::1]:<port>/...` as
 *     --sdk-url (the byte-replace puts [::1] into the allowlist; the scheme
 *     check still demands wss://, hence the parallel TLS ingress server).
 *
 * Reference: theshadow27/mcp-cli#1808 documents the same approach validated
 * end-to-end on macOS. We follow that recipe on Linux (no codesign step).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PATCHED_BINARY_MARKER } from "./claude-compat-checker.js";

/**
 * The 27-byte hostname literal we replace. Same length as PATCHED_BINARY_MARKER
 * so the surrounding bundle offsets stay intact and the JS parser doesn't choke.
 *
 * Both strings flow through `new URL(...).hostname` at runtime: the patched
 * hostname canonicalizes to "[::1]" (IPv6 loopback), which is then matched
 * against the same canonical form when --sdk-url passes "wss://[::1]:..."
 * through the validator. Both sides converge.
 */
const ORIGINAL_HOSTNAME = "claude-staging.fedstart.com";
const PATCHED_HOSTNAME = PATCHED_BINARY_MARKER;

/** Number of occurrences we expect to find in a clean (unpatched) binary. */
const EXPECTED_OCCURRENCES = 4;

const CLAUDE_SYMLINK_DIR = join(homedir(), ".local", "bin");
const CLAUDE_SYMLINK = join(CLAUDE_SYMLINK_DIR, "claude");
const CLAUDE_VERSIONS_DIR = join(homedir(), ".local", "share", "claude", "versions");

export type PatcherResult<T> = { ok: true } & T | { ok: false; error: string };

function countOccurrences(buf: Uint8Array, needle: Uint8Array): number {
  let count = 0;
  outer: for (let i = 0; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    count++;
    i += needle.length - 1;
  }
  return count;
}

/** Pure byte-replace: returns a new buffer with every `from` occurrence rewritten as `to`. */
export function replaceAllBytes(
  buf: Uint8Array,
  from: Uint8Array,
  to: Uint8Array,
): { out: Uint8Array; replacements: number } {
  if (from.length !== to.length) {
    throw new Error(`replaceAllBytes requires equal lengths (${from.length} vs ${to.length})`);
  }
  const out = new Uint8Array(buf);
  let replacements = 0;
  outer: for (let i = 0; i <= out.length - from.length; i++) {
    for (let j = 0; j < from.length; j++) {
      if (out[i + j] !== from[j]) continue outer;
    }
    out.set(to, i);
    replacements++;
    i += from.length - 1;
  }
  return { out, replacements };
}

/** Atomic symlink swap: write to a temp link then rename(2) onto the target. */
async function atomicSymlinkSwap(target: string, linkPath: string): Promise<void> {
  mkdirSync(dirname(linkPath), { recursive: true });
  // `ln -sfn` is atomic on POSIX (rename(2) under the hood) and handles the
  // existing-symlink case without the unlink-then-symlink race.
  const proc = Bun.spawn(["ln", "-sfn", target, linkPath], {
    stdout: "pipe", stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ln -sfn failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

/**
 * Re-point ~/.local/bin/claude at a cached known-good version (e.g. 2.1.120).
 * Doesn't modify any binary content — just a symlink swap.
 */
export async function pinToVersion(version: string): Promise<PatcherResult<{ target: string }>> {
  const target = join(CLAUDE_VERSIONS_DIR, version);
  if (!existsSync(target)) {
    return {
      ok: false,
      error: `No cached Claude ${version} binary at ${target}. Install it with Anthropic's installer first.`,
    };
  }
  try {
    await atomicSymlinkSwap(target, CLAUDE_SYMLINK);
    return { ok: true, target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Locate the binary the `claude` symlink currently resolves to. */
function resolveCurrentBinaryPath(): string | null {
  if (!existsSync(CLAUDE_SYMLINK)) return null;
  try {
    const stat = statSync(CLAUDE_SYMLINK);
    if (!stat.isFile()) return null;
    return readFileSync(CLAUDE_SYMLINK).length > 0 ? CLAUDE_SYMLINK : null;
  } catch {
    return null;
  }
}

/**
 * Take whatever the `claude` symlink currently points at, copy it to a
 * sibling "<filename>.patched", byte-replace the hostname, swap the symlink
 * to the patched copy.
 *
 * Idempotent: if the resolved binary is already patched (contains the
 * marker) the function returns { ok: true, alreadyPatched: true }.
 *
 * We never modify the user's original binary in place — Anthropic's
 * auto-updater treats `~/.local/share/claude/versions/<X.Y.Z>` as
 * authoritative and rewrites it on its own schedule. Patched copies live
 * alongside as <X.Y.Z>.patched.
 */
export async function patchBinary(): Promise<PatcherResult<{ patchedPath: string; replacements: number }>> {
  const source = resolveCurrentBinaryPath();
  if (!source) {
    return { ok: false, error: `Could not resolve a real file from ${CLAUDE_SYMLINK}` };
  }

  // The symlink itself points into versions/<X.Y.Z>. We patch a sibling, not the original.
  // statSync on a symlink follows by default; resolve via readlinkSync if symlink.
  let sourceFile = source;
  try {
    const lstat = statSync(source, { throwIfNoEntry: false });
    if (lstat?.isSymbolicLink?.()) {
      const { readlinkSync } = await import("node:fs");
      const link = readlinkSync(source);
      sourceFile = link.startsWith("/") ? link : join(dirname(source), link);
    }
  } catch { /* fall through, use source */ }

  // Strip any trailing ".patched" if we somehow point at a patched file already.
  const baseFile = sourceFile.replace(/\.patched$/, "");
  const patchedPath = `${baseFile}.patched`;

  try {
    const buf = readFileSync(baseFile);
    const fromBytes = new TextEncoder().encode(ORIGINAL_HOSTNAME);
    const toBytes = new TextEncoder().encode(PATCHED_HOSTNAME);

    const occurrences = countOccurrences(buf, fromBytes);
    if (occurrences === 0) {
      // Already-patched binary won't contain the original hostname anymore.
      // Check the marker as a sanity guard.
      const markerBytes = new TextEncoder().encode(PATCHED_BINARY_MARKER);
      if (countOccurrences(buf, markerBytes) > 0) {
        // Already patched — make sure the symlink is pointing at us.
        if (!existsSync(patchedPath)) {
          writeFileSync(patchedPath, buf);
          chmodSync(patchedPath, 0o755);
        }
        await atomicSymlinkSwap(patchedPath, CLAUDE_SYMLINK);
        return { ok: true, patchedPath, replacements: 0 };
      }
      return {
        ok: false,
        error: `Hostname literal "${ORIGINAL_HOSTNAME}" not found in ${baseFile}. ` +
               `This Claude build does not match the known patch profile.`,
      };
    }
    if (occurrences !== EXPECTED_OCCURRENCES) {
      console.warn(
        `[claude-patcher] Found ${occurrences} hostname occurrences (expected ${EXPECTED_OCCURRENCES}). ` +
        `Patching anyway — the build may have changed.`,
      );
    }

    const { out, replacements } = replaceAllBytes(buf, fromBytes, toBytes);
    if (replacements === 0) {
      return { ok: false, error: "Byte replace ran but produced no changes" };
    }

    writeFileSync(patchedPath, out);
    chmodSync(patchedPath, 0o755);
    await atomicSymlinkSwap(patchedPath, CLAUDE_SYMLINK);

    return { ok: true, patchedPath, replacements };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Revert: point ~/.local/bin/claude back at the original (non-patched) sibling
 * of whatever it's currently pointing at. Doesn't delete the patched file.
 */
export async function unpatch(): Promise<PatcherResult<{ target: string }>> {
  if (!existsSync(CLAUDE_SYMLINK)) {
    return { ok: false, error: `${CLAUDE_SYMLINK} does not exist` };
  }
  try {
    const { readlinkSync } = await import("node:fs");
    const link = readlinkSync(CLAUDE_SYMLINK);
    const linkAbs = link.startsWith("/") ? link : join(dirname(CLAUDE_SYMLINK), link);
    if (!linkAbs.endsWith(".patched")) {
      return { ok: false, error: "Current binary is not a patched copy; nothing to revert" };
    }
    const original = linkAbs.replace(/\.patched$/, "");
    if (!existsSync(original)) {
      return { ok: false, error: `Original binary missing at ${original}` };
    }
    await atomicSymlinkSwap(original, CLAUDE_SYMLINK);
    return { ok: true, target: original };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test-only: paths used by the module, so tests can override / inspect. */
export const _PATCHER_PATHS_FOR_TEST = {
  CLAUDE_SYMLINK_DIR,
  CLAUDE_SYMLINK,
  CLAUDE_VERSIONS_DIR,
  ORIGINAL_HOSTNAME,
  PATCHED_HOSTNAME,
  EXPECTED_OCCURRENCES,
};

/** Test-only: pure helpers exported separately so tests can hit them directly. */
export const _internalForTest = {
  countOccurrences,
};

// Re-export the constants used in patcher tests
export { PATCHED_BINARY_MARKER };
