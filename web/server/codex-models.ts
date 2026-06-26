import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { getEnrichedPath, resolveBinary } from "./path-resolver.js";

/**
 * A Codex model as surfaced to the frontend model picker.
 * Shape matches the `/backends/:id/models` response contract that the UI's
 * `toModelOptions` helper consumes ({ value, label, description }).
 */
export interface CodexModelOption {
  value: string;
  label: string;
  description: string;
  /** True for the model Codex marks as its default (`isDefault`). */
  isDefault?: boolean;
}

/**
 * Raw entry shape from the Codex app-server `model/list` RPC. Only the fields
 * we care about are typed; the payload carries many more (see the generated
 * protocol bindings under web/server/protocol/codex-upstream).
 */
interface CodexModelListEntry {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
}

/**
 * Parse the `result` payload of a Codex `model/list` response into the UI
 * model-option shape. Hidden models are filtered out; the default model is
 * floated to the top so it becomes the picker's default selection.
 *
 * Pure (no I/O) so it can be unit-tested against recorded payloads.
 */
export function parseCodexModelList(result: unknown): CodexModelOption[] {
  const data = (result as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const options: CodexModelOption[] = [];
  for (const raw of data as CodexModelListEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.hidden === true) continue;
    const value = raw.id || raw.model;
    if (!value) continue;
    options.push({
      value,
      label: raw.displayName || value,
      description: raw.description || "",
      isDefault: raw.isDefault === true,
    });
  }

  // Float the default model to the top so getDefaultModel() picks it.
  options.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return options;
}

// In-memory cache so repeated picker loads don't respawn Codex every time.
// Codex's model catalog only changes on CLI upgrade, so a few minutes is safe.
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const modelsCache = new Map<string, { at: number; models: CodexModelOption[] }>();

/** Clear the in-memory model cache (test helper). */
export function _resetCodexModelsCache(): void {
  modelsCache.clear();
}

/**
 * Build the spawn command for `codex app-server`, resolving the binary and
 * applying the same sibling-node shim that cli-launcher uses so a CLI shipped
 * with a bundled node still launches correctly.
 */
function buildCodexSpawn(binaryName: string): { cmd: string[]; env: NodeJS.ProcessEnv } | null {
  const resolved = resolveBinary(binaryName);
  if (!resolved) return null;

  const binaryDir = resolve(resolved, "..");
  const siblingNode = join(binaryDir, "node");
  const enrichedPath = getEnrichedPath();
  const pathSep = process.platform === "win32" ? ";" : ":";
  const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

  // `model/list` does not require auth or a sandbox, so we skip --enable flags
  // and run a bare app-server purely for the handshake + listing.
  const args = ["app-server"];

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
    const isCmdScript = process.platform === "win32" && (resolved.endsWith(".cmd") || resolved.endsWith(".bat"));
    cmd = isCmdScript ? ["cmd.exe", "/c", resolved, ...args] : [resolved, ...args];
  }

  return {
    cmd,
    env: { ...process.env, CLAUDECODE: undefined, PATH: spawnPath },
  };
}

/**
 * Fetch the list of available Codex models by briefly launching
 * `codex app-server`, performing the initialize handshake, and calling the
 * `model/list` RPC. Replaces the legacy `~/.codex/models_cache.json` reader —
 * recent Codex releases no longer write that file and serve models over the
 * app-server protocol instead.
 *
 * Returns an empty array on any failure (binary missing, timeout, RPC error)
 * so callers can fall back to a static list.
 */
export async function fetchCodexModels(opts: { binary?: string; timeoutMs?: number } = {}): Promise<CodexModelOption[]> {
  const binaryName = opts.binary || "codex";
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const cached = modelsCache.get(binaryName);
  if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
    return cached.models;
  }

  const spawnInfo = buildCodexSpawn(binaryName);
  if (!spawnInfo) return [];

  return new Promise<CodexModelOption[]>((resolvePromise) => {
    let settled = false;
    const finish = (models: CodexModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already dead */ }
      if (models.length > 0) modelsCache.set(binaryName, { at: Date.now(), models });
      resolvePromise(models);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spawnInfo.cmd[0], spawnInfo.cmd.slice(1), {
        env: spawnInfo.env,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolvePromise([]);
      return;
    }

    const timer = setTimeout(() => finish([]), timeoutMs);

    const send = (obj: Record<string, unknown>) => {
      try { child.stdin?.write(JSON.stringify(obj) + "\n"); } catch { /* pipe closed */ }
    };

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; result?: unknown };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          // initialize acknowledged → complete handshake and request models
          send({ method: "initialized", params: {} });
          send({ method: "model/list", id: 2, params: {} });
        } else if (msg.id === 2) {
          finish(parseCodexModelList(msg.result));
          return;
        }
      }
    });

    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));

    // Kick off the handshake.
    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "thecompanion", title: "The Companion", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
