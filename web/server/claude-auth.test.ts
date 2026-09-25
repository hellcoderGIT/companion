import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Tests for the Claude Code paste-code sign-in.
 *
 * The manager drives the real `claude` binary, so these tests stub the spawn
 * boundary. Two kinds of child are simulated: the long-lived
 * `claude auth login` process (emits an authorize URL, then reads a code from
 * stdin) and the short-lived `claude auth status --json` probe.
 *
 * The behaviour that matters and is easy to get wrong:
 *  - success is decided by re-reading `auth status`, never by parsing prose
 *  - a rejected code is recoverable on the same process (the CLI re-prompts)
 *  - CLAUDE_CODE_OAUTH_TOKEN must not leak into these subprocesses, or a stale
 *    token would masquerade as a successful login
 */

const spawnMock = vi.fn();
const resolveBinaryMock = vi.fn(() => "/usr/bin/claude");

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: (...a: unknown[]) => resolveBinaryMock(...(a as [])),
  getEnrichedPath: () => "/usr/bin:/bin",
}));

const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  /** Codes written to stdin by the manager. */
  written: string[] = [];
  stdin = { write: (chunk: string) => { this.written.push(chunk); return true; } };
  killed = false;
  kill(): void { this.killed = true; }
}

/** Queue of children handed out by successive spawn() calls, in order. */
let loginChild: FakeChild;
let statusResponses: Array<{ loggedIn: boolean; [k: string]: unknown }>;
let spawnedArgs: string[][];
let spawnedEnvs: NodeJS.ProcessEnv[];
let auth: typeof import("./claude-auth.js");

function installSpawn(): void {
  spawnMock.mockImplementation((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    spawnedArgs.push(args);
    spawnedEnvs.push(opts?.env ?? {});

    // `auth status --json` — short-lived, answers from the queue then exits.
    if (args[1] === "status") {
      const child = new FakeChild();
      const payload = statusResponses.length > 1
        ? statusResponses.shift()!
        : statusResponses[0];
      setImmediate(() => {
        child.stdout.write(JSON.stringify(payload));
        child.emit("exit", 0);
      });
      return child;
    }

    if (args[1] === "logout") {
      const child = new FakeChild();
      setImmediate(() => child.emit("exit", 0));
      return child;
    }

    // `auth login` — long-lived; emits the URL shortly after spawn.
    loginChild = new FakeChild();
    setImmediate(() => {
      loginChild.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${AUTH_URL}\nPaste code here if prompted > `);
    });
    return loginChild;
  });
}

const LOGGED_OUT = { loggedIn: false, authMethod: "none" };
const LOGGED_IN = {
  loggedIn: true, authMethod: "claude.ai", email: "user@example.com",
  orgName: "Acme Inc", subscriptionType: "max",
};

beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockReset();
  resolveBinaryMock.mockReturnValue("/usr/bin/claude");
  spawnedArgs = [];
  spawnedEnvs = [];
  statusResponses = [LOGGED_OUT];
  installSpawn();
  auth = await import("./claude-auth.js");
});

afterEach(() => {
  auth._resetClaudeAuthState();
});

describe("extractAuthUrl", () => {
  it("scrapes the authorize URL out of CLI chatter", () => {
    expect(auth.extractAuthUrl(`visit: ${AUTH_URL}\nPaste code >`)).toBe(AUTH_URL);
  });

  it("ignores output that has no URL yet", () => {
    expect(auth.extractAuthUrl("Opening browser to sign in…")).toBeNull();
  });

  it("strips ANSI colouring around the URL", () => {
    expect(auth.extractAuthUrl(`\u001b[36m${AUTH_URL}\u001b[0m`)).toBe(AUTH_URL);
  });
});

describe("getAccountStatus", () => {
  it("reports the signed-in account from auth status --json", async () => {
    statusResponses = [LOGGED_IN];

    const status = await auth.getAccountStatus();

    expect(status).toMatchObject({
      cliAvailable: true, authenticated: true, method: "claude.ai",
      email: "user@example.com", orgName: "Acme Inc", subscriptionType: "max",
    });
    expect(spawnedArgs[0]).toEqual(["auth", "status", "--json"]);
  });

  it("reports signed out, normalising authMethod 'none' to null", async () => {
    const status = await auth.getAccountStatus();

    expect(status.authenticated).toBe(false);
    expect(status.method).toBeNull();
  });

  it("never exposes CLAUDE_CODE_OAUTH_TOKEN to the CLI", async () => {
    // A token injected into sessions is a *different* auth mechanism. If it
    // leaked here, status would report that token's identity instead of the
    // stored login this panel manages.
    await auth.getAccountStatus();

    expect(spawnedEnvs[0]).toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN", undefined);
    expect(spawnedEnvs[0]).toHaveProperty("CLAUDECODE", undefined);
  });

  it("reports the CLI as unavailable rather than throwing", async () => {
    resolveBinaryMock.mockReturnValue(null as never);

    const status = await auth.getAccountStatus();

    expect(status.cliAvailable).toBe(false);
    expect(status.error).toMatch(/not found/i);
  });

  it("surfaces an error when the CLI prints unparseable output", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stderr.write("something exploded");
        child.emit("exit", 1);
      });
      return child;
    });

    const status = await auth.getAccountStatus();

    expect(status.authenticated).toBe(false);
    expect(status.error).toBe("something exploded");
  });
});

describe("startLogin", () => {
  it("returns the authorize URL and waits for a code", async () => {
    const status = await auth.startLogin();

    expect(status.state).toBe("awaiting_code");
    expect(status.authUrl).toBe(AUTH_URL);
    expect(spawnedArgs[0]).toEqual(["auth", "login", "--claudeai"]);
  });

  it("is idempotent so an already-open link stays valid", async () => {
    const first = await auth.startLogin();
    const second = await auth.startLogin();

    expect(second.authUrl).toBe(first.authUrl);
    expect(spawnedArgs.filter((a) => a[1] === "login")).toHaveLength(1);
  });

  it("throws when the claude binary is missing", async () => {
    resolveBinaryMock.mockReturnValue(null as never);
    await expect(auth.startLogin()).rejects.toThrow(/not found/i);
  });

  it("fails cleanly when the CLI exits before printing a link", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => child.emit("exit", 1));
      return child;
    });

    const status = await auth.startLogin();

    expect(status.state).toBe("error");
    expect(status.error).toMatch(/exited/i);
  });
});

describe("submitCode", () => {
  it("writes the code to the CLI and confirms success via auth status", async () => {
    await auth.startLogin();
    // First status call (during verification) reports the new login.
    statusResponses = [LOGGED_IN];

    const status = await auth.submitCode("  good-code  ");

    expect(status.state).toBe("success");
    // Trimmed and newline-terminated, or the CLI would keep waiting.
    expect(loginChild.written).toEqual(["good-code\n"]);
    expect(loginChild.killed).toBe(true);
  });

  it("returns to awaiting_code with the URL intact when the code is rejected", async () => {
    await auth.startLogin();

    const pending = auth.submitCode("bad-code");
    // The CLI re-prompts rather than exiting, so this is recoverable.
    setImmediate(() => loginChild.stdout.write("Invalid code. Please make sure the full code was copied.\n"));
    const status = await pending;

    expect(status.state).toBe("awaiting_code");
    expect(status.error).toMatch(/wasn't accepted/i);
    expect(status.authUrl).toBe(AUTH_URL);
    // Child stays alive for the retry.
    expect(loginChild.killed).toBe(false);
  });

  it("accepts a corrected code after a rejection", async () => {
    await auth.startLogin();

    const firstTry = auth.submitCode("bad-code");
    setImmediate(() => loginChild.stdout.write("Invalid code. Please make sure the full code was copied.\n"));
    await firstTry;

    statusResponses = [LOGGED_IN];
    const retry = await auth.submitCode("good-code");

    expect(retry.state).toBe("success");
    expect(loginChild.written).toEqual(["bad-code\n", "good-code\n"]);
  });

  it("rejects an empty code without touching the CLI", async () => {
    await auth.startLogin();

    const status = await auth.submitCode("   ");

    expect(status.state).toBe("awaiting_code");
    expect(status.error).toMatch(/enter the code/i);
    expect(loginChild.written).toEqual([]);
  });

  it("reports when no sign-in is in progress", async () => {
    const status = await auth.submitCode("some-code");
    expect(status.error).toMatch(/no sign-in in progress/i);
  });
});

describe("cancelLogin", () => {
  it("abandons the attempt and kills the CLI", async () => {
    await auth.startLogin();

    const status = auth.cancelLogin();

    expect(status.state).toBe("canceled");
    expect(loginChild.killed).toBe(true);
    // Terminal result is retained for a poll arriving after cancel.
    expect(auth.getLoginStatus().state).toBe("canceled");
  });

  it("is a no-op when nothing is in flight", () => {
    expect(auth.cancelLogin().state).toBe("idle");
  });
});

describe("logout", () => {
  it("shells out to auth logout", async () => {
    const res = await auth.logout();

    expect(res.ok).toBe(true);
    expect(spawnedArgs[0]).toEqual(["auth", "logout"]);
  });

  it("reports a logout failure reason", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stderr.write("not logged in");
        child.emit("exit", 1);
      });
      return child;
    });

    expect(await auth.logout()).toEqual({ ok: false, error: "not logged in" });
  });
});
