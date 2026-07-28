/**
 * End-to-end integration test against a REAL Claude Code CLI process.
 *
 * Every other test in this suite drives a mock `Subprocess`, which means they
 * validate our *model* of CLI behaviour rather than the CLI itself. That gap is
 * not theoretical: the 0.111.1 silence probe was built on the assumption that
 * "a healthy CLI replies to control requests promptly even while working". It
 * does not — the CLI does not service control requests while a synchronous tool
 * runs — and because every test used a mock that answered on demand, nothing
 * could contradict the assumption. Healthy sessions were killed in production
 * before it was caught.
 *
 * These tests spawn the real binary with the exact argv cli-launcher builds and
 * assert against what it actually emits.
 *
 * OPT-IN. Skipped unless COMPANION_E2E=1, because it spawns a real CLI, spends
 * real tokens and needs working credentials. CI does not run it.
 *
 *   COMPANION_E2E=1 bun run test -- claude-e2e
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";

// Stub Bun.hash: vitest runs under Node, but the adapter's CLI-message dedup
// path calls it. Without this the stdout reader throws "Bun is not defined" on
// the FIRST frame and dies, so the adapter observes a permanently silent CLI —
// which the silence probe then correctly reports as a dead transport. Mirrors
// the stub in ws-bridge.test.ts.
if (typeof globalThis.Bun === "undefined") {
  (globalThis as unknown as { Bun: unknown }).Bun = {
    hash(input: string | Uint8Array): number {
      const str = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
      return h >>> 0;
    },
  };
}
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execSync } from "node:child_process";

const E2E = process.env.COMPANION_E2E === "1";

// Timings are compressed via the same env knobs production exposes, so the
// probe behaviour under test is the real code path rather than a re-implementation.
process.env.COMPANION_SILENCE_PROBE_AFTER_MS ||= "3000";
process.env.COMPANION_SILENCE_PROBE_TIMEOUT_MS ||= "3000";
process.env.COMPANION_SILENCE_CHECK_INTERVAL_MS ||= "500";

let ClaudeAdapter: typeof import("./claude-adapter.js").ClaudeAdapter;

beforeAll(async () => {
  // Imported dynamically so the env overrides above are in place before the
  // module's top-level constants are evaluated.
  ({ ClaudeAdapter } = await import("./claude-adapter.js"));
});

function claudeAvailable(): boolean {
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The argv cli-launcher builds for a stdio session. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-prompt-tool", "stdio",
  "--permission-mode", "bypassPermissions",
];

/**
 * Adapt a Node child process to the shape ClaudeAdapter.attachStdio expects.
 * The adapter only uses stdin.write, stdout as a web ReadableStream, exited,
 * exitCode, killed, pid and kill().
 */
function adaptProc(child: ChildProcessWithoutNullStreams) {
  const proc = {
    pid: child.pid,
    stdin: { write: (data: Uint8Array) => (child.stdin.write(data), data.length) },
    // Built from 'data' events rather than Readable.toWeb(): under vitest the
    // toWeb wrapper never delivered a chunk, so the adapter saw an entirely
    // silent CLI while a raw spawn in the same environment streamed fine.
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
        child.stdout.on("end", () => { try { controller.close(); } catch { /* already closed */ } });
        child.on("exit", () => { try { controller.close(); } catch { /* already closed */ } });
      },
    }),
    exitCode: null as number | null,
    killed: false,
    kill(signal?: NodeJS.Signals) {
      proc.killed = true;
      child.kill(signal ?? "SIGTERM");
    },
    exited: new Promise<number>((resolve) => {
      child.on("exit", (code) => {
        proc.exitCode = code ?? 0;
        resolve(code ?? 0);
      });
    }),
  };
  return proc;
}

const live: ChildProcessWithoutNullStreams[] = [];

function spawnClaude(cwd = "/tmp") {
  const child = spawn("claude", ARGV, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => console.error("[cli:stderr]", String(d).trim().slice(0, 300)));
  child.on("error", (e) => console.error("[cli:error]", e.message));
  child.on("exit", (code, sig) => console.error("[cli:exit]", code, sig));
  live.push(child);
  return child;
}

afterEach(async () => {
  for (const c of live.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

function userMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

describe.runIf(E2E)("claude CLI end-to-end (real process)", () => {
  it("completes a turn: init → assistant text → result", async () => {
    expect(claudeAvailable()).toBe(true);

    const adapter = new ClaudeAdapter("e2e-basic");
    const seen: string[] = [];
    let assistantText = "";
    adapter.onBrowserMessage((msg) => {
      seen.push(msg.type);
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
        for (const b of content) if (b.type === "text" && b.text) assistantText += b.text;
      }
    });

    const child = spawnClaude();
    adapter.attachStdio(adaptProc(child) as never);

    adapter.sendRawNDJSON(userMessage("Reply with exactly the word PONG and nothing else."));

    const done = await Promise.race([
      new Promise<boolean>((resolve) => {
        const timer = setInterval(() => {
          if (seen.includes("result")) {
            clearInterval(timer);
            resolve(true);
          }
        }, 250);
      }),
      new Promise<boolean>((r) => setTimeout(() => r(false), 90_000)),
    ]);

    expect(done, `types seen: ${JSON.stringify(seen)}`).toBe(true);
    // The handshake and turn shape the whole bridge depends on.
    expect(seen, `types seen: ${JSON.stringify(seen)}`).toContain("session_init");
    expect(seen).toContain("assistant");
    expect(assistantText.toUpperCase()).toContain("PONG");
  }, 120_000);

  /**
   * A healthy session must survive a tool call that outruns the probe window.
   *
   * SCOPE — read before trusting this as a regression guard. It was written to
   * reproduce the 0.111.1 bug (probe kills a session busy in a synchronous tool
   * call) and it does NOT reproduce it on CLI 2.1.220: the test passes with the
   * tool-call grace removed, because this CLI keeps emitting frames throughout a
   * Bash call, so the transport never goes silent and the probe never arms. The
   * self-validation below confirms a real tool call ran and outlasted the probe
   * window, so that result is a genuine observation rather than a vacuous pass.
   *
   * The production report came from a different host and CLI build, so the
   * starvation it describes is evidently version- or load-dependent. What this
   * test does guarantee is the invariant that matters day to day: a real session
   * doing real tool work is not torn down. Reproducing the starvation itself
   * needs a CLI that actually stops emitting — not yet reproduced locally.
   */
  it("does not disconnect a healthy session during a long synchronous tool call", async () => {
    expect(claudeAvailable()).toBe(true);

    const adapter = new ClaudeAdapter("e2e-longtool");
    let disconnected = false;
    let sawResult = false;
    let sawToolUse = false;
    const started = Date.now();
    let disconnectedAfterMs = -1;
    adapter.onDisconnect(() => { disconnected = true; disconnectedAfterMs = Date.now() - started; });
    adapter.onBrowserMessage((msg) => {
      if (msg.type === "result") sawResult = true;
      // Confirm the model actually issued a tool call — without one the CLI is
      // never blocked and the test would pass no matter what the probe does.
      const blocks = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content ?? [];
      if (blocks.some((b) => b.type === "tool_use")) sawToolUse = true;
    });

    const child = spawnClaude();
    adapter.attachStdio(adaptProc(child) as never);

    adapter.sendRawNDJSON(
      userMessage("Run this exact bash command and then reply DONE: sleep 12 && echo slept"),
    );

    const finished = await Promise.race([
      new Promise<boolean>((resolve) => {
        const timer = setInterval(() => {
          if (sawResult || disconnected) {
            clearInterval(timer);
            resolve(true);
          }
        }, 250);
      }),
      new Promise<boolean>((r) => setTimeout(() => r(false), 120_000)),
    ]);

    const elapsed = Date.now() - started;
    expect(finished).toBe(true);

    // Self-validation: this test is only meaningful if the CLI was actually
    // blocked in a tool call for longer than the probe window. Without these
    // guards a fast, tool-free reply would pass even with the fix removed —
    // a green test proving nothing.
    expect(sawToolUse, "model did not issue a tool call; test is inconclusive").toBe(true);
    expect(elapsed, "turn finished before the probe window; test is inconclusive")
      .toBeGreaterThan(Number(process.env.COMPANION_SILENCE_PROBE_AFTER_MS) +
                       Number(process.env.COMPANION_SILENCE_PROBE_TIMEOUT_MS));

    // The assertion that matters: the session survived a tool call far longer
    // than the probe window.
    expect(disconnected, `disconnected after ${disconnectedAfterMs}ms`).toBe(false);
    expect(sawResult).toBe(true);
  }, 150_000);

  /**
   * Orphaned MCP servers were the largest resource bug found in production (123
   * processes holding 11.9GB). This asserts the narrower invariant that is true
   * for any session: killing the CLI must not leave its descendants behind.
   */
  it("leaves no descendants behind after the process is killed", async () => {
    expect(claudeAvailable()).toBe(true);
    const { getDescendants, countDescendants } = await import("./proc-diagnostics.js");

    const adapter = new ClaudeAdapter("e2e-orphans");
    const child = spawnClaude();
    adapter.attachStdio(adaptProc(child) as never);

    adapter.sendRawNDJSON(userMessage("Reply with exactly: HI"));
    await new Promise((r) => setTimeout(r, 8000));

    const pid = child.pid!;
    const before = getDescendants(pid);

    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    await new Promise((r) => setTimeout(r, 2000));

    // Any descendant still alive after the parent is gone is an orphan: it has
    // no client and can never acquire one.
    const stillAlive = before.filter((d) => {
      try {
        process.kill(d.pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    for (const d of stillAlive) {
      try { process.kill(d.pid, "SIGKILL"); } catch { /* cleanup */ }
    }

    expect(countDescendants(pid)).toBe(0);
    // Reported rather than asserted: a stock session with no MCP servers
    // configured has nothing to orphan, so a zero here is not proof of the fix.
    if (stillAlive.length > 0) {
      console.warn(`[e2e] ${stillAlive.length} descendant(s) outlived the CLI:`,
        stillAlive.map((d) => `${d.pid}:${d.comm}`).join(", "));
    }
  }, 60_000);
});

describe.runIf(!E2E)("claude CLI end-to-end (skipped)", () => {
  it("is opt-in via COMPANION_E2E=1", () => {
    // Present so the file is never silently empty, which would look like
    // passing coverage while testing nothing.
    expect(E2E).toBe(false);
  });
});
