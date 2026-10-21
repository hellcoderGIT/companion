import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";

/**
 * Live Claude Code model discovery.
 *
 * The Claude Code CLI reports its own model catalogue in the response to the
 * one-time `initialize` control_request of the stdio stream-json protocol
 * (`response.response.models`). That list is what the CLI's own `/model`
 * picker shows — it already reflects the installed CLI version, the user's
 * account/plan, and any `availableModels` restriction in settings. Reading it
 * means a new model (e.g. a future Fable) shows up in the Companion as soon as
 * the CLI is upgraded, without shipping a new Companion release.
 *
 * The frontend keeps a static CLAUDE_MODELS list purely as a fallback for when
 * the CLI is missing or the probe fails.
 */

/** A Claude model as surfaced to the frontend model picker (`/backends/claude/models`). */
export interface ClaudeModelOption {
  /** Concrete model ID passed to `--model` / `set_model` (e.g. "claude-opus-5-5"). */
  value: string;
  label: string;
  description: string;
  /** True for the model the CLI resolves its "default" alias to. */
  isDefault?: boolean;
  /**
   * Effort levels the CLI accepts for this model (`--effort`). Empty array means
   * the model has no effort control (e.g. Haiku 4.5).
   */
  efforts: string[];
}

/** Raw entry shape from the CLI's initialize response `models` array (only fields we use). */
interface ClaudeInitModelEntry {
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/**
 * Parse the `models` array of a Claude CLI initialize response into picker
 * options. Pure (no I/O) so it can be unit-tested against recorded payloads.
 *
 * - Entries are keyed by their concrete `resolvedModel` ID rather than the
 *   alias (`opus`, `fable`, ...). Aliases float to newer models on CLI
 *   upgrade; storing a concrete ID keeps existing sessions, crons and agents
 *   pinned to the model the user actually picked.
 * - The `default` alias entry is dropped (it duplicates a real model) but the
 *   model it resolves to is flagged `isDefault` and floated to the top so the
 *   picker's default selection matches the CLI's recommendation.
 * - Duplicates (alias + explicit ID resolving to the same model) keep the
 *   first occurrence, which is the alias entry with the nicer display name.
 */
export function parseClaudeInitModels(models: unknown): ClaudeModelOption[] {
  if (!Array.isArray(models)) return [];

  let defaultId: string | undefined;
  const seen = new Set<string>();
  const options: ClaudeModelOption[] = [];

  for (const raw of models as ClaudeInitModelEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = raw.resolvedModel || raw.value;
    if (!id || typeof id !== "string") continue;
    if (raw.value === "default") {
      defaultId = id;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      value: id,
      label: raw.displayName || id,
      description: raw.description || "",
      efforts: raw.supportsEffort && Array.isArray(raw.supportedEffortLevels)
        ? raw.supportedEffortLevels.filter((e): e is string => typeof e === "string")
        : [],
    });
  }

  for (const o of options) {
    if (o.value === defaultId) o.isDefault = true;
  }
  options.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
  return options;
}

// Cache keyed by the resolved binary path + its mtime, so a CLI upgrade
// (which replaces the binary) invalidates the cache immediately. The TTL only
// covers account/settings changes that alter the list without an upgrade,
// which are rare — 12h keeps probe spawns (and any SessionStart hooks they
// trigger) to a couple per day.
const MODELS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const modelsCache = new Map<string, { at: number; models: ClaudeModelOption[] }>();

/** Clear the in-memory model cache (test helper). */
export function _resetClaudeModelsCache(): void {
  modelsCache.clear();
}

function cacheKeyFor(binaryPath: string): string {
  try {
    return `${binaryPath}@${statSync(binaryPath).mtimeMs}`;
  } catch {
    return binaryPath;
  }
}

/**
 * Fetch the Claude Code CLI's model list by briefly spawning it in stdio
 * stream-json mode and sending only the `initialize` control_request. No user
 * message is sent, so no API request is made and no tokens are spent.
 *
 * Returns an empty array on any failure (binary missing, timeout, malformed
 * response) so callers can fall back to the static list.
 */
export async function fetchClaudeModels(opts: { binary?: string; timeoutMs?: number } = {}): Promise<ClaudeModelOption[]> {
  const binaryPath = resolveBinary(opts.binary || "claude");
  if (!binaryPath) return [];
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const key = cacheKeyFor(binaryPath);
  const cached = modelsCache.get(key);
  if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
    return cached.models;
  }

  const REQUEST_ID = "companion-models-probe";

  return new Promise<ClaudeModelOption[]>((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (models: ClaudeModelOption[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child?.kill(); } catch { /* already dead */ }
      if (models.length > 0) modelsCache.set(key, { at: Date.now(), models });
      resolvePromise(models);
    };

    try {
      child = spawn(binaryPath, [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        // Don't write a session transcript for this throwaway probe, and skip
        // MCP server startup — neither is needed to read the model list.
        "--no-session-persistence",
        "--strict-mcp-config",
      ], {
        // Neutral cwd so project-level settings/hooks of whatever directory the
        // server was started in don't apply; user settings still do.
        cwd: homedir(),
        env: { ...process.env, CLAUDECODE: undefined, PATH: getEnrichedPath() },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolvePromise([]);
      return;
    }

    timer = setTimeout(() => finish([]), timeoutMs);

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: { type?: string; response?: { subtype?: string; request_id?: string; response?: { models?: unknown } } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== "control_response" || msg.response?.request_id !== REQUEST_ID) continue;
        finish(msg.response.subtype === "success" ? parseClaudeInitModels(msg.response.response?.models) : []);
        return;
      }
    });

    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));

    try {
      child.stdin?.write(JSON.stringify({
        type: "control_request",
        request_id: REQUEST_ID,
        request: { subtype: "initialize" },
      }) + "\n");
    } catch {
      finish([]);
    }
  });
}
