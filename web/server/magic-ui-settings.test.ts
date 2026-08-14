// Tests for the MagicUI effective-settings resolver.
//
// Semantics under test (deliberately different from AI validation's
// inherit-default): the global toggle only makes the feature AVAILABLE;
// a watcher runs only for sessions that explicitly opted in — a global
// default-on would silently start a Haiku watcher for every session.
// CLI availability is a hard gate (subscription login, no API key path).
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SessionState } from "./session-types.js";

const mocks = vi.hoisted(() => ({
  magicUiEnabled: false,
  cliAvailable: true,
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({ magicUiEnabled: mocks.magicUiEnabled, magicUiModel: "claude-haiku-4-5" }),
}));
vi.mock("./claude-cli-runner.js", () => ({
  isClaudeCliAvailable: () => mocks.cliAvailable,
}));

import { getEffectiveMagicUi } from "./magic-ui-settings.js";

function session(magicUiActive: boolean | null | undefined): SessionState {
  return { session_id: "s", magicUiActive } as SessionState;
}

beforeEach(() => {
  mocks.magicUiEnabled = true;
  mocks.cliAvailable = true;
});

describe("getEffectiveMagicUi", () => {
  it("is enabled only with global availability AND explicit session opt-in", () => {
    expect(getEffectiveMagicUi(session(true)).enabled).toBe(true);
    expect(getEffectiveMagicUi(session(false)).enabled).toBe(false);
    // null/undefined = no opt-in → off (never default-on per session)
    expect(getEffectiveMagicUi(session(null)).enabled).toBe(false);
    expect(getEffectiveMagicUi(session(undefined)).enabled).toBe(false);
  });

  it("is disabled when the feature is globally off, even with session opt-in", () => {
    mocks.magicUiEnabled = false;
    expect(getEffectiveMagicUi(session(true)).enabled).toBe(false);
  });

  it("is disabled when the Claude CLI is unavailable (subscription-login gate)", () => {
    mocks.cliAvailable = false;
    expect(getEffectiveMagicUi(session(true)).enabled).toBe(false);
  });

  it("reports the configured watcher model", () => {
    expect(getEffectiveMagicUi(session(true)).model).toBe("claude-haiku-4-5");
  });
});
