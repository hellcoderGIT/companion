import type { PermissionUpdate } from "../../server/session-types.js";

/** Human-readable label for a permission suggestion (shared by the classic
 * PermissionBanner and the MagicUI decision controls). */
export function suggestionLabel(s: PermissionUpdate): string {
  if (s.type === "setMode") return `Set mode to "${s.mode}"`;
  const dest = s.destination;
  const scope = dest === "session" ? "for session" : "always";
  if (s.type === "addRules" || s.type === "replaceRules") {
    const rule = s.rules[0];
    if (rule?.ruleContent) return `Allow "${rule.ruleContent}" ${scope}`;
    if (rule?.toolName) return `Allow ${rule.toolName} ${scope}`;
  }
  if (s.type === "addDirectories") {
    return `Trust ${s.directories[0] || "directory"} ${scope}`;
  }
  return `Allow ${scope}`;
}

/**
 * Map index-keyed AskUserQuestion answers to the wire format.
 *
 * The CLI's AskUserQuestion handler looks up each question's answer by the
 * question's *text*, not by its position. Keying by index makes the answer
 * invisible to the model (it receives an empty answers body and guesses) —
 * see commit ecc9d07. Index is only the fallback for questions with empty
 * or missing text.
 */
export function toAnswersByQuestionText(
  questions: unknown[],
  indexed: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [idx, value] of Object.entries(indexed)) {
    const q = questions[Number(idx)] as Record<string, unknown> | undefined;
    const key = typeof q?.question === "string" && q.question ? q.question : idx;
    out[key] = value;
  }
  return out;
}
