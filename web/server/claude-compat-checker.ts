/**
 * Periodic detection of the installed Claude Code CLI version and its
 * compatibility with the companion's --sdk-url-based bridge.
 *
 * Mirrors update-checker.ts in shape: lazy initial check after a short delay,
 * then refresh every CHECK_INTERVAL_MS. State is exposed via getCompatState().
 */

import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getEnrichedPath, resolveBinary } from "./path-resolver.js";
import {
  type ClaudeVersion,
  formatVersion,
  isIncompatibleVersion,
  parseClaudeVersion,
  pickPinTarget,
} from "./claude-versions.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 5_000; // 5s after boot — fast enough to surface on first paint

/**
 * Marker string that the byte-replace patcher writes into the binary in place
 * of `claude-staging.fedstart.com`. Same byte length (27). When present in
 * the binary at the resolved symlink, the binary is "patched" and the
 * companion should be running in TLS-bridge mode.
 */
export const PATCHED_BINARY_MARKER = "[000:000:000:000:000:0:0:1]";

export interface CompatState {
  /** Stringified version of the binary that `claude` currently resolves to, e.g. "2.1.142". */
  installedVersion: string | null;
  /** Absolute path the `claude` shim/symlink resolves to. */
  installedPath: string | null;
  /** True if installed version is >= 2.1.121 AND not already patched. */
  isIncompatible: boolean;
  /** True if the resolved binary contains the patcher's marker bytes. */
  isPatched: boolean;
  /** Versions found under ~/.local/share/claude/versions/ that are still known-good. */
  availableKnownGood: string[];
  /** Best version to pin to (or null if no cached known-good exists). */
  suggestedPinTarget: string | null;
  /** ms epoch of last successful refresh. 0 means never. */
  lastChecked: number;
  /** Most recent error during version detection, if any. */
  error: string | null;
}

const state: CompatState = {
  installedVersion: null,
  installedPath: null,
  isIncompatible: false,
  isPatched: false,
  availableKnownGood: [],
  suggestedPinTarget: null,
  lastChecked: 0,
  error: null,
};

let checking = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

export function getCompatState(): Readonly<CompatState> {
  return { ...state, availableKnownGood: [...state.availableKnownGood] };
}

/** Run `claude --version` and return the trimmed first line of stdout. */
async function spawnVersion(binary: string): Promise<string> {
  const proc = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: getEnrichedPath() },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`exit ${exitCode}: ${stderr.trim() || "no stderr"}`);
  }
  const out = await new Response(proc.stdout).text();
  return out.trim();
}

/**
 * Resolve the absolute file path the `claude` binary on PATH refers to.
 * Anthropic's installer puts a symlink in ~/.local/bin pointing into
 * ~/.local/share/claude/versions/<version>. The companion patcher can also
 * insert a `.patched` link in the chain. Walk lstat-based hops so we can
 * tell symlinks from real files (statSync transparently follows symlinks
 * and would always report isSymbolicLink() === false).
 */
function resolveClaudeTarget(): string | null {
  const onPath = resolveBinary("claude");
  if (!onPath) return null;
  let current = onPath;
  for (let i = 0; i < 16; i++) {
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return null;
    }
    if (st.isFile()) return current;
    if (!st.isSymbolicLink()) return null;
    const target = readlinkSync(current);
    current = target.startsWith("/") ? target : join(dirname(current), target);
  }
  return null;
}

/**
 * Scan ~/.local/share/claude/versions/<X.Y.Z> directory entries and parse
 * each filename as a version. Some entries may be ".patched" copies the
 * companion produced — skip those.
 */
function listCachedVersions(): ClaudeVersion[] {
  const versionsDir = join(homedir(), ".local", "share", "claude", "versions");
  if (!existsSync(versionsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return [];
  }
  const out: ClaudeVersion[] = [];
  for (const name of entries) {
    if (name.endsWith(".patched")) continue;
    const parsed = parseClaudeVersion(name);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Detect whether the binary at `path` has been patched.
 *
 * The marker bytes can live anywhere in the binary — in observed Claude 2.1.142
 * builds, the closest occurrence is at offset ~166 MB out of 232 MB. A
 * naive head-of-file slice misses it, so we stream the whole file in
 * chunks and scan for the marker with boundary-safe leftover buffering.
 * Returns true on the first match (early exit), so the typical cost is
 * O(file size) only in the cold case where the binary is unpatched.
 *
 * Filename suffix is checked first as a fast-path: a binary at `<name>.patched`
 * is almost certainly patched, and avoids the streaming scan in the common
 * case where the symlink chain ends at our patcher's output.
 */
async function detectPatched(path: string): Promise<boolean> {
  try {
    if (path.endsWith(".patched")) return true; // fast path
    const file = Bun.file(path);
    if (!(await file.exists())) return false;

    const marker = new TextEncoder().encode(PATCHED_BINARY_MARKER);
    const markerLen = marker.length;
    let leftover = new Uint8Array(0);

    // ReadableStream isn't typed as async-iterable in lib.dom, so use the
    // explicit reader API. Bun yields Uint8Array chunks (typically ~64 KiB).
    // We join with the previous chunk's tail so a marker that straddles a
    // chunk boundary still matches.
    const reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const combined = new Uint8Array(leftover.length + value.length);
      combined.set(leftover, 0);
      combined.set(value, leftover.length);

      outer: for (let i = 0; i + markerLen <= combined.length; i++) {
        for (let j = 0; j < markerLen; j++) {
          if (combined[i + j] !== marker[j]) continue outer;
        }
        reader.cancel().catch(() => {});
        return true;
      }
      // Keep the trailing (markerLen - 1) bytes so a marker spanning the
      // next chunk boundary still matches.
      leftover = markerLen > 1
        ? combined.subarray(combined.length - (markerLen - 1))
        : new Uint8Array(0);
    }
    return false;
  } catch {
    return false;
  }
}

export async function checkCompat(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const installedPath = resolveClaudeTarget();
    if (!installedPath) {
      state.installedPath = null;
      state.installedVersion = null;
      state.isIncompatible = false;
      state.isPatched = false;
      state.availableKnownGood = [];
      state.suggestedPinTarget = null;
      state.error = "claude binary not found in PATH";
      state.lastChecked = Date.now();
      return;
    }
    state.installedPath = installedPath;

    const versionOut = await spawnVersion(installedPath).catch((err: Error) => {
      state.error = err.message;
      return "";
    });
    const parsed = parseClaudeVersion(versionOut);
    state.installedVersion = parsed ? formatVersion(parsed) : null;
    state.error = parsed ? null : state.error || `could not parse version from "${versionOut}"`;

    const patched = await detectPatched(installedPath);
    state.isPatched = patched;

    // A binary is "incompatible" only if it's on the lockdown side AND not patched.
    // Patched binaries accept wss://[::1]:<port> so they're functional again.
    state.isIncompatible = parsed ? isIncompatibleVersion(parsed) && !patched : false;

    const cached = listCachedVersions();
    const knownGoodOnly = cached
      .filter((v) => !isIncompatibleVersion(v))
      .sort((a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch));
    state.availableKnownGood = knownGoodOnly.map(formatVersion);
    const pinTarget = pickPinTarget(cached);
    state.suggestedPinTarget = pinTarget ? formatVersion(pinTarget) : null;

    state.lastChecked = Date.now();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    checking = false;
  }
}

export function startPeriodicCheck(): void {
  setTimeout(() => { void checkCompat(); }, INITIAL_DELAY_MS);
  intervalId = setInterval(() => { void checkCompat(); }, CHECK_INTERVAL_MS);
}

export function stopPeriodicCheck(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/** Test-only: reset module state. */
export function _resetForTest(): void {
  state.installedVersion = null;
  state.installedPath = null;
  state.isIncompatible = false;
  state.isPatched = false;
  state.availableKnownGood = [];
  state.suggestedPinTarget = null;
  state.lastChecked = 0;
  state.error = null;
  checking = false;
}
