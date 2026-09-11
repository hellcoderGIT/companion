// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { ActivityRunBlock } from "./ActivityRun.js";
import type { ActivityRun } from "./activity-run.js";
import type { ChatMessage } from "../types.js";

// Mock react-markdown to avoid ESM issues in tests (pulled in via MessageBubble).
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: {} }));

/**
 * Rendering tests for the collapsed / expanded activity run used by compact
 * density. The children are whatever the feed passes in — here a sentinel so
 * we can assert they are only mounted once expanded.
 */

function step(id: string, command: string, ts: number): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: ts,
    contentBlocks: [
      { type: "thinking", thinking: "" },
      { type: "tool_use", id: `tu-${id}`, name: "Bash", input: { command } },
      { type: "tool_result", tool_use_id: `tu-${id}`, content: "ok" },
    ],
  };
}

const RUN: ActivityRun = {
  kind: "activity_run",
  key: "s1",
  children: [
    { kind: "message", msg: step("s1", "git status", 100_000) },
    { kind: "message", msg: step("s2", "npm test -- auth", 165_000) },
  ],
};

describe("ActivityRunBlock", () => {
  it("renders a finished run as a summary header plus the latest action only", () => {
    render(
      <ActivityRunBlock run={RUN} live={false}>
        <div data-testid="children">full children</div>
      </ActivityRunBlock>,
    );
    expect(screen.getByText("Worked")).toBeInTheDocument();
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.getByText("1m 5s")).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    // Latest action = the last step's tool call, in a status region.
    expect(screen.getByRole("status")).toHaveTextContent("Terminal · npm test -- auth");
    // The earlier step is not rendered anywhere while collapsed.
    expect(screen.queryByText(/git status/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("children")).not.toBeInTheDocument();
  });

  it("labels a live run 'Working' so an in-progress turn still reads as active", () => {
    render(
      <ActivityRunBlock run={RUN} live>
        <div />
      </ActivityRunBlock>,
    );
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("expands to the full children on click and collapses again", () => {
    render(
      <ActivityRunBlock run={RUN} live={false}>
        <div data-testid="children">full children</div>
      </ActivityRunBlock>,
    );
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("children")).toBeInTheDocument();
    // The single-line "latest action" preview is replaced by the full content.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("hide")).toBeInTheDocument();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("children")).not.toBeInTheDocument();
  });

  it("shows an error count when a folded tool call failed", () => {
    const failing: ActivityRun = {
      kind: "activity_run",
      key: "f",
      children: [
        {
          kind: "message",
          msg: {
            id: "f",
            role: "assistant",
            content: "",
            timestamp: 1,
            contentBlocks: [
              { type: "tool_use", id: "tu-f", name: "Bash", input: { command: "make" } },
              { type: "tool_result", tool_use_id: "tu-f", content: "boom", is_error: true },
            ],
          },
        },
      ],
    };
    render(
      <ActivityRunBlock run={failing} live={false}>
        <div />
      </ActivityRunBlock>,
    );
    expect(screen.getByText("1 error")).toBeInTheDocument();
  });

  it("passes an axe accessibility scan collapsed and expanded", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <ActivityRunBlock run={RUN} live>
        <p>children</p>
      </ActivityRunBlock>,
    );
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button"));
    expect(await axe(container)).toHaveNoViolations();
  });
});
