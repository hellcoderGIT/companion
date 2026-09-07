import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildCodexAppServerSpawn } from "./codex-app-server.js";
import { DEFAULT_COMPANION_CODEX_HOME, getLegacyCodexHome } from "./codex-home.js";

/**
 * Codex ChatGPT-subscription login, driven from the Companion UI.
 *
 * Why device code: the plain `chatgpt` login type returns an OAuth `authUrl`
 * that redirects to a localhost callback owned by the Codex process. That only
 * works when the browser and the CLI are on the same machine, which is exactly
 * not the case for Companion (the whole point is driving a remote box from a
 * browser). `chatgptDeviceCode` instead returns a short user code plus a
 * verification URL, so the user can approve on whatever device their browser is
 * on. This removes the need to SSH in and run `codex login` by hand.
 *
 * Lifecycle: `account/login/start` needs the same app-server process to stay
 * alive until the login resolves, because Codex polls the device-code endpoint
 * internally and reports the outcome via the `account/login/completed`
 * notification. So we hold one child process for the duration of a login and
 * expose a pollable status, following the same poll-a-status-endpoint pattern
 * the image-pull and dashboard-run features already use.
 */

/** Device codes are short-lived upstream; give up well before that silently. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
/** Bound short-lived RPCs (account read/logout) so a wedged CLI can't hang a request. */
const RPC_TIMEOUT_MS = 15_000;

export type CodexLoginState = "idle" | "pending" | "success" | "error" | "canceled";

export interface CodexLoginStatus {
  state: CodexLoginState;
  /** The code the user types at `verificationUrl`. Present while pending. */
  userCode?: string;
  verificationUrl?: string;
  loginId?: string;
  error?: string;
  /** Epoch ms after which this attempt is abandoned. */
  expiresAt?: number;
}

export interface CodexAccountStatus {
  /** False when the codex binary can't be resolved at all. */
  cliAvailable: boolean;
  authenticated: boolean;
  /** How Codex is authenticated, when it is. */
  method: "chatgpt" | "apiKey" | null;
  email: string | null;
  planType: string | null;
  error?: string;
}

interface ActiveLogin {
  child: ChildProcess;
  status: CodexLoginStatus;
  timer: ReturnType<typeof setTimeout>;
}

let activeLogin: ActiveLogin | null = null;
/** Terminal result of the most recent attempt, so a poll after completion still sees it. */
let lastResult: CodexLoginStatus = { state: "idle" };

/**
 * Env for auth operations. Pinned to the real Codex home (~/.codex) because
 * that is the file cli-launcher seeds per-session Codex homes from, and what
 * `hasContainerCodexAuth()` probes. Writing anywhere else would produce a login
 * that appears to succeed but never reaches sessions.
 */
function authEnv(): Record<string, string | undefined> {
  return { CODEX_HOME: getLegacyCodexHome() };
}

/** Minimal newline-delimited JSON-RPC client over a spawned app-server. */
function createRpcClient(child: ChildProcess, onNotification?: (method: string, params: Record<string, unknown>) => void) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let buf = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(line); } catch { continue; }

      if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error.message || "Codex RPC error"));
          else waiter.resolve(msg.result);
        }
      } else if (msg.method) {
        onNotification?.(msg.method, msg.params || {});
      }
    }
  });

  const send = (obj: Record<string, unknown>) => {
    try { child.stdin?.write(JSON.stringify(obj) + "\n"); } catch { /* pipe closed */ }
  };

  const call = (method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex RPC "${method}" timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      send({ method, id, params: params ?? {} });
    });

  const rejectAll = (err: Error) => {
    for (const [, waiter] of pending) waiter.reject(err);
    pending.clear();
  };

  return { call, notify: (method: string, params?: unknown) => send({ method, params: params ?? {} }), rejectAll };
}

/** Spawn an app-server and complete the `initialize`/`initialized` handshake. */
async function startAppServer(onNotification?: (m: string, p: Record<string, unknown>) => void) {
  const plan = buildCodexAppServerSpawn("codex", authEnv());
  if (!plan) throw new Error("Codex CLI not found on PATH");

  const child = spawn(plan.cmd[0], plan.cmd.slice(1), { env: plan.env, stdio: ["pipe", "pipe", "ignore"] });
  const rpc = createRpcClient(child, onNotification);

  child.on("error", (e) => rpc.rejectAll(e instanceof Error ? e : new Error(String(e))));
  child.on("exit", () => rpc.rejectAll(new Error("Codex app-server exited")));

  await rpc.call("initialize", {
    clientInfo: { name: "thecompanion", title: "The Companion", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized", {});
  return { child, rpc };
}

function killChild(child: ChildProcess): void {
  try { child.kill(); } catch { /* already dead */ }
}

/**
 * After a successful login, push the fresh auth.json into Codex homes that were
 * already materialised for existing sessions. cli-launcher only seeds auth.json
 * when the destination is absent, so without this an existing session would
 * keep using the stale (or missing) credentials it was created with.
 */
export function propagateAuthToSessionHomes(): number {
  const src = join(getLegacyCodexHome(), "auth.json");
  if (!existsSync(src)) return 0;

  let copied = 0;
  let entries: string[];
  try {
    entries = readdirSync(DEFAULT_COMPANION_CODEX_HOME);
  } catch {
    return 0; // No per-session homes yet.
  }

  for (const entry of entries) {
    const dir = join(DEFAULT_COMPANION_CODEX_HOME, entry);
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(src, join(dir, "auth.json"));
      copied++;
    } catch {
      // Best effort: one unwritable session home must not fail the login.
    }
  }
  return copied;
}

/** Current login status (in-flight attempt, else the last terminal result). */
export function getLoginStatus(): CodexLoginStatus {
  return activeLogin ? { ...activeLogin.status } : { ...lastResult };
}

function finishLogin(state: CodexLoginState, error?: string): void {
  if (!activeLogin) return;
  clearTimeout(activeLogin.timer);
  killChild(activeLogin.child);
  lastResult = { ...activeLogin.status, state, error };
  delete lastResult.expiresAt;
  activeLogin = null;
  if (state === "success") propagateAuthToSessionHomes();
}

/**
 * Begin a ChatGPT device-code login. Idempotent while one is in flight: a
 * second call returns the same code rather than orphaning the first child
 * process and invalidating a code the user may already be typing.
 */
export async function startDeviceLogin(): Promise<CodexLoginStatus> {
  if (activeLogin) return { ...activeLogin.status };

  const { child, rpc } = await startAppServer((method, params) => {
    if (method !== "account/login/completed") return;
    if (!activeLogin) return;
    // Ignore results for a superseded attempt.
    const loginId = typeof params.loginId === "string" ? params.loginId : undefined;
    if (loginId && activeLogin.status.loginId && loginId !== activeLogin.status.loginId) return;

    if (params.success === true) finishLogin("success");
    else finishLogin("error", typeof params.error === "string" ? params.error : "Login was not completed");
  });

  let result: { loginId?: string; userCode?: string; verificationUrl?: string };
  try {
    result = (await rpc.call("account/login/start", { type: "chatgptDeviceCode" })) as typeof result;
  } catch (e) {
    killChild(child);
    throw e;
  }

  if (!result?.userCode || !result?.verificationUrl) {
    killChild(child);
    throw new Error("Codex did not return a device code. Update the Codex CLI and try again.");
  }

  const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
  activeLogin = {
    child,
    status: {
      state: "pending",
      loginId: result.loginId,
      userCode: result.userCode,
      verificationUrl: result.verificationUrl,
      expiresAt,
    },
    timer: setTimeout(() => finishLogin("error", "Login timed out. Start a new login and try again."), LOGIN_TIMEOUT_MS),
  };

  // A child that dies before completing means the login can never resolve.
  child.on("exit", () => {
    if (activeLogin?.child === child) finishLogin("error", "Codex exited before the login completed");
  });

  return { ...activeLogin.status };
}

/** Cancel an in-flight login, telling Codex to stop polling before we kill it. */
export async function cancelLogin(): Promise<CodexLoginStatus> {
  if (!activeLogin) return { ...lastResult };
  finishLogin("canceled");
  return { ...lastResult };
}

/** Read the current Codex account, spawning a short-lived app-server. */
export async function getAccountStatus(): Promise<CodexAccountStatus> {
  const base: CodexAccountStatus = {
    cliAvailable: true, authenticated: false, method: null, email: null, planType: null,
  };

  if (!buildCodexAppServerSpawn("codex", authEnv())) {
    return { ...base, cliAvailable: false, error: "Codex CLI not found on PATH" };
  }

  let child: ChildProcess | null = null;
  try {
    const started = await startAppServer();
    child = started.child;
    const res = (await started.rpc.call("account/read", {})) as {
      account?: { type?: string; email?: string; planType?: string } | null;
    };
    const account = res?.account;
    if (!account?.type) return base;
    return {
      ...base,
      authenticated: true,
      method: account.type === "apiKey" ? "apiKey" : "chatgpt",
      email: account.email ?? null,
      planType: account.planType ?? null,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (child) killChild(child);
  }
}

/** Sign the current Codex account out. */
export async function logout(): Promise<{ ok: boolean; error?: string }> {
  let child: ChildProcess | null = null;
  try {
    const started = await startAppServer();
    child = started.child;
    await started.rpc.call("account/logout", {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (child) killChild(child);
  }
}

/** Test helper: drop all in-memory login state. */
export function _resetCodexAuthState(): void {
  if (activeLogin) {
    clearTimeout(activeLogin.timer);
    killChild(activeLogin.child);
  }
  activeLogin = null;
  lastResult = { state: "idle" };
}
