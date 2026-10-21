import type { BackendType } from "../types.js";
import type { BackendModelInfo } from "../api.js";

export interface ModelOption {
  value: string;
  label: string;
  icon: string;
  /**
   * Effort levels this model supports (Claude, from the live CLI model list).
   * Undefined = unknown → all of CLAUDE_EFFORTS are offered.
   */
  efforts?: string[];
}

export interface ModeOption {
  value: string;
  label: string;
}

export interface EffortOption {
  /** Empty string means "use the model's built-in default effort" (no --effort flag). */
  value: string;
  label: string;
}

// ─── Icon assignment for dynamically fetched models ──────────────────────────

const MODEL_ICONS: Record<string, string> = {
  "codex": "\u2733",    // ✳ for codex-optimized models
  "xhigh": "\u2605",    // ★ for extra-high reasoning variants
  "max": "\u25A0",      // ■ for max/flagship
  "mini": "\u26A1",     // ⚡ for mini/fast
};

function pickIcon(slug: string, index: number): string {
  // Claude models: match the static CLAUDE_MODELS styling — ★ marks the Fable
  // tier, everything else is unadorned.
  if (slug.startsWith("claude-")) return slug.includes("fable") ? "\u2605" : "";
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (slug.includes(key)) return icon;
  }
  const fallback = ["\u25C6", "\u25CF", "\u25D5", "\u2726"]; // ◆ ● ◕ ✦
  return fallback[index % fallback.length];
}

/** Convert server model info to frontend ModelOption with icons. */
export function toModelOptions(models: BackendModelInfo[]): ModelOption[] {
  return models.map((m, i) => ({
    value: m.value,
    label: m.label || m.value,
    icon: pickIcon(m.value, i),
    ...(Array.isArray(m.efforts) ? { efforts: m.efforts } : {}),
  }));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

// Static fallback only — the live list comes from the installed Claude Code
// CLI's `initialize` handshake (server route `/backends/claude/models`, see
// server/claude-models.ts), so new models appear on CLI upgrade without a
// Companion release. This list is used only when the CLI probe fails.
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-opus-5-5", label: "Opus 5.5", icon: "" },
  { value: "claude-opus-5", label: "Opus 5", icon: "" },
  { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
  { value: "claude-fable-5-1", label: "Fable 5.1", icon: "★" },
  { value: "claude-fable-5", label: "Fable 5", icon: "★" },
  { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
  { value: "claude-opus-4-6", label: "Opus 4.6", icon: "" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", icon: "" },
  { value: "claude-sonnet-5", label: "Sonnet 5", icon: "" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", icon: "" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },
];

// Static fallback only \u2014 the live list is fetched from the Codex app-server's
// `model/list` RPC (see server route `/backends/codex/models`). Kept roughly in
// sync with recent Codex releases so the picker is sane when the CLI is
// unreachable; the live fetch is the source of truth.
export const CODEX_MODELS: ModelOption[] = [
  { value: "gpt-6-astra", label: "GPT-6-Astra", icon: "\u2726" },
  { value: "gpt-5.6-sol", label: "GPT-5.6-Sol", icon: "\u25A0" },
  { value: "gpt-5.6-terra", label: "GPT-5.6-Terra", icon: "\u2733" },
  { value: "gpt-5.6-luna", label: "GPT-5.6-Luna", icon: "\u26A1" },
  { value: "gpt-5.5", label: "GPT-5.5", icon: "\u25C6" },
  { value: "gpt-5.2", label: "GPT-5.2", icon: "\u25CF" },
];

export const CLAUDE_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Agent" },
  { value: "plan", label: "Plan" },
];

export const CODEX_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Auto" },
  { value: "plan", label: "Plan" },
];

// Reasoning-effort levels accepted by the Claude Code CLI's `--effort` flag
// (low, medium, high, xhigh, max). The first entry ("Default") passes no flag,
// so the model uses its own built-in default effort. Codex has no separate
// effort selector in the UI — it falls back to each model's default reasoning
// effort (Codex models expose efforts via model/list; a dedicated Codex effort
// selector is a possible future enhancement). See getEffortsForBackend.
export const CLAUDE_EFFORTS: EffortOption[] = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "xHigh" },
  { value: "max", label: "Max" },
];

// Agent-specific modes: "plan" is excluded because agents are autonomous
// and cannot wait for human plan approval.
export const CLAUDE_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "acceptEdits", label: "Auto-Edit" },
  { value: "default", label: "Supervised" },
];

export const CODEX_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "default", label: "Supervised" },
];

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getModelsForBackend(backend: BackendType): ModelOption[] {
  return backend === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
}

export function getModesForBackend(backend: BackendType): ModeOption[] {
  return backend === "codex" ? CODEX_MODES : CLAUDE_MODES;
}

export function getAgentModesForBackend(backend: BackendType): ModeOption[] {
  return backend === "codex" ? CODEX_AGENT_MODES : CLAUDE_AGENT_MODES;
}

export function getDefaultModel(backend: BackendType): string {
  return backend === "codex" ? CODEX_MODELS[0].value : CLAUDE_MODELS[0].value;
}

export function getDefaultMode(backend: BackendType): string {
  return backend === "codex" ? CODEX_MODES[0].value : CLAUDE_MODES[0].value;
}

export function getDefaultAgentMode(backend: BackendType): string {
  return backend === "codex" ? CODEX_AGENT_MODES[0].value : CLAUDE_AGENT_MODES[0].value;
}

// Codex selects reasoning effort via the model variant, so it returns no effort
// options and the selector is hidden for that backend.
export function getEffortsForBackend(backend: BackendType): EffortOption[] {
  return backend === "codex" ? [] : CLAUDE_EFFORTS;
}

/**
 * Effort options for a specific model. When the live model list reports the
 * model's supported levels, unsupported ones are hidden (e.g. no xHigh on
 * Opus 4.6, no effort control at all on Haiku 4.5). "Default" is always kept.
 */
export function getEffortsForModel(backend: BackendType, model: ModelOption | undefined): EffortOption[] {
  const all = getEffortsForBackend(backend);
  if (!model?.efforts) return all;
  const supported = new Set(model.efforts);
  return all.filter((e) => e.value === "" || supported.has(e.value));
}

export function getDefaultEffort(_backend: BackendType): string {
  // Empty = let the model use its own default effort (no --effort flag passed).
  return "";
}
