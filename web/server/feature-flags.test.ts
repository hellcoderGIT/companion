import { afterEach, describe, expect, it } from "vitest";
import { isSandboxEnabled } from "./feature-flags.js";

// The sandbox kill switch defaults OFF (the upstream image is unmaintained) and
// is opt-in via COMPANION_SANDBOX_ENABLED. It must read the env live so runtime
// toggles take effect.
describe("isSandboxEnabled", () => {
  afterEach(() => {
    delete process.env.COMPANION_SANDBOX_ENABLED;
  });

  it("is disabled by default", () => {
    delete process.env.COMPANION_SANDBOX_ENABLED;
    expect(isSandboxEnabled()).toBe(false);
  });

  it('is enabled when set to "1"', () => {
    process.env.COMPANION_SANDBOX_ENABLED = "1";
    expect(isSandboxEnabled()).toBe(true);
  });

  it('is enabled when set to "true"', () => {
    process.env.COMPANION_SANDBOX_ENABLED = "true";
    expect(isSandboxEnabled()).toBe(true);
  });

  it("is disabled for any other value", () => {
    process.env.COMPANION_SANDBOX_ENABLED = "yes";
    expect(isSandboxEnabled()).toBe(false);
  });
});
