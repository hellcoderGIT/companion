/**
 * Claude Code CLI version detection and compatibility.
 *
 * Claude Code 2.1.121 (~2026-04-27) added a static hostname allowlist to the
 * --sdk-url flag, breaking every third-party tool that bridges sessions to a
 * local server. The validator (function `YR4`, set `KU5` in the bundle)
 * accepts only:
 *   api.anthropic.com, api-staging.anthropic.com,
 *   beacon.claude-ai.staging.ant.dev, claude.fedstart.com,
 *   claude-staging.fedstart.com
 * and only with wss:// or https:// schemes. No env-var override exists.
 *
 * Last known working version: 2.1.120.
 * First broken version: 2.1.121.
 */

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Last Claude Code CLI version that accepts arbitrary --sdk-url targets. */
export const KNOWN_GOOD_MAX: ClaudeVersion = { major: 2, minor: 1, patch: 120 };

/** First Claude Code CLI version that rejects non-Anthropic --sdk-url hosts. */
export const KNOWN_BAD_MIN: ClaudeVersion = { major: 2, minor: 1, patch: 121 };

/**
 * Parse the output of `claude --version`, which looks like:
 *   "2.1.142 (Claude Code)"
 * or sometimes (older builds):
 *   "Claude Code 2.1.119"
 */
export function parseClaudeVersion(raw: string): ClaudeVersion | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Returns -1 / 0 / 1 like Array.sort. */
export function compareVersions(a: ClaudeVersion, b: ClaudeVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export function formatVersion(v: ClaudeVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** True if the version is on or after the lockdown (2.1.121+). */
export function isIncompatibleVersion(v: ClaudeVersion): boolean {
  return compareVersions(v, KNOWN_BAD_MIN) >= 0;
}

/** True if the version is at or below 2.1.120 (accepts arbitrary --sdk-url). */
export function isKnownGoodVersion(v: ClaudeVersion): boolean {
  return compareVersions(v, KNOWN_GOOD_MAX) <= 0;
}

/**
 * Pick the best version to roll back to from a list of cached versions.
 * Returns the highest version that's still known-good (<= 2.1.120),
 * or null if none of the candidates qualify.
 */
export function pickPinTarget(candidates: ClaudeVersion[]): ClaudeVersion | null {
  const good = candidates.filter(isKnownGoodVersion);
  if (good.length === 0) return null;
  return good.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}
