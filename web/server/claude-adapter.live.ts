/**
 * Live integration tests for the Claude stdio stream-json transport.
 *
 * Spawns the REAL `claude` binary on this machine (which has a token) via the
 * production transport (Bun.spawn) and drives a real ClaudeAdapter end-to-end,
 * asserting that every kind of message coming back over stdout — and the
 * control messages written to stdin — is translated into the correct
 * BrowserIncomingMessage. This is coverage the mocked unit tests can't give:
 * real protocol output across assistant text, streaming partials, tool_use +
 * permission round-trips (allow/deny), AskUserQuestion multiple-choice,
 * set_permission_mode, and interrupt.
 *
 * It is a standalone Bun script (NOT a vitest test) because the transport needs
 * a real Bun.spawn + real subprocess, which the node-based vitest workers don't
 * provide. Run it explicitly (real API calls — costs money, ~1–2 min):
 *
 *   bun run test:live          # from web/  (see package.json)
 *   bun server/claude-adapter.live.ts
 *
 * Optional overrides:
 *   COMPANION_LIVE_CLAUDE_BIN    path to the claude binary (default: resolved)
 *   COMPANION_LIVE_CLAUDE_MODEL  model id (default: claude-sonnet-4-6)
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "./claude-adapter.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  PermissionRequest,
} from "./session-types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BunRT = (globalThis as any).Bun as { spawn: (...a: any[]) => any } | undefined;

function resolveClaudeBin(): string | null {
  const fromEnv = process.env.COMPANION_LIVE_CLAUDE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of [
    `${process.env.HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/root/.local/bin/claude",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const BIN = resolveClaudeBin();
const MODEL = process.env.COMPANION_LIVE_CLAUDE_MODEL || "claude-sonnet-4-6";
const TURN_TIMEOUT = 120_000;

// ─── Tiny assertion helpers ───────────────────────────────────────────────────

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertIncludes(haystack: string, needle: string, msg: string): void {
  assert(haystack.includes(needle), `${msg} (expected to contain "${needle}", got "${haystack.slice(0, 200)}")`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

/** A live ClaudeAdapter wired to a real `claude` child over stdio stream-json. */
class LiveSession {
  readonly messages: BrowserIncomingMessage[] = [];
  readonly permissionRequests: PermissionRequest[] = [];
  readonly cwd: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private proc: any;
  private adapter: ClaudeAdapter;

  constructor(opts: { permissionMode?: string } = {}) {
    this.cwd = mkdtempSync(join(tmpdir(), "claude-live-"));
    const args = [
      BIN as string,
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-prompt-tool", "stdio",
      "--model", MODEL,
      "--permission-mode", opts.permissionMode ?? "default",
    ];
    // The exact transport the launcher uses in production. Bun.spawn's
    // Subprocess shape (FileSink stdin, ReadableStream stdout, `exited` promise)
    // is precisely what ClaudeAdapter.attachStdio expects — no shim.
    this.proc = BunRT!.spawn(args, {
      cwd: this.cwd,
      env: { ...process.env, CLAUDECODE: undefined },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.adapter = new ClaudeAdapter("live-test", { cwd: this.cwd });
    this.adapter.onBrowserMessage((m) => {
      this.messages.push(m);
      if (m.type === "permission_request") this.permissionRequests.push(m.request);
    });
    this.adapter.onSessionMeta(() => {});
    this.adapter.onDisconnect(() => {});
    this.adapter.attachStdio(this.proc);
  }

  send(msg: BrowserOutgoingMessage): void {
    this.adapter.send(msg);
  }

  sendUser(content: string): void {
    this.send({ type: "user_message", content });
  }

  async waitFor(pred: () => boolean, label: string, timeoutMs = TURN_TIMEOUT): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for ${label}. Last messages: ` +
            JSON.stringify(this.messages.slice(-8).map((m) => m.type)),
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async waitForResult(timeoutMs = TURN_TIMEOUT): Promise<Extract<BrowserIncomingMessage, { type: "result" }>> {
    await this.waitFor(() => this.messages.some((m) => m.type === "result"), "result", timeoutMs);
    return this.messages.find((m) => m.type === "result") as Extract<BrowserIncomingMessage, { type: "result" }>;
  }

  assistantText(): string {
    let out = "";
    for (const m of this.messages) {
      if (m.type !== "assistant") continue;
      for (const block of m.message.content ?? []) {
        if ((block as { type?: string }).type === "text") out += (block as { text: string }).text;
      }
    }
    return out;
  }

  toolUses(): { name: string; input: unknown }[] {
    const uses: { name: string; input: unknown }[] = [];
    for (const m of this.messages) {
      if (m.type !== "assistant") continue;
      for (const block of m.message.content ?? []) {
        if ((block as { type?: string }).type === "tool_use") {
          uses.push({ name: (block as { name: string }).name, input: (block as { input: unknown }).input });
        }
      }
    }
    return uses;
  }

  async close(): Promise<void> {
    try { await this.adapter.disconnect(); } catch {}
    try { this.proc?.kill(); } catch {}
    try { rmSync(this.cwd, { recursive: true, force: true }); } catch {}
  }
}

// ─── Cases ────────────────────────────────────────────────────────────────────

type Case = { name: string; run: () => Promise<void> };

const cases: Case[] = [
  {
    name: "session_init, streaming partials, assistant text, success result",
    run: async () => {
      const s = new LiveSession();
      try {
        s.sendUser("Reply with exactly the single token READY and nothing else.");
        const result = await s.waitForResult();
        assert(s.messages.some((m) => m.type === "session_init"), "session_init emitted");
        assert(s.messages.some((m) => m.type === "stream_event"), "stream_event (partial) emitted");
        assertIncludes(s.assistantText().toUpperCase(), "READY", "assistant text");
        assert(!(result.data as { is_error?: boolean }).is_error, "result is not an error");
      } finally { await s.close(); }
    },
  },
  {
    name: "tool_use + can_use_tool permission → allow runs the tool",
    run: async () => {
      const s = new LiveSession({ permissionMode: "default" });
      try {
        s.sendUser("Use the Write tool to create a file named probe.txt containing exactly HELLO_ALLOW. Do nothing else.");
        await s.waitFor(() => s.permissionRequests.some((p) => p.tool_name === "Write"), "Write permission_request");
        const perm = s.permissionRequests.find((p) => p.tool_name === "Write")!;
        assert(perm.request_id, "permission has request_id");
        assert(s.toolUses().some((t) => t.name === "Write"), "assistant tool_use Write seen");
        s.send({ type: "permission_response", request_id: perm.request_id, behavior: "allow", updated_input: perm.input });
        await s.waitForResult();
        const file = join(s.cwd, "probe.txt");
        assert(existsSync(file), "file created after allow");
        assertIncludes(readFileSync(file, "utf-8"), "HELLO_ALLOW", "file contents");
      } finally { await s.close(); }
    },
  },
  {
    name: "can_use_tool permission → deny blocks the tool",
    run: async () => {
      const s = new LiveSession({ permissionMode: "default" });
      try {
        s.sendUser("Use the Write tool to create a file named denied.txt containing NOPE. Do nothing else.");
        await s.waitFor(() => s.permissionRequests.some((p) => p.tool_name === "Write"), "Write permission_request");
        const perm = s.permissionRequests.find((p) => p.tool_name === "Write")!;
        s.send({ type: "permission_response", request_id: perm.request_id, behavior: "deny", message: "Denied by test" });
        await s.waitForResult();
        assert(!existsSync(join(s.cwd, "denied.txt")), "file NOT created after deny");
      } finally { await s.close(); }
    },
  },
  {
    name: "AskUserQuestion multiple-choice surfaces options",
    run: async () => {
      const s = new LiveSession({ permissionMode: "default" });
      try {
        s.sendUser(
          "Use the AskUserQuestion tool to ask me whether I prefer tabs or spaces. " +
            "Offer exactly two options labelled 'tabs' and 'spaces'. Ask only this one question.",
        );
        await s.waitFor(
          () => s.permissionRequests.some((p) => p.tool_name === "AskUserQuestion"),
          "AskUserQuestion permission_request",
        );
        const perm = s.permissionRequests.find((p) => p.tool_name === "AskUserQuestion")!;
        const input = perm.input as { questions?: Array<{ options?: Array<{ label?: string }> }> };
        assert(Array.isArray(input.questions) && input.questions.length > 0, "questions array present");
        const labels = (input.questions![0].options ?? []).map((o) => (o.label ?? "").toLowerCase()).join(",");
        assert(/tab|space/.test(labels), `options include tabs/spaces (got "${labels}")`);
        s.send({ type: "permission_response", request_id: perm.request_id, behavior: "allow", updated_input: perm.input });
        await s.waitForResult();
      } finally { await s.close(); }
    },
  },
  {
    // Verifies a set_permission_mode control_request is delivered over the
    // stdio transport and the session keeps working through a tool turn.
    // (Runtime-switching to bypassPermissions is a launch-only mode the CLI
    // does not honor mid-session, so we switch to acceptEdits and defensively
    // auto-answer any prompt to avoid coupling the transport test to CLI
    // permission-mode semantics.)
    name: "set_permission_mode is delivered and the session completes a tool turn",
    run: async () => {
      const s = new LiveSession({ permissionMode: "default" });
      const answered = new Set<string>();
      const autoAllow = setInterval(() => {
        for (const p of s.permissionRequests) {
          if (answered.has(p.request_id)) continue;
          answered.add(p.request_id);
          s.send({ type: "permission_response", request_id: p.request_id, behavior: "allow", updated_input: p.input });
        }
      }, 150);
      try {
        s.send({ type: "set_permission_mode", mode: "acceptEdits" });
        s.sendUser("Use the Write tool to create a file named mode.txt containing MODE_OK. Do nothing else.");
        const result = await s.waitForResult();
        assert(!(result.data as { is_error?: boolean }).is_error, "result is not an error after mode switch");
        assert(existsSync(join(s.cwd, "mode.txt")), "Write completed after set_permission_mode");
      } finally {
        clearInterval(autoAllow);
        await s.close();
      }
    },
  },
  {
    name: "interrupt ends an in-flight turn",
    run: async () => {
      const s = new LiveSession({ permissionMode: "bypassPermissions" });
      try {
        s.sendUser("Count from 1 to 60, printing each number on its own line as plain text, slowly. Do not stop early.");
        await s.waitFor(
          () => s.messages.some((m) => m.type === "assistant" || m.type === "stream_event"),
          "streaming to start",
        );
        s.send({ type: "interrupt" });
        await s.waitForResult();
        assert(s.messages.some((m) => m.type === "result"), "turn produced a result after interrupt");
      } finally { await s.close(); }
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!BunRT?.spawn) {
    console.error("✗ Must run under Bun (need Bun.spawn). Use: bun server/claude-adapter.live.ts");
    process.exit(2);
  }
  if (!BIN) {
    console.error("✗ claude binary not found. Set COMPANION_LIVE_CLAUDE_BIN.");
    process.exit(2);
  }
  console.log(`Running ${cases.length} live cases against ${BIN} (model=${MODEL})\n`);
  let failed = 0;
  for (const c of cases) {
    const start = Date.now();
    try {
      await c.run();
      console.log(`  ✓ ${c.name}  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${c.name}  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
