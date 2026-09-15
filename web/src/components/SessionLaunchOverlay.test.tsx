// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SessionLaunchOverlay } from "./SessionLaunchOverlay.js";
import type { CreationProgressEvent } from "../api.js";

const doneSteps: CreationProgressEvent[] = [
  { step: "resolving_env", label: "Environment resolved", status: "done" },
  { step: "launching_cli", label: "Session started", status: "done" },
];

describe("SessionLaunchOverlay — unsent prompt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the unsent prompt verbatim when creation failed", () => {
    render(
      <SessionLaunchOverlay
        steps={doneSteps}
        error="Failed to launch CLI: boom"
        unsentPrompt={"Fix the login bug\n\nSecond paragraph"}
      />,
    );

    const box = screen.getByTestId("unsent-prompt");
    expect(box).toBeInTheDocument();
    expect(screen.getByText("Your prompt was not sent")).toBeInTheDocument();
    // Whitespace/newlines are preserved so what the user copies is exactly what they typed.
    expect(box.querySelector("pre")?.textContent).toBe("Fix the login bug\n\nSecond paragraph");
  });

  it("copies the prompt to the clipboard and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<SessionLaunchOverlay steps={doneSteps} error="boom" unsentPrompt="Fix the login bug" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("Fix the login bug");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("does not show the prompt box while creation is still in progress", () => {
    render(
      <SessionLaunchOverlay
        steps={[{ step: "launching_cli", label: "Starting...", status: "in_progress" }]}
        unsentPrompt="Fix the login bug"
      />,
    );
    expect(screen.queryByTestId("unsent-prompt")).not.toBeInTheDocument();
  });

  it("passes axe accessibility checks with the unsent prompt shown", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SessionLaunchOverlay steps={doneSteps} error="boom" unsentPrompt="Fix the login bug" onCancel={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("does not show the prompt box on error when there was no prompt", () => {
    render(<SessionLaunchOverlay steps={doneSteps} error="boom" unsentPrompt={null} />);
    expect(screen.queryByTestId("unsent-prompt")).not.toBeInTheDocument();
  });
});
