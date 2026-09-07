import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Tests for the Codex ChatGPT device-code login manager.
 *
 * The manager drives a real `codex app-server` child process over newline
 * delimited JSON-RPC, so these tests stub the spawn boundary with a fake child
 * that speaks the same framing. That lets us assert the state machine
 * (pending → success/error/canceled), idempotency, and the auth propagation
 * behaviour without needing an authenticated Codex install.
 */

const spawnMock = vi.fn();
const buildSpawnMock = vi.fn(() => ({ cmd: ["codex", "app-server"], env: {} }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./codex-app-server.js", () => ({ buildCodexAppServerSpawn: buildSpawnMock }));

/** A fake `codex app-server` child speaking NDJSON JSON-RPC. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin: { write: (chunk: string) => boolean };
  killed = false;
  /** Every request the manager sent, parsed. */
  sent: Array<{ method: string; id?: number; params?: unknown }> = [];
  /** Response factories keyed by method; return undefined to stay silent. */
  responders: Record<string, (params: unknown) => unknown> = {};

  constructor() {
    super();
    this.stdin = {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          this.sent.push(msg);
          if (msg.method === "initialize") {
            this.reply(msg.id, { userAgent: "test" });
          } else if (this.responders[msg.method]) {
            const result = this.responders[msg.method](msg.params);
            if (result !== undefined && typeof msg.id === "number") this.reply(msg.id, result);
          }
        }
        return true;
      },
    };
  }

  reply(id: number, result: unknown): void {
    // Async so the manager's promise handlers are already attached.
    setImmediate(() => this.stdout.write(JSON.stringify({ id, result }) + "\n"));
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(JSON.stringify({ method, params }) + "\n");
  }

  kill(): void {
    this.killed = true;
  }
}

let child: FakeChild;
let auth: typeof import("./codex-auth.js");

/** Poll until `predicate` holds, so we don't rely on fixed sleeps. */
async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Condition not met in time");
}

const DEVICE_CODE_RESULT = {
  type: "chatgptDeviceCode",
  loginId: "login-1",
  userCode: "ABCD-1234",
  verificationUrl: "https://auth.openai.com/codex/device",
};

beforeEach(async () => {
  vi.resetModules();
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => child);
  buildSpawnMock.mockReturnValue({ cmd: ["codex", "app-server"], env: {} });
  auth = await import("./codex-auth.js");
});

afterEach(() => {
  auth._resetCodexAuthState();
});

describe("startDeviceLogin", () => {
  it("returns the device code and enters the pending state", async () => {
    child.responders["account/login/start"] = () => DEVICE_CODE_RESULT;

    const status = await auth.startDeviceLogin();

    expect(status.state).toBe("pending");
    expect(status.userCode).toBe("ABCD-1234");
    expect(status.verificationUrl).toBe("https://auth.openai.com/codex/device");
    // Device code must be requested explicitly — the plain `chatgpt` type would
    // use a localhost OAuth callback, which breaks for a remote server.
    const start = child.sent.find((m) => m.method === "account/login/start");
    expect(start?.params).toEqual({ type: "chatgptDeviceCode" });
  });

  it("is idempotent while a login is in flight so the user's code stays valid", async () => {
    child.responders["account/login/start"] = () => DEVICE_CODE_RESULT;

    const first = await auth.startDeviceLogin();
    const second = await auth.startDeviceLogin();

    expect(second).toEqual(first);
    // Only one app-server spawned: a second spawn would orphan the first child
    // and invalidate a code the user may already be typing.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("transitions to success when Codex reports login completed", async () => {
    child.responders["account/login/start"] = () => DEVICE_CODE_RESULT;
    await auth.startDeviceLogin();

    child.notify("account/login/completed", { loginId: "login-1", success: true });

    await until(() => auth.getLoginStatus().state === "success");
    expect(child.killed).toBe(true);
  });

  it("surfaces the upstream error message when login fails", async () => {
    child.responders["account/login/start"] = () => DEVICE_CODE_RESULT;
    await auth.startDeviceLogin();

    child.notify("account/login/completed", {
      loginId: "login-1", success: false, error: "Login was not completed",
    });

    await until(() => auth.getLoginStatus().state === "error");
    expect(auth.getLoginStatus().error).toBe("Login was not completed");
  });

  it("ignores a completion notification for a superseded login id", async () => {
    child.responders["account/login/start"] = () => DEVICE_CODE_RESULT;
    await auth.startDeviceLogin();

    child.notify("account/login/completed", { loginId: "some-older-login", success: true });

    await new Promise((r) => setTimeout(r, 30));
    expect(auth.getLoginStatus().state).toBe("pending");
  });

  it("fails clearly when the CLI is too old to return a device code", async () => {
    // An older Codex answers the RPC but without device-code fields.
    child.responders["account/login/start"] = () => ({ type: "chatgpt", authUrl: "https://x" });

    await expect(auth.startDeviceLogin()).rejects.toThrow(/device code/i);
    expect(child.killed).toBe(true);
  });

  it("reports an error when the codex binary cannot be resolved", async () => {
    buildSpawnMock.mockReturnValue(null as never);
    await expect(auth.startDeviceLogin()).rejects.toThrow(/not found/i);
  });

  it("marks the login failed if the app-server dies before completing", async () => {
    child.responders["account/login/start"] = () => DEVICE_CODE_RESULT;
    await auth.startDeviceLogin();

    child.emit("exit", 1);

    await until(() => auth.getLoginStatus().state === "error");
    expect(auth.getLoginStatus().error).toMatch(/exited/i);
  });
});

describe("cancelLogin", () => {
  it("cancels an in-flight login and kills the child", async () => {
    child.responders["account/login/start"] = () => DEVICE_CODE_RESULT;
    await auth.startDeviceLogin();

    const status = await auth.cancelLogin();

    expect(status.state).toBe("canceled");
    expect(child.killed).toBe(true);
    // The terminal result is retained so a poll arriving after cancel sees it.
    expect(auth.getLoginStatus().state).toBe("canceled");
  });

  it("is a no-op when nothing is in flight", async () => {
    expect((await auth.cancelLogin()).state).toBe("idle");
  });
});

describe("getAccountStatus", () => {
  it("reports a signed-in ChatGPT account with email and plan", async () => {
    child.responders["account/read"] = () => ({
      account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
      requiresOpenaiAuth: false,
    });

    const status = await auth.getAccountStatus();

    expect(status).toMatchObject({
      cliAvailable: true, authenticated: true, method: "chatgpt",
      email: "user@example.com", planType: "pro",
    });
    expect(child.killed).toBe(true); // short-lived probe must not leak a process
  });

  it("distinguishes API-key auth from a ChatGPT subscription", async () => {
    child.responders["account/read"] = () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: false });

    const status = await auth.getAccountStatus();

    expect(status.method).toBe("apiKey");
    expect(status.authenticated).toBe(true);
    expect(status.email).toBeNull();
  });

  it("reports unauthenticated when Codex has no account", async () => {
    child.responders["account/read"] = () => ({ account: null, requiresOpenaiAuth: true });

    const status = await auth.getAccountStatus();

    expect(status.authenticated).toBe(false);
    expect(status.method).toBeNull();
  });

  it("reports the CLI as unavailable rather than throwing", async () => {
    buildSpawnMock.mockReturnValue(null as never);

    const status = await auth.getAccountStatus();

    expect(status.cliAvailable).toBe(false);
    expect(status.error).toMatch(/not found/i);
  });
});

describe("logout", () => {
  it("calls account/logout and reports success", async () => {
    child.responders["account/logout"] = () => ({});

    const res = await auth.logout();

    expect(res.ok).toBe(true);
    expect(child.sent.some((m) => m.method === "account/logout")).toBe(true);
    expect(child.killed).toBe(true);
  });
});
