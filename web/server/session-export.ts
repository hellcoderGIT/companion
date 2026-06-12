import { existsSync, readFileSync } from "node:fs";
import { resolveClaudeSessionFilePath } from "./claude-session-history.js";

export type SessionExportFormat = "html" | "txt";

export interface SessionExportResult {
  filename: string;
  contentType: string;
  body: string;
}

export interface BuildSessionExportOptions {
  /** Claude session id (the `.jsonl` file name under ~/.claude/projects). */
  sessionId: string;
  format: SessionExportFormat;
  /** Human-friendly title used in the document header and filename. */
  title: string;
  projectsRoot?: string;
}

interface ExportImage {
  mediaType: string;
  data: string; // base64
}

interface ExportToolResult {
  text: string;
  isError: boolean;
  images: ExportImage[];
}

interface ExportItem {
  role: "user" | "assistant";
  ts: number;
  texts: string[];
  thinking: string[];
  toolUses: { name: string; input: string }[];
  toolResults: ExportToolResult[];
  images: ExportImage[];
}

const MAX_TOOL_RESULT_CHARS = 4000;
const MAX_TOOL_INPUT_CHARS = 1500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractImage(block: Record<string, unknown>): ExportImage | null {
  const source = asRecord(block.source);
  if (!source) return null;
  if (source.type !== "base64") return null;
  const data = typeof source.data === "string" ? source.data : "";
  if (!data) return null;
  const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
  return { mediaType, data };
}

function isCommandNoise(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-stdout>") ||
    t.startsWith("Caveat: The messages below were generated")
  );
}

/** Flatten a tool_result `content` (string | block[]) into text + images. */
function parseToolResultContent(content: unknown): { text: string; images: ExportImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const texts: string[] = [];
  const images: ExportImage[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "image") {
      const img = extractImage(block);
      if (img) images.push(img);
    }
  }
  return { text: texts.join("\n"), images };
}

function parseUserContent(content: unknown, item: ExportItem): void {
  if (typeof content === "string") {
    if (content.trim() && !isCommandNoise(content)) item.texts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim() && !isCommandNoise(block.text)) item.texts.push(block.text);
    } else if (block.type === "image") {
      const img = extractImage(block);
      if (img) item.images.push(img);
    } else if (block.type === "tool_result") {
      const parsed = parseToolResultContent(block.content);
      item.toolResults.push({
        text: parsed.text,
        isError: block.is_error === true,
        images: parsed.images,
      });
    }
  }
}

function parseAssistantContent(content: unknown, item: ExportItem): void {
  if (typeof content === "string") {
    if (content.trim()) item.texts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim()) item.texts.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking.trim()) item.thinking.push(block.thinking);
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      let input = "";
      try {
        input = JSON.stringify(block.input ?? {}, null, 2);
      } catch {
        input = String(block.input ?? "");
      }
      item.toolUses.push({ name, input });
    } else if (block.type === "image") {
      const img = extractImage(block);
      if (img) item.images.push(img);
    }
  }
}

function isEmpty(item: ExportItem): boolean {
  return (
    item.texts.length === 0 &&
    item.thinking.length === 0 &&
    item.toolUses.length === 0 &&
    item.toolResults.length === 0 &&
    item.images.length === 0
  );
}

function parseTranscript(filePath: string): ExportItem[] {
  const raw = readFileSync(filePath, "utf8");
  const items: ExportItem[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown> | null;
    try {
      obj = asRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (!obj) continue;
    const message = asRecord(obj.message);
    const role = message && typeof message.role === "string" ? message.role : null;
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    const item: ExportItem = {
      role: role === "assistant" ? "assistant" : "user",
      ts: Number.isFinite(ts) ? ts : 0,
      texts: [],
      thinking: [],
      toolUses: [],
      toolResults: [],
      images: [],
    };
    if (obj.type === "user" && role === "user") {
      parseUserContent(message?.content, item);
    } else if (obj.type === "assistant" && role === "assistant") {
      parseAssistantContent(message?.content, item);
    } else {
      continue;
    }
    if (!isEmpty(item)) items.push(item);
  }
  return items;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return "";
  }
}

function approxBytes(base64: string): number {
  // 4 base64 chars ≈ 3 bytes.
  return Math.floor((base64.length * 3) / 4);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated, ${text.length - max} more chars]`;
}

function renderHtml(title: string, items: ExportItem[]): string {
  const imgCount = items.reduce(
    (n, it) => n + it.images.length + it.toolResults.reduce((m, r) => m + r.images.length, 0),
    0,
  );
  const parts: string[] = [];
  for (const item of items) {
    const roleLabel = item.role === "assistant" ? "Claude" : "User";
    const time = formatTime(item.ts);
    const blocks: string[] = [];

    for (const think of item.thinking) {
      blocks.push(
        `<details class="thinking"><summary>Thinking</summary><pre>${escapeHtml(think)}</pre></details>`,
      );
    }
    for (const text of item.texts) {
      blocks.push(`<div class="text">${escapeHtml(text)}</div>`);
    }
    for (const img of item.images) {
      blocks.push(`<img class="img" alt="attachment" src="data:${img.mediaType};base64,${img.data}">`);
    }
    for (const tool of item.toolUses) {
      blocks.push(
        `<div class="tool"><span class="tool-name">→ ${escapeHtml(tool.name)}</span><pre>${escapeHtml(
          truncate(tool.input, MAX_TOOL_INPUT_CHARS),
        )}</pre></div>`,
      );
    }
    for (const result of item.toolResults) {
      const cls = result.isError ? "toolresult error" : "toolresult";
      const inner: string[] = [];
      if (result.text.trim()) {
        inner.push(`<pre>${escapeHtml(truncate(result.text, MAX_TOOL_RESULT_CHARS))}</pre>`);
      }
      for (const img of result.images) {
        inner.push(`<img class="img" alt="tool output" src="data:${img.mediaType};base64,${img.data}">`);
      }
      if (inner.length) {
        blocks.push(`<div class="${cls}"><span class="tool-label">tool result</span>${inner.join("")}</div>`);
      }
    }

    if (!blocks.length) continue;
    parts.push(
      `<section class="msg ${item.role}"><header class="meta"><span class="role">${roleLabel}</span>` +
        `${time ? `<span class="time">${escapeHtml(time)}</span>` : ""}</header>${blocks.join("")}</section>`,
    );
  }

  const exportedAt = formatTime(Date.now());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f6f7f9; color: #1c1e21; line-height: 1.55; }
  @media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e6e6; } }
  .page { max-width: 860px; margin: 0 auto; padding: 24px 16px 96px; }
  .doc-header { padding: 16px 0 20px; border-bottom: 1px solid rgba(128,128,128,.25); margin-bottom: 24px; }
  .doc-header h1 { font-size: 20px; margin: 0 0 6px; }
  .doc-header .sub { font-size: 12px; opacity: .6; }
  .msg { padding: 14px 16px; border-radius: 12px; margin: 14px 0; border: 1px solid rgba(128,128,128,.18); }
  .msg.user { background: rgba(99,102,241,.08); }
  .msg.assistant { background: rgba(128,128,128,.06); }
  .meta { display: flex; gap: 10px; align-items: baseline; margin-bottom: 8px; }
  .role { font-weight: 600; font-size: 13px; }
  .msg.user .role { color: #6366f1; }
  .time { font-size: 11px; opacity: .5; }
  .text { white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .img { max-width: 100%; height: auto; border-radius: 8px; margin: 8px 0; display: block;
    border: 1px solid rgba(128,128,128,.25); }
  pre { white-space: pre-wrap; word-break: break-word; background: rgba(128,128,128,.12);
    padding: 10px; border-radius: 8px; font-size: 12px; overflow-x: auto; margin: 6px 0; }
  .thinking summary { cursor: pointer; font-size: 12px; opacity: .6; }
  .tool, .toolresult { margin: 8px 0; font-size: 12px; }
  .tool-name { font-weight: 600; opacity: .8; }
  .tool-label { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
    opacity: .5; margin-bottom: 2px; }
  .toolresult.error pre { background: rgba(239,68,68,.14); }
</style>
</head>
<body>
<div class="page">
  <div class="doc-header">
    <h1>${escapeHtml(title)}</h1>
    <div class="sub">${items.length} messages${imgCount ? ` · ${imgCount} image${imgCount === 1 ? "" : "s"}` : ""} · exported ${escapeHtml(exportedAt)}</div>
  </div>
  ${parts.join("\n")}
</div>
</body>
</html>`;
}

function renderTxt(title: string, items: ExportItem[]): string {
  const lines: string[] = [];
  lines.push(title);
  lines.push(`Exported: ${formatTime(Date.now())}`);
  lines.push(`Messages: ${items.length}`);
  lines.push("=".repeat(60));
  lines.push("");

  for (const item of items) {
    const roleLabel = item.role === "assistant" ? "CLAUDE" : "USER";
    const time = formatTime(item.ts);
    lines.push(`[${time}] ${roleLabel}:`);
    for (const think of item.thinking) {
      lines.push("(thinking)");
      lines.push(think);
    }
    for (const text of item.texts) lines.push(text);
    for (const img of item.images) {
      lines.push(`[image: ${img.mediaType}, ~${approxBytes(img.data)} bytes]`);
    }
    for (const tool of item.toolUses) {
      lines.push(`-> tool: ${tool.name}`);
      lines.push(truncate(tool.input, MAX_TOOL_INPUT_CHARS));
    }
    for (const result of item.toolResults) {
      lines.push(result.isError ? "[tool result · error]" : "[tool result]");
      if (result.text.trim()) lines.push(truncate(result.text, MAX_TOOL_RESULT_CHARS));
      for (const img of result.images) {
        lines.push(`[image: ${img.mediaType}, ~${approxBytes(img.data)} bytes]`);
      }
    }
    lines.push("");
    lines.push("-".repeat(60));
    lines.push("");
  }
  return lines.join("\n");
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9-_ ]+/g, "").trim().replace(/\s+/g, "-");
  return cleaned || "session";
}

export function buildSessionExport(options: BuildSessionExportOptions): SessionExportResult | null {
  const filePath = resolveClaudeSessionFilePath(options.sessionId, options.projectsRoot);
  if (!filePath || !existsSync(filePath)) return null;

  const items = parseTranscript(filePath);
  const title = options.title?.trim() || "Session export";
  const datePart = new Date(Date.now()).toISOString().slice(0, 10);
  const base = `${sanitizeFilename(title)}-${datePart}`;

  if (options.format === "txt") {
    return {
      filename: `${base}.txt`,
      contentType: "text/plain; charset=utf-8",
      body: renderTxt(title, items),
    };
  }
  return {
    filename: `${base}.html`,
    contentType: "text/html; charset=utf-8",
    body: renderHtml(title, items),
  };
}
