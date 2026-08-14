import { getSettings } from "./settings-manager.js";
import { isClaudeCliAvailable } from "./claude-cli-runner.js";
import type { SessionState } from "./session-types.js";

export interface EffectiveMagicUiSettings {
  /**
   * Whether MagicUI is effectively on for this session: the per-session
   * opt-in wins, falling back to the global default. Always false when the
   * Claude CLI is unavailable — the watcher rides the CLI subscription
   * login and cannot run without it (never the Anthropic API key).
   */
  enabled: boolean;
  /** Model for the watcher session. Cheap-by-default (Haiku). */
  model: string;
}

/**
 * Resolve effective MagicUI settings for a session.
 *
 * Unlike AI validation (where the global setting is a default that sessions
 * inherit), MagicUI is deliberately availability-gated AND opt-in:
 * the global toggle makes the feature available to users, but a session only
 * runs the watcher when the user explicitly enabled it for that session.
 * (A global default-on would silently start a Haiku watcher for every
 * session — surprise token burn.)
 */
export function getEffectiveMagicUi(
  sessionState: SessionState,
): EffectiveMagicUiSettings {
  const global = getSettings();
  return {
    enabled:
      global.magicUiEnabled
      && sessionState.magicUiActive === true
      && isClaudeCliAvailable(),
    model: global.magicUiModel,
  };
}
