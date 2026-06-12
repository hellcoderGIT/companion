import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSessionExport } from "./session-export.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// buildSessionExport() reads the raw Claude transcript `.jsonl` from disk via
// resolveClaudeSessionFilePath(), which scans `<projectsRoot>/<project>/<id>.jsonl`
// and picks the newest match. These tests build a throwaway projects root so the
// parser + HTML/TXT renderers can be exercised end-to-end, including image
// recovery (the whole reason this path reads raw JSONL instead of the paginated
// history view, which strips image blocks).

const SESSION_ID = "cli-session-abcdef";
// A tiny 1x1 PNG, base64. Used to assert images embed (HTML) vs. placeholder (TXT).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let projectsRoot: string;

/** Write a transcript made of raw JSONL lines (one stringified object per line). */
function writeTranscript(lines: object[]): void {
  const projectDir = join(projectsRoot, "-some-project");
  mkdirSync(projectDir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), body, "utf8");
}

function userText(text: string, timestamp = "2026-06-11T12:00:00.000Z") {
  return { type: "user", timestamp, message: { role: "user", content: [{ type: "text", text }] } };
}

beforeEach(() => {
  projectsRoot = mkdtempSync(join(tmpdir(), "companion-export-test-"));
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
});

describe("buildSessionExport", () => {
  it("returns null when no transcript file exists for the session", () => {
    const result = buildSessionExport({ sessionId: "missing", format: "html", title: "X", projectsRoot });
    expect(result).toBeNull();
  });

  it("renders HTML with embedded images, thinking, tool calls and metadata", () => {
    writeTranscript([
      userText("Hello there"),
      {
        type: "assistant",
        timestamp: "2026-06-11T12:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason about this" },
            { type: "text", text: "Hi! Here is your answer." },
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-06-11T12:00:06.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "total 0" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
              ],
            },
          ],
        },
      },
    ]);

    const result = buildSessionExport({
      sessionId: SESSION_ID,
      format: "html",
      title: "My Session",
      projectsRoot,
    });

    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("text/html; charset=utf-8");
    expect(result!.filename).toMatch(/^My-Session-\d{4}-\d{2}-\d{2}\.html$/);

    const html = result!.body;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Session</title>");
    expect(html).toContain("Hello there");
    expect(html).toContain("Hi! Here is your answer.");
    // Thinking is rendered as a collapsible <details> block.
    expect(html).toContain("<details class=\"thinking\">");
    expect(html).toContain("Let me reason about this");
    // Tool call name + input present.
    expect(html).toContain("Bash");
    expect(html).toContain("ls -la");
    // Image embedded inline as a data: URI (the key feature of HTML export).
    expect(html).toContain(`data:image/png;base64,${PNG_B64}`);
    // Header reports the image count.
    expect(html).toContain("1 image");
  });

  it("renders TXT with image placeholders instead of embedded data", () => {
    writeTranscript([
      userText("Plain please"),
      {
        type: "user",
        timestamp: "2026-06-11T12:00:06.000Z",
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }],
        },
      },
    ]);

    const result = buildSessionExport({
      sessionId: SESSION_ID,
      format: "txt",
      title: "My Session",
      projectsRoot,
    });

    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("text/plain; charset=utf-8");
    expect(result!.filename).toMatch(/\.txt$/);
    const txt = result!.body;
    expect(txt).toContain("Plain please");
    // No base64 payload in text output — only a size-annotated placeholder.
    expect(txt).not.toContain(PNG_B64);
    expect(txt).toMatch(/\[image: image\/png, ~\d+ bytes\]/);
  });

  it("escapes HTML in message content to prevent markup injection", () => {
    writeTranscript([userText("<script>alert('xss')</script> & \"quotes\"")]);
    const result = buildSessionExport({ sessionId: SESSION_ID, format: "html", title: "T", projectsRoot });
    const html = result!.body;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("filters out slash-command noise lines from the transcript", () => {
    writeTranscript([
      userText("<command-name>/btw</command-name>"),
      userText("real user message"),
    ]);
    const result = buildSessionExport({ sessionId: SESSION_ID, format: "txt", title: "T", projectsRoot });
    expect(result!.body).toContain("real user message");
    expect(result!.body).not.toContain("/btw");
  });

  it("sanitizes the title into a safe filename, falling back when empty", () => {
    writeTranscript([userText("hi")]);
    const result = buildSessionExport({
      sessionId: SESSION_ID,
      format: "html",
      title: "  ??? !!!  ",
      projectsRoot,
    });
    // All unsafe chars stripped → falls back to the "session" base name.
    expect(result!.filename).toMatch(/^session-\d{4}-\d{2}-\d{2}\.html$/);
  });
});
