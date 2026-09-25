import { spawn, type ChildProcess } from "node:child_process";
import { getEnrichedPath, resolveBinary } from "./path-resolver.js";

/**
 * Claude Code sign-in driven from the Companion UI.
 *
 * Unlike Codex (which exposes a structured `account/login/start` RPC with a
 * device code), the Claude CLI has no device-code flow. What it does have is
 * better suited to a remote box anyway: `claude auth login` prints an authorize
 * URL whose redirect_uri is Anthropic-hosted
 * (https://platform.claude.com/oauth/code/callback), not a localhost callback.
 * The user opens that URL anywhere, approves, and Anthropic shows them a code —
 * which the CLI then reads from stdin.
 *
 * So the flow we drive is:
 *   1. spawn `claude auth login --claudeai`, scrape the authorize URL
 *   2. hand the URL to the browser; the child stays alive waiting on stdin
 *   3. user pastes the code back into the UI; we write it to the child's stdin
 *   4. verify the outcome with `claude auth status --json`
 *
 * Step 4 matters: the CLI's success text is not a contract, but
 * `claude auth status --json` is machine-readable, so the authoritative answer
 * comes from re-reading state rather than parsing prose. A wrong code is
 * recoverable — the CLI re-prompts on the same process, so the user can paste
 * again without restarting.
 *
 * `claude setup-token` is deliberately not used: it produces no output on a
 * non-TTY and hangs, so it cannot be driven headlessly.
 */

/** Overall budget for one login attempt before we abandon the child. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
/** How long to wait for the authorize URL to show up on stdout. */
const URL_WAIT_MS = 30_000;
/** Budget for a short-lived `auth status` / `auth logout` invocation. */
const CLI_TIMEOUT_MS = 20_000;
/** How long to keep re-checking auth status after a code is submitted. */
const VERIFY_TIMEOUT_MS = 45_000;
const VERIFY_POLL_MS = 1_000;

export type ClaudeLoginState =
  | "idle"
  /** URL issued; waiting for the user to paste the code back. */
  | "awaiting_code"
  /** Code submitted; confirming with `auth status`. */
  | "verifying"
  | "success"
  | "error"
  | "canceled";

export interface ClaudeLoginStatus {
  state: ClaudeLoginState;
  /** The URL the user opens to approve. Present from `awaiting_code` on. */
  authUrl?: string;
  /**
   * Failure detail. On a rejected code this is set while state returns to
   * `awaiting_code`, so the UI can show the error and still accept a retry.
   */
  error?: string;
  /** Epoch ms after which the attempt is abandoned. */
  expiresAt?: number;
}

export interface ClaudeAccountStatus {
  cliAvailable: boolean;
  authenticated: boolean;
  /** `authMethod` as reported by the CLI, e.g. "claude.ai" or "console". */
  method: string | null;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  error?: string;
}

interface ActiveLogin {
  child: ChildProcess;
  status: ClaudeLoginStatus;
  timer: ReturnType<typeof setTimeout>;
  /** Everything stdout/stderr has produced, ANSI-stripped, for URL + error scraping. */
  output: string;
  /** Resolves once the authorize URL has been scraped. */
  onUrl?: (url: string) => void;
  /**
   * Unblocks a pending URL wait when the attempt dies first. Without this,
   * `startLogin` would sit on the full URL_WAIT_MS budget even though the child
   * has already exited and no URL can ever arrive.
   */
  onUrlAbort?: () => void;
  /** Set while a submitted code is being judged. */
  onCodeVerdict?: (err: string | null) => void;
}

let activeLogin: ActiveLogin | null = null;
/** Terminal result of the last attempt, so a poll after completion still sees it. */
let lastResult: ClaudeLoginStatus = { state: "idle" };

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Env for auth subprocesses.
 *
 * CLAUDE_CODE_OAUTH_TOKEN is stripped on purpose. It is a *separate* auth
 * mechanism (a token pasted into Settings and injected into sessions); if it
 * leaked in here, `auth status` would report that token's identity and mask the
 * stored login this panel manages — and post-code verification could report
 * success for a login that never actually landed.
 */
function authEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Never let a parent Claude session leak in (same hygiene as cli-launcher).
    CLAUDECODE: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    PATH: getEnrichedPath(),
  };
}

/** Run a short-lived `claude ...` invocation and collect stdout. */
function runClaude(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const binary = resolveBinary("claude");
    if (!binary) {
      resolve({ ok: false, stdout: "", stderr: "Claude CLI not found on PATH" });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env: authEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already dead */ }
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (e) => { stderr += String(e); finish(false); });
    child.on("exit", (code) => finish(code === 0));
  });
}

/** Read the current Claude account via `claude auth status --json`. */
export async function getAccountStatus(): Promise<ClaudeAccountStatus> {
  const base: ClaudeAccountStatus = {
    cliAvailable: true, authenticated: false, method: null,
    email: null, orgName: null, subscriptionType: null,
  };

  if (!resolveBinary("claude")) {
    return { ...base, cliAvailable: false, error: "Claude CLI not found on PATH" };
  }

  const { stdout, stderr } = await runClaude(["auth", "status", "--json"]);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout.replace(ANSI_RE, "").trim()) as Record<string, unknown>;
  } catch {
    return { ...base, error: stderr.trim() || "Could not read Claude auth status" };
  }

  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    ...base,
    authenticated: parsed.loggedIn === true,
    method: str(parsed.authMethod) === "none" ? null : str(parsed.authMethod),
    email: str(parsed.email),
    orgName: str(parsed.orgName),
    subscriptionType: str(parsed.subscriptionType),
  };
}

/** Current login status: the in-flight attempt, else the last terminal result. */
export function getLoginStatus(): ClaudeLoginStatus {
  return activeLogin ? { ...activeLogin.status } : { ...lastResult };
}

function killChild(child: ChildProcess): void {
  try { child.kill(); } catch { /* already dead */ }
}

function finishLogin(state: ClaudeLoginState, error?: string): void {
  if (!activeLogin) return;
  clearTimeout(activeLogin.timer);
  killChild(activeLogin.child);
  activeLogin.onUrlAbort?.();
  lastResult = { state, authUrl: activeLogin.status.authUrl, error };
  activeLogin = null;
}

/** Scrape the authorize URL out of CLI output. */
export function extractAuthUrl(output: string): string | null {
  const match = output.replace(ANSI_RE, "").match(/https?:\/\/[^\s]*oauth\/authorize\?[^\s]+/);
  return match ? match[0] : null;
}

/**
 * Start a login: spawn the CLI and return once the authorize URL is known.
 * Idempotent while an attempt is in flight — restarting would invalidate a URL
 * the user may already have open.
 */
export async function startLogin(): Promise<ClaudeLoginStatus> {
  if (activeLogin) return { ...activeLogin.status };

  const binary = resolveBinary("claude");
  if (!binary) throw new Error("Claude CLI not found on PATH");

  const child = spawn(binary, ["auth", "login", "--claudeai"], {
    env: authEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const login: ActiveLogin = {
    child,
    status: { state: "awaiting_code", expiresAt: Date.now() + LOGIN_TIMEOUT_MS },
    timer: setTimeout(
      () => finishLogin("error", "Sign-in timed out. Start again to get a fresh link."),
      LOGIN_TIMEOUT_MS,
    ),
    output: "",
  };
  activeLogin = login;

  const handleChunk = (chunk: Buffer) => {
    login.output += chunk.toString().replace(ANSI_RE, "");

    if (!login.status.authUrl) {
      const url = extractAuthUrl(login.output);
      if (url) {
        login.status.authUrl = url;
        login.onUrl?.(url);
      }
    }

    // The CLI re-prompts on a bad code, so this is recoverable: report it and
    // go back to awaiting_code rather than tearing the attempt down.
    if (login.onCodeVerdict && /Invalid code/i.test(login.output)) {
      const verdict = login.onCodeVerdict;
      login.onCodeVerdict = undefined;
      login.output = "";
      verdict("That code wasn't accepted. Make sure you copied all of it, then try again.");
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);
  child.on("error", (e) => finishLogin("error", e instanceof Error ? e.message : String(e)));
  child.on("exit", () => {
    // Exiting before we reached a terminal state means the login can't complete.
    if (activeLogin === login && login.status.state !== "verifying") {
      finishLogin("error", "Claude exited before sign-in completed");
    }
  });

  // Wait for the URL — without it there is nothing to show the user.
  const url = await new Promise<string | null>((resolve) => {
    if (login.status.authUrl) {
      resolve(login.status.authUrl);
      return;
    }
    const timer = setTimeout(() => resolve(null), URL_WAIT_MS);
    login.onUrl = (u) => { clearTimeout(timer); resolve(u); };
    login.onUrlAbort = () => { clearTimeout(timer); resolve(null); };
  });

  // The child may have died while we waited (handled by its exit/error hooks,
  // which already recorded the failure) — don't overwrite that reason.
  if (activeLogin !== login) return { ...lastResult };

  if (!url) {
    finishLogin("error", "Claude did not return a sign-in link. Check that the CLI is up to date.");
    return { ...lastResult };
  }

  return { ...login.status };
}

/**
 * Submit the code the user pasted. Resolves to `success`, or back to
 * `awaiting_code` with an error so they can retry on the same attempt.
 */
export async function submitCode(code: string): Promise<ClaudeLoginStatus> {
  const trimmed = code.trim();
  if (!trimmed) return { state: "awaiting_code", authUrl: activeLogin?.status.authUrl, error: "Enter the code first." };
  if (!activeLogin) return { ...lastResult, error: "No sign-in in progress. Start again." };

  const login = activeLogin;
  login.status.state = "verifying";
  delete login.status.error;
  login.output = "";

  const rejection = new Promise<string | null>((resolve) => { login.onCodeVerdict = resolve; });

  try {
    login.child.stdin?.write(trimmed + "\n");
  } catch {
    finishLogin("error", "Could not send the code to the Claude CLI.");
    return { ...lastResult };
  }

  // Race an explicit rejection against the CLI actually becoming logged in.
  // Status is the authoritative signal; the printed text is only a fast path.
  const verified = (async () => {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
      const account = await getAccountStatus();
      if (account.authenticated) return true;
      if (activeLogin !== login) return false; // canceled or timed out meanwhile
    }
    return false;
  })();

  const outcome = await Promise.race([
    rejection.then((err) => ({ kind: "rejected" as const, err })),
    verified.then((ok) => ({ kind: "verified" as const, ok })),
  ]);

  if (outcome.kind === "verified" && outcome.ok) {
    finishLogin("success");
    return { ...lastResult };
  }

  if (activeLogin !== login) return { ...lastResult };

  // Recoverable: keep the child alive so the user can paste a corrected code.
  login.status.state = "awaiting_code";
  login.status.error = outcome.kind === "rejected" && outcome.err
    ? outcome.err
    : "Couldn't confirm the sign-in. Check the code and try again.";
  return { ...login.status };
}

/** Abandon an in-flight login. */
export function cancelLogin(): ClaudeLoginStatus {
  if (!activeLogin) return { ...lastResult };
  finishLogin("canceled");
  return { ...lastResult };
}

/** Sign out via `claude auth logout`. */
export async function logout(): Promise<{ ok: boolean; error?: string }> {
  const { ok, stderr } = await runClaude(["auth", "logout"]);
  return ok ? { ok: true } : { ok: false, error: stderr.trim() || "Sign out failed" };
}

/** Test helper: drop all in-memory login state. */
export function _resetClaudeAuthState(): void {
  if (activeLogin) {
    clearTimeout(activeLogin.timer);
    killChild(activeLogin.child);
  }
  activeLogin = null;
  lastResult = { state: "idle" };
}
