import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { getEnrichedPath, resolveBinary } from "./path-resolver.js";

/** A resolved plan for spawning `codex app-server`. */
export interface CodexAppServerSpawnPlan {
  /** argv[0] plus arguments, ready for `spawn(cmd[0], cmd.slice(1))`. */
  cmd: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Build the spawn command for `codex app-server`, resolving the binary and
 * applying the sibling-node shim that cli-launcher uses so a CLI shipped with a
 * bundled node still launches correctly.
 *
 * Extracted from codex-models.ts so the auth flow (codex-auth.ts) can reuse the
 * exact same binary resolution instead of duplicating it. `extraEnv` lets a
 * caller pin CODEX_HOME (the auth flow must write to the real ~/.codex rather
 * than a per-session Companion home).
 *
 * Returns null when the binary cannot be resolved.
 */
export function buildCodexAppServerSpawn(
  binaryName: string,
  extraEnv?: Record<string, string | undefined>,
  extraArgs: string[] = [],
): CodexAppServerSpawnPlan | null {
  const resolved = resolveBinary(binaryName);
  if (!resolved) return null;

  const binaryDir = resolve(resolved, "..");
  const siblingNode = join(binaryDir, "node");
  const enrichedPath = getEnrichedPath();
  const pathSep = process.platform === "win32" ? ";" : ":";
  const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

  const args = ["app-server", ...extraArgs];

  let cmd: string[];
  if (existsSync(siblingNode)) {
    let codexScript: string;
    try {
      codexScript = realpathSync(resolved);
    } catch {
      codexScript = resolved;
    }
    cmd = [siblingNode, codexScript, ...args];
  } else {
    const isCmdScript = process.platform === "win32"
      && (resolved.endsWith(".cmd") || resolved.endsWith(".bat"));
    cmd = isCmdScript ? ["cmd.exe", "/c", resolved, ...args] : [resolved, ...args];
  }

  return {
    cmd,
    // CLAUDECODE is stripped so Codex does not think it is running nested
    // inside a Claude Code session.
    env: { ...process.env, CLAUDECODE: undefined, PATH: spawnPath, ...extraEnv },
  };
}
