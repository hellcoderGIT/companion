// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CopyButton } from "./CopyButton.js";

// navigator.clipboard.writeText is gated by a permissions prompt in jsdom, so
// we stub it per-test to observe the argument and simulate success/failure.
function stubClipboard(impl: () => Promise<void>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mock },
    configurable: true,
  });
  return mock;
}

describe("CopyButton", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders with the default accessible name", () => {
    render(<CopyButton text="hello" />);
    // aria-label doubles as the title tooltip — both say "Copy" at rest.
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("honors a custom label", () => {
    render(<CopyButton text="hello" label="Copy command" />);
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });

  it("writes the exact text prop to the clipboard on click", async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    render(<CopyButton text="payload-under-test" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("payload-under-test"));
  });

  // Visual feedback: after a successful copy, the aria-label flips to "Copied"
  // so screen-reader users and the tooltip hover both report the new state.
  it("flips to the Copied state after a successful write", async () => {
    stubClipboard(() => Promise.resolve());
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  // The Copied state is intentionally transient — returns to "Copy" after the
  // ~1.5s flash so the component is ready for a subsequent copy. Uses real
  // timers because vitest-axe and @testing-library/waitFor do not cooperate
  // with useFakeTimers under the current vitest version.
  it("returns to the Copy state after the flash timeout elapses", async () => {
    stubClipboard(() => Promise.resolve());
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument(),
      { timeout: 2500 },
    );
  });

  // If the clipboard API rejects (e.g. permissions denied and no fallback
  // available), we must not lie to the user by showing "Copied".
  it("does not show Copied when the clipboard write fails", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole("button"));
    // Give any microtask queue a chance to drain before asserting the button
    // still reads "Copy".
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    stubClipboard(() => Promise.resolve());
    const { axe } = await import("vitest-axe");
    const { container } = render(<CopyButton text="x" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
