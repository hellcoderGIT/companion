// @vitest-environment jsdom
// Tests for the ViewModeToggle top-bar control.
//
// Covers the two operating modes:
// - MagicUI unavailable → renders exactly the classic two-state density
//   toggle (regression guard: existing users must see no change).
// - MagicUI available → renders the three-way Standard | Compact | Magic
//   segmented control, drives the density store and the per-session
//   set_magic_ui message, and switching back to Standard/Compact turns the
//   session's magic mode off.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

const mockSendSetMagicUi = vi.fn();

vi.mock("../ws.js", () => ({
  sendSetMagicUi: (...args: unknown[]) => mockSendSetMagicUi(...args),
}));

let mockStoreState: Record<string, unknown> = {};

vi.mock("../store.js", () => {
  const useStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStoreState);
  useStore.getState = () => mockStoreState;
  return { useStore };
});

import { ViewModeToggle } from "./ViewModeToggle.js";

const mockSetDensity = vi.fn();
const mockToggleDensity = vi.fn();
const mockSetSessionMagicUi = vi.fn();

function setStore(opts: {
  density?: "standard" | "compact";
  magicUiAvailable?: boolean;
  magicUiActive?: boolean | null;
}) {
  mockStoreState = {
    density: opts.density ?? "standard",
    magicUiAvailable: opts.magicUiAvailable ?? false,
    sessions: new Map([
      ["sess-1", { magicUiActive: opts.magicUiActive ?? null }],
    ]),
    setDensity: mockSetDensity,
    toggleDensity: mockToggleDensity,
    setSessionMagicUi: mockSetSessionMagicUi,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setStore({});
});

describe("ViewModeToggle", () => {
  it("renders the classic density toggle when MagicUI is unavailable", () => {
    setStore({ magicUiAvailable: false });
    render(<ViewModeToggle sessionId="sess-1" />);
    expect(
      screen.getByRole("button", { name: /switch to compact density/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /view mode/i })).not.toBeInTheDocument();
  });

  it("renders the classic density toggle when there is no session", () => {
    setStore({ magicUiAvailable: true });
    render(<ViewModeToggle sessionId={null} />);
    expect(
      screen.getByRole("button", { name: /switch to compact density/i }),
    ).toBeInTheDocument();
  });

  it("renders a three-way group when MagicUI is available", () => {
    setStore({ magicUiAvailable: true });
    render(<ViewModeToggle sessionId="sess-1" />);
    const group = screen.getByRole("group", { name: /view mode/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /standard view/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /compact view/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /magic dashboard view/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("marks Magic as active when the session opted in", () => {
    setStore({ magicUiAvailable: true, magicUiActive: true });
    render(<ViewModeToggle sessionId="sess-1" />);
    expect(screen.getByRole("button", { name: /magic dashboard view/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /standard view/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("activates magic mode optimistically and notifies the server", () => {
    setStore({ magicUiAvailable: true });
    render(<ViewModeToggle sessionId="sess-1" />);
    fireEvent.click(screen.getByRole("button", { name: /magic dashboard view/i }));
    expect(mockSetSessionMagicUi).toHaveBeenCalledWith("sess-1", true);
    expect(mockSendSetMagicUi).toHaveBeenCalledWith("sess-1", true);
  });

  it("switching to compact turns magic off for the session", () => {
    setStore({ magicUiAvailable: true, magicUiActive: true, density: "standard" });
    render(<ViewModeToggle sessionId="sess-1" />);
    fireEvent.click(screen.getByRole("button", { name: /compact view/i }));
    expect(mockSetDensity).toHaveBeenCalledWith("compact");
    expect(mockSetSessionMagicUi).toHaveBeenCalledWith("sess-1", false);
    expect(mockSendSetMagicUi).toHaveBeenCalledWith("sess-1", false);
  });

  it("switching to standard does not message the server when magic is already off", () => {
    setStore({ magicUiAvailable: true, magicUiActive: false, density: "compact" });
    render(<ViewModeToggle sessionId="sess-1" />);
    fireEvent.click(screen.getByRole("button", { name: /standard view/i }));
    expect(mockSetDensity).toHaveBeenCalledWith("standard");
    expect(mockSendSetMagicUi).not.toHaveBeenCalled();
  });

  it("has no accessibility violations in fallback mode", async () => {
    setStore({ magicUiAvailable: false });
    const { container } = render(<ViewModeToggle sessionId="sess-1" />);
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no accessibility violations in three-way mode", async () => {
    setStore({ magicUiAvailable: true, magicUiActive: true });
    const { container } = render(<ViewModeToggle sessionId="sess-1" />);
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });
});
