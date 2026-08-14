// ─── MagicUI host↔iframe bridge ──────────────────────────────────────────────
//
// The dashboard runtime lives in a sandboxed, opaque-origin iframe
// (sandbox="allow-scripts", srcdoc, no-network CSP). This module owns the
// srcdoc assembly and the typed postMessage protocol in both directions,
// plus the mapping from real PermissionRequest data to the dumb "decision
// model" the runtime renders. Interactive decisions are always derived from
// real pending-permission data — never from watcher output.

import runtimeJs from "./runtime/runtime.js?raw";
import runtimeCss from "./runtime/runtime.css?raw";
// Direct file path (not a bare specifier): chart.js's exports map does not
// expose the UMD bundle, but we need it as an inlinable string for the
// no-network iframe srcdoc.
import chartJs from "../../node_modules/chart.js/dist/chart.umd.min.js?raw";
import type { PermissionRequest, BrowserOutgoingMessage } from "../types.js";
import { suggestionLabel, toAnswersByQuestionText } from "../lib/permission-utils.js";

export const MAGIC_UI_CHANNEL = "magic-ui";

// ── Decision model (host → runtime) ─────────────────────────────────────────

export interface DecisionQuestionModel {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface DecisionModel {
  requestId: string;
  kind: "ask_user_question" | "exit_plan_mode" | "tool";
  title: string;
  detail?: string;
  questions?: DecisionQuestionModel[];
  suggestions?: Array<{ label: string; index: number }>;
}

// ── Protocol messages ───────────────────────────────────────────────────────

export type HostToRuntimeMessage =
  | { channel?: string; type: "init"; theme: "light" | "dark" }
  | { channel?: string; type: "theme"; theme: "light" | "dark" }
  | { channel?: string; type: "state"; state: unknown }
  | { channel?: string; type: "decision_show"; request: DecisionModel }
  | { channel?: string; type: "decision_hide"; requestId: string };

export type DecisionRuntimeResponse =
  | { action: "allow"; suggestionIndex?: number }
  | { action: "deny" }
  | { action: "answers"; answers: Array<{ index?: number; question: string; answer: string }> };

export type RuntimeToHostMessage =
  | { channel: string; type: "ready" }
  | { channel: string; type: "copy_request"; text: string }
  | { channel: string; type: "decision_ack"; requestId: string }
  | { channel: string; type: "decision_response"; requestId: string; response: DecisionRuntimeResponse }
  | { channel: string; type: "runtime_error"; message: string };

export function isRuntimeMessage(data: unknown): data is RuntimeToHostMessage {
  return (
    typeof data === "object"
    && data !== null
    && (data as { channel?: unknown }).channel === MAGIC_UI_CHANNEL
    && typeof (data as { type?: unknown }).type === "string"
  );
}

// ── srcdoc assembly ─────────────────────────────────────────────────────────

/**
 * Build the full self-contained iframe document. Everything is inlined —
 * the CSP forbids all network access, so no external script/style/img can
 * load even if watcher HTML smuggled a reference through.
 */
export function buildMagicUiSrcdoc(theme: "light" | "dark"): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    // No network at all; inline script/style only; data: images allowed for
    // potential future use. This is the primary security boundary.
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:;">',
    `<style>${runtimeCss}</style>`,
    "</head>",
    `<body data-theme="${theme === "dark" ? "dark" : "light"}">`,
    // Chart.js UMD first so the runtime finds window.Chart.
    `<script>${chartJs}</script>`,
    `<script>${runtimeJs}</script>`,
    "</body></html>",
  ].join("\n");
}

// ── PermissionRequest → DecisionModel ───────────────────────────────────────

export function toDecisionModel(perm: PermissionRequest): DecisionModel {
  if (perm.tool_name === "AskUserQuestion") {
    const rawQuestions = Array.isArray(perm.input.questions) ? perm.input.questions : [];
    const questions: DecisionQuestionModel[] = rawQuestions.map((raw) => {
      const q = (raw ?? {}) as Record<string, unknown>;
      const options = Array.isArray(q.options)
        ? q.options.map((o) => {
          if (typeof o === "string") return { label: o };
          const opt = (o ?? {}) as Record<string, unknown>;
          return {
            label: typeof opt.label === "string" ? opt.label : "",
            description: typeof opt.description === "string" ? opt.description : undefined,
          };
        }).filter((o) => o.label)
        : [];
      return {
        question: typeof q.question === "string" ? q.question : "",
        options,
        multiSelect: q.multiSelect === true,
      };
    });
    return {
      requestId: perm.request_id,
      kind: "ask_user_question",
      title: perm.title || "The agent has a question",
      detail: perm.description,
      questions,
    };
  }

  if (perm.tool_name === "ExitPlanMode") {
    const plan = typeof perm.input.plan === "string" ? perm.input.plan : "";
    return {
      requestId: perm.request_id,
      kind: "exit_plan_mode",
      title: "Plan ready for approval",
      detail: plan.slice(0, 2_000),
    };
  }

  const detailParts: string[] = [];
  if (perm.description) detailParts.push(perm.description);
  if (perm.tool_name === "Bash" && typeof perm.input.command === "string") {
    detailParts.push(`$ ${perm.input.command}`);
  } else if (typeof perm.input.file_path === "string") {
    detailParts.push(perm.input.file_path);
  }
  return {
    requestId: perm.request_id,
    kind: "tool",
    title: perm.title || perm.display_name || `Allow ${perm.tool_name}?`,
    detail: detailParts.join("\n").slice(0, 1_000) || undefined,
    suggestions: (perm.permission_suggestions ?? []).map((s, index) => ({
      label: suggestionLabel(s),
      index,
    })),
  };
}

/**
 * Translate a runtime decision response into the standard wire message —
 * byte-identical to what the classic PermissionBanner sends, including the
 * AskUserQuestion keyed-by-question-TEXT contract.
 */
export function decisionResponseToWire(
  perm: PermissionRequest,
  response: DecisionRuntimeResponse,
): Extract<BrowserOutgoingMessage, { type: "permission_response" }> {
  if (response.action === "deny") {
    return {
      type: "permission_response",
      request_id: perm.request_id,
      behavior: "deny",
      message: "Denied by user",
    };
  }
  if (response.action === "answers") {
    const questions = Array.isArray(perm.input.questions) ? perm.input.questions : [];
    const indexed: Record<string, string> = {};
    response.answers.forEach((a, i) => {
      indexed[String(a.index ?? i)] = a.answer;
    });
    return {
      type: "permission_response",
      request_id: perm.request_id,
      behavior: "allow",
      updated_input: { ...perm.input, answers: toAnswersByQuestionText(questions, indexed) },
    };
  }
  const suggestion =
    response.suggestionIndex !== undefined
      ? perm.permission_suggestions?.[response.suggestionIndex]
      : undefined;
  return {
    type: "permission_response",
    request_id: perm.request_id,
    behavior: "allow",
    // The bridge falls updated_input back to the original input server-side.
    ...(suggestion ? { updated_permissions: [suggestion] } : {}),
  };
}
