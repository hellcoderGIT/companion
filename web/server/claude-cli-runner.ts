import { tmpdir } from "node:os";
import { getEnrichedPath, resolveBinary } from "./path-resolver.js";
import { getSettings } from "./settings-manager.js";

// ─── Headless one-shot Claude CLI runner ────────────────────────────────────
// Runs `claude --print` the same way cli-launcher spawns interactive sessions:
// same binary resolution, same enriched PATH, same CLAUDE_CODE_OAUTH_TOKEN
// injection from settings. This means background features (like the dashboard
// summarizer) authenticate with the user's normal Claude Code login instead of
// needing a separate Anthropic API key — but without creating a visible
// companion session per invocation.

export function isClaudeCliAvailable(): boolean {
  return resolveBinary("claude") !== null;
}

export interface RunClaudePromptOptions {
  prompt: string;
  /** Model id or alias passed to --model. Omitted = CLI default. */
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Runs one prompt through `claude --print` and returns the plain-text answer,
 * or null on any failure (missing binary, non-zero exit, timeout).
 */
export async function runClaudePrompt(options: RunClaudePromptOptions): Promise<string | null> {
  const binary = resolveBinary("claude");
  if (!binary) {
    console.warn("[claude-cli-runner] Claude CLI not found in PATH");
    return null;
  }

  const args = [binary, "--print", "--output-format", "text"];
  if (options.model?.trim()) {
    args.push("--model", options.model.trim());
  }

  const settings = getSettings();
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Same hygiene as cli-launcher: never let a parent Claude session leak in.
    CLAUDECODE: undefined,
    PATH: getEnrichedPath(),
  };
  if (settings.claudeCodeOAuthToken && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeCodeOAuthToken;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc?.kill();
  }, timeoutMs);

  try {
    proc = Bun.spawn(args, {
      // Neutral cwd so the CLI doesn't pull a project's CLAUDE.md into context.
      cwd: tmpdir(),
      env,
      stdin: new TextEncoder().encode(options.prompt),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (timedOut) {
      console.warn(`[claude-cli-runner] Prompt timed out after ${timeoutMs}ms`);
      return null;
    }
    if (exitCode !== 0) {
      console.warn(`[claude-cli-runner] claude --print exited with ${exitCode}: ${stderr.slice(0, 500)}`);
      return null;
    }
    return stdout;
  } catch (err) {
    console.warn("[claude-cli-runner] Failed to run claude --print:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
