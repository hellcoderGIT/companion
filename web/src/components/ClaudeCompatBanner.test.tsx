// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ClaudeCompatBanner } from "./ClaudeCompatBanner.js";
import { useStore } from "../store.js";
import type { ClaudeCompatInfo } from "../api.js";

// The banner calls api methods on click. Mock the module so we can assert
// the right method gets called with the right arguments AND avoid touching
// the real fetch path.
vi.mock("../api.js", () => ({
  api: {
    pinClaudeVersion: vi.fn(),
    patchClaudeBinary: vi.fn(),
    dismissClaudeCompatBanner: vi.fn(),
  },
}));
vi.mock("../analytics.js", () => ({ captureException: vi.fn() }));

function makeInfo(overrides: Partial<ClaudeCompatInfo> = {}): ClaudeCompatInfo {
  return {
    installedVersion: "2.1.142",
    installedPath: "/home/me/.local/share/claude/versions/2.1.142",
    isIncompatible: true,
    isPatched: false,
    availableKnownGood: ["2.1.119", "2.1.120"],
    suggestedPinTarget: "2.1.120",
    lastChecked: Date.now(),
    error: null,
    bridgeMode: "none",
    ingressUrl: "",
    bannerDismissedVersion: "",
    ...overrides,
  };
}

describe("ClaudeCompatBanner", () => {
  beforeEach(() => {
    // Reset store state between tests so banner visibility is deterministic.
    useStore.getState().setClaudeCompatInfo(null);
    vi.clearAllMocks();
  });

  // Default case: when the store has no compat info yet, render nothing.
  // The banner shouldn't flash before the first /claude-compat fetch lands.
  it("renders nothing when claudeCompatInfo is null", () => {
    const { container } = render(<ClaudeCompatBanner />);
    expect(container.innerHTML).toBe("");
  });

  // When isIncompatible is false (e.g. user is on Claude 2.1.120 or the
  // binary is already patched), the banner stays hidden.
  it("renders nothing when CLI is compatible", () => {
    useStore.getState().setClaudeCompatInfo(makeInfo({
      installedVersion: "2.1.120",
      isIncompatible: false,
    }));
    const { container } = render(<ClaudeCompatBanner />);
    expect(container.innerHTML).toBe("");
  });

  // The dismissed-version check is keyed on the exact installed version so
  // that a future Claude bump re-surfaces the banner without the user having
  // to clear localStorage.
  it("renders nothing when current installed version matches the dismissed version", () => {
    useStore.getState().setClaudeCompatInfo(makeInfo({
      bannerDismissedVersion: "2.1.142",
    }));
    const { container } = render(<ClaudeCompatBanner />);
    expect(container.innerHTML).toBe("");
  });

  // Surfaces the version label and the pin/patch CTAs when incompatible.
  it("renders the alert with version + pin and patch buttons when incompatible", () => {
    useStore.getState().setClaudeCompatInfo(makeInfo());
    render(<ClaudeCompatBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Claude CLI v2\.1\.142/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pin to v2\.1\.120/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Patch this version/ })).toBeEnabled();
  });

  // If no cached known-good version is on disk, the Pin button must be
  // visibly disabled with a clear label. Otherwise the user clicks it,
  // gets an error, and is left guessing.
  it("disables the Pin button when no known-good version is cached", () => {
    useStore.getState().setClaudeCompatInfo(makeInfo({
      suggestedPinTarget: null,
      availableKnownGood: [],
    }));
    render(<ClaudeCompatBanner />);
    expect(screen.getByRole("button", { name: /no cached known-good version/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Patch this version/ })).toBeEnabled();
  });

  // Clicking Pin should call api.pinClaudeVersion and store the resulting info.
  it("clicking Pin invokes api.pinClaudeVersion and refreshes store state", async () => {
    const { api } = await import("../api.js");
    const fixture = makeInfo();
    const next = { ...makeInfo({ isIncompatible: false, installedVersion: "2.1.120" }), pinnedTo: "2.1.120" };
    (api.pinClaudeVersion as ReturnType<typeof vi.fn>).mockResolvedValue(next);
    useStore.getState().setClaudeCompatInfo(fixture);

    render(<ClaudeCompatBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Pin to v2\.1\.120/ }));
    await waitFor(() => expect(api.pinClaudeVersion).toHaveBeenCalledTimes(1));
    // After a successful pin, the banner should re-render hidden because the
    // server's response (next) carries isIncompatible: false.
    await waitFor(() =>
      expect(useStore.getState().claudeCompatInfo?.isIncompatible).toBe(false)
    );
  });

  // Clicking Patch should call api.patchClaudeBinary and store the result.
  it("clicking Patch invokes api.patchClaudeBinary and refreshes store state", async () => {
    const { api } = await import("../api.js");
    const next = {
      ...makeInfo({ isPatched: true, isIncompatible: false, bridgeMode: "patched" as const }),
      patchedPath: "/home/me/.local/share/claude/versions/2.1.142.patched",
      replacements: 4,
    };
    (api.patchClaudeBinary as ReturnType<typeof vi.fn>).mockResolvedValue(next);
    useStore.getState().setClaudeCompatInfo(makeInfo());

    render(<ClaudeCompatBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Patch this version/ }));
    await waitFor(() => expect(api.patchClaudeBinary).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useStore.getState().claudeCompatInfo?.isPatched).toBe(true)
    );
  });

  // Clicking dismiss should call dismissClaudeCompatBanner with the current
  // installed version (so a later bump re-shows the banner) and immediately
  // hide the banner in the UI.
  it("clicking dismiss invokes api with the installed version and hides the banner", async () => {
    const { api } = await import("../api.js");
    (api.dismissClaudeCompatBanner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, dismissedVersion: "2.1.142",
    });
    useStore.getState().setClaudeCompatInfo(makeInfo());

    render(<ClaudeCompatBanner />);
    fireEvent.click(screen.getByLabelText("Dismiss compatibility banner"));
    await waitFor(() => expect(api.dismissClaudeCompatBanner).toHaveBeenCalledWith("2.1.142"));
    await waitFor(() =>
      expect(useStore.getState().claudeCompatInfo?.bannerDismissedVersion).toBe("2.1.142")
    );
  });

  // Surfaces server-side error messages so the user knows what went wrong
  // (e.g. "openssl not installed" when patching) instead of silently failing.
  it("displays an inline error when an action fails", async () => {
    const { api } = await import("../api.js");
    (api.patchClaudeBinary as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("openssl cert generation failed: command not found"),
    );
    useStore.getState().setClaudeCompatInfo(makeInfo());

    render(<ClaudeCompatBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Patch this version/ }));
    await waitFor(() =>
      expect(screen.getByText(/openssl cert generation failed/)).toBeInTheDocument()
    );
  });
});
