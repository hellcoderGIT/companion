// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import { CompactDisclosure, DensityProvider, useDensity, useIsCompact } from "./density.js";
import { useStore } from "../store.js";

/**
 * These tests cover the density preference plumbing:
 * - the store-backed default (standard) and its localStorage persistence,
 * - the per-subtree override used by the Playground and by component tests,
 * - the shared CompactDisclosure row (a11y + toggle behaviour).
 */

function Probe() {
  const density = useDensity();
  const compact = useIsCompact();
  return (
    <div>
      <span data-testid="density">{density}</span>
      <span data-testid="compact">{String(compact)}</span>
    </div>
  );
}

describe("useDensity", () => {
  beforeEach(() => {
    // Reset to the shipped default between tests — the store is a module singleton.
    useStore.setState({ density: "standard" });
    localStorage.clear();
  });

  it("defaults to standard density when the user has no preference", () => {
    render(<Probe />);
    expect(screen.getByTestId("density").textContent).toBe("standard");
    expect(screen.getByTestId("compact").textContent).toBe("false");
  });

  it("follows the store preference when no override is present", () => {
    useStore.getState().setDensity("compact");
    render(<Probe />);
    expect(screen.getByTestId("density").textContent).toBe("compact");
    expect(screen.getByTestId("compact").textContent).toBe("true");
  });

  it("persists the preference to localStorage so it survives a reload", () => {
    useStore.getState().setDensity("compact");
    expect(localStorage.getItem("cc-density")).toBe("compact");
    useStore.getState().toggleDensity();
    expect(localStorage.getItem("cc-density")).toBe("standard");
    expect(useStore.getState().density).toBe("standard");
  });

  it("lets a DensityProvider override the stored preference for its subtree", () => {
    useStore.setState({ density: "standard" });
    render(
      <DensityProvider value="compact">
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId("density").textContent).toBe("compact");
  });

  it("lets a DensityProvider force standard even when the store says compact", () => {
    useStore.setState({ density: "compact" });
    render(
      <DensityProvider value="standard">
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId("density").textContent).toBe("standard");
  });
});

describe("CompactDisclosure", () => {
  function Harness({ meta }: { meta?: string }) {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <CompactDisclosure
          open={open}
          onToggle={() => setOpen(!open)}
          marker="$"
          label="Check Postgres versions"
          meta={meta}
        />
        {open && <div data-testid="body">the command</div>}
      </div>
    );
  }

  it("renders the label and marker as a single collapsed row", () => {
    render(<Harness />);
    expect(screen.getByText("Check Postgres versions")).toBeInTheDocument();
    expect(screen.getByText("$")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).not.toBeInTheDocument();
  });

  it("exposes aria-expanded and toggles it on click", () => {
    render(<Harness />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("body")).toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("renders the optional meta hint", () => {
    render(<Harness meta="34 lines" />);
    expect(screen.getByText("34 lines")).toBeInTheDocument();
  });

  it("has an accessible name so the row is reachable by screen readers", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: /Check Postgres versions/ })).toBeInTheDocument();
  });

  it("passes axe accessibility scan in both collapsed and expanded states", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<Harness meta="34 lines" />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button"));
    expect(await axe(container)).toHaveNoViolations();
  });
});
