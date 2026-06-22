import type { BackendType } from "../types.js";
import type { BackendModelInfo } from "../api.js";

export interface ModelOption {
  value: string;
  label: string;
  icon: string;
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
  }));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
  { value: "claude-fable-5", label: "Fable 5", icon: "★" },
  { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
  { value: "claude-opus-4-6", label: "Opus 4.6", icon: "" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },
];

export const CODEX_MODELS: ModelOption[] = [
  { value: "gpt-5.3-codex-max", label: "GPT-5.3 Max", icon: "\u25A0" },
  { value: "gpt-5.3-codex-xhigh", label: "GPT-5.3 xHigh", icon: "\u2605" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", icon: "\u2733" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", icon: "\u25C6" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", icon: "\u25A0" },
  { value: "gpt-5.2", label: "GPT-5.2", icon: "\u25CF" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Mini", icon: "\u26A1" },
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
// so the model uses its own built-in default effort. Codex bakes reasoning
// effort into the model name (e.g. gpt-5.3-codex-xhigh), so it has no separate
// effort selector — see getEffortsForBackend.
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

export function getDefaultEffort(_backend: BackendType): string {
  // Empty = let the model use its own default effort (no --effort flag passed).
  return "";
}
