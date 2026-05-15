/**
 * Periodic detection of the installed Claude Code CLI version and its
 * compatibility with the companion's --sdk-url-based bridge.
 *
 * Mirrors update-checker.ts in shape: lazy initial check after a short delay,
 * then refresh every CHECK_INTERVAL_MS. State is exposed via getCompatState().
 */

import { existsSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
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
 * ~/.local/share/claude/versions/<version>. Returns the final target file
 * after resolving one level of symlink.
 */
function resolveClaudeTarget(): string | null {
  const onPath = resolveBinary("claude");
  if (!onPath) return null;
  try {
    const st = statSync(onPath);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(onPath);
      return target.startsWith("/") ? target : join(onPath, "..", target);
    }
    return onPath;
  } catch {
    return onPath;
  }
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
 * Reads up to FIRST_CHUNK_BYTES from the start of the file and looks for the
 * marker string. Cheap — the marker lives in a constant section near other
 * string literals, typically within the first 256 MiB; we only read 32 MiB
 * to keep this fast, which empirically covers it.
 */
const PATCH_DETECT_BYTES = 32 * 1024 * 1024;
async function detectPatched(path: string): Promise<boolean> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return false;
    const slice = file.slice(0, Math.min(file.size, PATCH_DETECT_BYTES));
    const text = await slice.text();
    return text.includes(PATCHED_BINARY_MARKER);
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
