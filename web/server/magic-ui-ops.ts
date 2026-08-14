// ─── MagicUI op parsing / validation / reduction ─────────────────────────────
//
// The watcher model replies with a single JSON array of patch ops. This
// module turns that untrusted text into a validated, sanitized op list and
// folds it into the canonical MagicUiDashboardState.
//
// Defense in depth: the browser renders watcher HTML only inside a sandboxed
// opaque-origin iframe with a no-network CSP — the sanitizer here is the
// second belt, keeping scripts/handlers/URLs out of persisted state at the
// source so replays and future render surfaces stay safe too.

import sanitizeHtmlLib from "sanitize-html";
import {
  MAGIC_UI_MAX_CHART_POINTS,
  MAGIC_UI_MAX_CHART_SERIES,
  MAGIC_UI_MAX_DECISIONS,
  MAGIC_UI_MAX_HTML_CHARS,
  MAGIC_UI_MAX_OPEN_ITEMS,
  MAGIC_UI_MAX_OPS_PER_TURN,
  MAGIC_UI_MAX_SLOTS,
  MAGIC_UI_MAX_SNIPPET_CHARS,
  MAGIC_UI_MAX_TOPICS,
  type MagicChartSpec,
  type MagicUiArea,
  type MagicUiDashboardState,
  type MagicUiDecisionEntry,
  type MagicUiLayoutEntry,
  type MagicUiOp,
} from "./magic-ui-types.js";

const AREAS: ReadonlySet<string> = new Set(["hero", "main", "side", "footer"]);
const CHART_KINDS: ReadonlySet<string> = new Set(["bar", "line", "donut", "sparkline"]);
const OPEN_ITEM_KINDS: ReadonlySet<string> = new Set(["action", "question", "blocker"]);

const SANITIZE_OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    "div", "span", "p", "h1", "h2", "h3", "h4", "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "td", "th",
    "strong", "em", "b", "i", "u", "s", "code", "pre", "small", "br", "hr",
    "blockquote", "progress", "mark", "kbd", "sub", "sup",
  ],
  allowedAttributes: {
    "*": ["class", "data-*"],
    progress: ["value", "max", "class"],
  },
  // No style attribute at all: class-based styling only (the runtime ships
  // utility classes). Inline style is the classic sanitizer escape hatch.
  allowedStyles: {},
  disallowedTagsMode: "discard",
  allowedSchemes: [],
};

export function sanitizeMagicHtml(html: string): string {
  return sanitizeHtmlLib(html, SANITIZE_OPTIONS);
}

function isNonEmptyString(v: unknown, max = 512): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function normalizeSpan(v: unknown): 1 | 2 | 3 | undefined {
  return v === 1 || v === 2 || v === 3 ? v : undefined;
}

function normalizeArea(v: unknown): MagicUiArea | undefined {
  return typeof v === "string" && AREAS.has(v) ? (v as MagicUiArea) : undefined;
}

function validateChartSpec(raw: unknown): MagicChartSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const spec = raw as Record<string, unknown>;
  if (typeof spec.kind !== "string" || !CHART_KINDS.has(spec.kind)) return null;
  if (!Array.isArray(spec.series) || spec.series.length === 0) return null;
  const series: MagicChartSpec["series"] = [];
  for (const s of spec.series.slice(0, MAGIC_UI_MAX_CHART_SERIES)) {
    if (!s || typeof s !== "object") return null;
    const entry = s as Record<string, unknown>;
    if (!Array.isArray(entry.data)) return null;
    const data = entry.data
      .slice(0, MAGIC_UI_MAX_CHART_POINTS)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    if (data.length === 0) return null;
    series.push({
      label: isNonEmptyString(entry.label, 120) ? entry.label : "",
      data,
    });
  }
  if (series.length === 0) return null;
  const labels = Array.isArray(spec.labels)
    ? spec.labels
      .slice(0, MAGIC_UI_MAX_CHART_POINTS)
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.slice(0, 80))
    : undefined;
  return {
    kind: spec.kind as MagicChartSpec["kind"],
    title: isNonEmptyString(spec.title, 160) ? spec.title : undefined,
    labels,
    series,
  };
}

function validateLayoutEntries(raw: unknown): MagicUiLayoutEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MagicUiLayoutEntry[] = [];
  for (const e of raw.slice(0, MAGIC_UI_MAX_SLOTS)) {
    if (!e || typeof e !== "object") continue;
    const entry = e as Record<string, unknown>;
    const area = normalizeArea(entry.area);
    if (!isNonEmptyString(entry.slot, 80) || !area) continue;
    out.push({ slot: entry.slot, area, span: normalizeSpan(entry.span) });
  }
  return out.length > 0 ? out : null;
}

/**
 * Extract the ops array from a raw watcher reply. Accepts either a fenced
 * ```json block (preferred; the prompt asks for exactly one) or a bare JSON
 * array. Returns [] for "nothing to do" replies and null for unparseable
 * ones (so callers can count consecutive failures).
 */
export function parseMagicUiReply(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate and sanitize raw parsed ops. Unknown / malformed ops are dropped
 * (never fatal — a partially-usable turn still updates the dashboard).
 */
export function validateOps(raw: unknown[]): MagicUiOp[] {
  const ops: MagicUiOp[] = [];
  for (const item of raw.slice(0, MAGIC_UI_MAX_OPS_PER_TURN)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    switch (o.op) {
      case "set_slot": {
        if (!isNonEmptyString(o.slot, 80) || typeof o.html !== "string") break;
        const html = sanitizeMagicHtml(o.html.slice(0, MAGIC_UI_MAX_HTML_CHARS * 2)).slice(0, MAGIC_UI_MAX_HTML_CHARS);
        if (!html.trim()) break;
        ops.push({
          op: "set_slot",
          slot: o.slot,
          html,
          title: isNonEmptyString(o.title, 160) ? o.title : undefined,
          area: normalizeArea(o.area),
          span: normalizeSpan(o.span),
        });
        break;
      }
      case "remove_slot": {
        if (isNonEmptyString(o.slot, 80)) ops.push({ op: "remove_slot", slot: o.slot });
        break;
      }
      case "layout": {
        const slots = validateLayoutEntries(o.slots);
        if (slots) ops.push({ op: "layout", slots });
        break;
      }
      case "chart": {
        if (!isNonEmptyString(o.slot, 80)) break;
        const spec = validateChartSpec(o.spec);
        if (!spec) break;
        ops.push({
          op: "chart",
          slot: o.slot,
          spec,
          title: isNonEmptyString(o.title, 160) ? o.title : undefined,
          area: normalizeArea(o.area),
          span: normalizeSpan(o.span),
        });
        break;
      }
      case "stat": {
        if (!isNonEmptyString(o.slot, 80) || !isNonEmptyString(o.label, 120) || !isNonEmptyString(o.value, 80)) break;
        ops.push({
          op: "stat",
          slot: o.slot,
          label: o.label,
          value: o.value,
          trend: o.trend === "up" || o.trend === "down" || o.trend === "flat" ? o.trend : undefined,
          area: normalizeArea(o.area),
          span: normalizeSpan(o.span),
        });
        break;
      }
      case "snippet": {
        if (!isNonEmptyString(o.slot, 80) || !isNonEmptyString(o.title, 160) || typeof o.code !== "string" || !o.code.trim()) break;
        ops.push({
          op: "snippet",
          slot: o.slot,
          title: o.title,
          code: o.code.slice(0, MAGIC_UI_MAX_SNIPPET_CHARS),
          language: isNonEmptyString(o.language, 40) ? o.language : undefined,
          area: normalizeArea(o.area),
          span: normalizeSpan(o.span),
        });
        break;
      }
      case "new_topic": {
        if (isNonEmptyString(o.title, 80)) ops.push({ op: "new_topic", title: o.title });
        break;
      }
      case "open_item": {
        if (!isNonEmptyString(o.id, 80) || !isNonEmptyString(o.text, 500)) break;
        ops.push({
          op: "open_item",
          id: o.id,
          text: o.text,
          kind: typeof o.kind === "string" && OPEN_ITEM_KINDS.has(o.kind) ? (o.kind as "action" | "question" | "blocker") : "action",
        });
        break;
      }
      case "resolve_item": {
        if (isNonEmptyString(o.id, 80)) ops.push({ op: "resolve_item", id: o.id });
        break;
      }
      case "decision_log": {
        if (!isNonEmptyString(o.title, 160) || !isNonEmptyString(o.detail, 500)) break;
        ops.push({ op: "decision_log", title: o.title, detail: o.detail });
        break;
      }
      case "session_summary": {
        if (typeof o.text === "string") {
          ops.push({ op: "session_summary", text: o.text.slice(0, 2_000) });
        }
        break;
      }
      default:
        break;
    }
  }
  return ops;
}

let decisionCounter = 0;
let topicCounter = 0;

/** Server-generated decision entry (user choices, AI auto-resolutions). */
export function makeDecisionEntry(
  source: MagicUiDecisionEntry["source"],
  title: string,
  detail: string,
  now: number,
  behavior?: "allow" | "deny",
): MagicUiDecisionEntry {
  return {
    id: `dec-${now}-${decisionCounter++}`,
    ts: now,
    source,
    title: title.slice(0, 160),
    detail: detail.slice(0, 500),
    behavior,
  };
}

function upsertLayout(layout: MagicUiLayoutEntry[], slot: string, area?: MagicUiArea, span?: 1 | 2 | 3): MagicUiLayoutEntry[] {
  if (!area && !span) return layout;
  const existing = layout.find((l) => l.slot === slot);
  const next = layout.filter((l) => l.slot !== slot);
  next.push({
    slot,
    area: area ?? existing?.area ?? "main",
    span: span ?? existing?.span,
  });
  return next;
}

/**
 * Fold validated ops into a new state (input state is not mutated).
 * Enforces the slot budget by evicting the oldest-updated slots first.
 */
export function applyOps(
  state: MagicUiDashboardState,
  ops: MagicUiOp[],
  now: number,
): MagicUiDashboardState {
  const next: MagicUiDashboardState = {
    ...state,
    slots: { ...state.slots },
    layout: [...state.layout],
    decisionLog: [...state.decisionLog],
    openItems: [...state.openItems],
    topics: [...state.topics],
  };

  for (const op of ops) {
    switch (op.op) {
      case "new_topic": {
        // Subject change: archive the ENTIRE current board as a collapsed
        // topic and hand the model a clean slate. Server-enforced so stale
        // content always leaves the screen even if the model forgets to
        // remove slots itself.
        if (Object.keys(next.slots).length > 0) {
          next.topics = [
            {
              id: `topic-${now}-${topicCounter++}`,
              title: next.currentTopicTitle || "Earlier",
              ts: now,
              slots: next.slots,
              layout: next.layout,
            },
            ...next.topics,
          ].slice(0, MAGIC_UI_MAX_TOPICS);
        }
        next.slots = {};
        next.layout = [];
        next.currentTopicTitle = op.title;
        break;
      }
      case "set_slot":
        next.slots[op.slot] = { title: op.title, html: op.html, updatedAt: now };
        next.layout = upsertLayout(next.layout, op.slot, op.area, op.span);
        break;
      case "remove_slot":
        delete next.slots[op.slot];
        next.layout = next.layout.filter((l) => l.slot !== op.slot);
        break;
      case "layout":
        next.layout = op.slots.filter((l) => next.slots[l.slot] !== undefined || ops.some((other) => "slot" in other && other.slot === l.slot));
        break;
      case "chart":
        next.slots[op.slot] = { title: op.title ?? op.spec.title, chart: op.spec, updatedAt: now };
        next.layout = upsertLayout(next.layout, op.slot, op.area, op.span);
        break;
      case "stat":
        next.slots[op.slot] = { stat: { label: op.label, value: op.value, trend: op.trend }, updatedAt: now };
        next.layout = upsertLayout(next.layout, op.slot, op.area, op.span);
        break;
      case "snippet":
        next.slots[op.slot] = {
          title: op.title,
          snippet: { title: op.title, code: op.code, language: op.language },
          updatedAt: now,
        };
        next.layout = upsertLayout(next.layout, op.slot, op.area, op.span);
        break;
      case "open_item": {
        next.openItems = next.openItems.filter((i) => i.id !== op.id);
        next.openItems.unshift({ id: op.id, ts: now, text: op.text, kind: op.kind ?? "action" });
        if (next.openItems.length > MAGIC_UI_MAX_OPEN_ITEMS) {
          next.openItems = next.openItems.slice(0, MAGIC_UI_MAX_OPEN_ITEMS);
        }
        break;
      }
      case "resolve_item":
        next.openItems = next.openItems.filter((i) => i.id !== op.id);
        break;
      case "decision_log":
        next.decisionLog.unshift(makeDecisionEntry("agent", op.title, op.detail, now));
        if (next.decisionLog.length > MAGIC_UI_MAX_DECISIONS) {
          next.decisionLog = next.decisionLog.slice(0, MAGIC_UI_MAX_DECISIONS);
        }
        break;
      case "session_summary":
        next.sessionSummary = op.text;
        break;
    }
  }

  // Slot budget: evict oldest-updated slots beyond the cap.
  const slotNames = Object.keys(next.slots);
  if (slotNames.length > MAGIC_UI_MAX_SLOTS) {
    const byAge = slotNames.sort((a, b) => next.slots[a].updatedAt - next.slots[b].updatedAt);
    for (const name of byAge.slice(0, slotNames.length - MAGIC_UI_MAX_SLOTS)) {
      delete next.slots[name];
      next.layout = next.layout.filter((l) => l.slot !== name);
    }
  }

  next.version = state.version + 1;
  next.updatedAt = now;
  return next;
}

/** Append a server-generated decision entry (bumps version so browsers update). */
export function appendDecision(
  state: MagicUiDashboardState,
  entry: MagicUiDecisionEntry,
): MagicUiDashboardState {
  const decisionLog = [entry, ...state.decisionLog].slice(0, MAGIC_UI_MAX_DECISIONS);
  return { ...state, decisionLog, version: state.version + 1, updatedAt: entry.ts };
}
