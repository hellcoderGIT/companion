// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { InlineCode } from "./InlineCode.js";

const PR_URL = "https://bitbucket.example.local/projects/MCDEV/repos/defaultcollection/pull-requests/6517";

// navigator.clipboard.writeText is gated by a permissions prompt in jsdom, so
// we stub it to observe the payload the pill hands to the clipboard.
function stubClipboard(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText: mock }, configurable: true });
  return mock;
}

describe("InlineCode", () => {
  afterEach(cleanup);

  it("renders its text content", () => {
    render(<InlineCode>npm run dev</InlineCode>);
    expect(screen.getByText("npm run dev")).toBeInTheDocument();
  });

  it("exposes a copy button whose accessible name includes the content", () => {
    render(<InlineCode>npm run dev</InlineCode>);
    expect(screen.getByRole("button", { name: "Copy npm run dev" })).toBeInTheDocument();
  });

  // Long payloads (the common case — URLs) get an elided accessible name so a
  // screen reader does not read out an entire URL as the button label.
  it("truncates a long accessible name", () => {
    render(<InlineCode>{PR_URL}</InlineCode>);
    const button = screen.getByRole("button");
    const name = button.getAttribute("aria-label") ?? "";
    expect(name.startsWith("Copy https://bitbucket.example.local")).toBe(true);
    expect(name.endsWith("…")).toBe(true);
  });

  // The whole point: the full untruncated text reaches the clipboard even
  // though the label is elided.
  it("copies the full text, not the truncated label", async () => {
    const writeText = stubClipboard();
    render(<InlineCode>{PR_URL}</InlineCode>);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PR_URL));
  });

  it("copies the flattened text of nested children", async () => {
    const writeText = stubClipboard();
    render(<InlineCode>{["git ", <span key="a">commit</span>, " -m x"]}</InlineCode>);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("git commit -m x"));
  });

  // Markdown treats code-span content as literal, so a URL in backticks is
  // inert by default — we linkify it back into a real anchor.
  it("renders a URL as a link that opens safely in a new tab", () => {
    render(<InlineCode>{PR_URL}</InlineCode>);
    const link = screen.getByRole("link", { name: PR_URL });
    expect(link).toHaveAttribute("href", PR_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("links only the URL portion of mixed content", () => {
    const { container } = render(<InlineCode>{`curl ${PR_URL} --fail`}</InlineCode>);
    // Exactly one anchor, wrapping the URL and nothing else...
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", PR_URL);
    expect(links[0].textContent).toBe(PR_URL);
    // ...while the surrounding command text is preserved verbatim around it.
    expect(container.querySelector("code")?.textContent).toBe(`curl ${PR_URL} --fail`);
  });

  it("does not create a link for non-URL content", () => {
    render(<InlineCode>package.json</InlineCode>);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // Nothing to copy means no button — avoids a control that silently
  // clipboards an empty string.
  it("falls back to a plain pill with no copy button when there is no text", () => {
    const { container } = render(<InlineCode>{null}</InlineCode>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("code")).toBeInTheDocument();
  });

  it("applies a textClassName override", () => {
    const { container } = render(<InlineCode textClassName="text-[12px] text-cc-code-fg">x</InlineCode>);
    expect(container.querySelector("code")?.className).toContain("text-cc-code-fg");
  });

  // ReactMarkdown places inline code inside a <p>, so the pill must contain no
  // block-level elements — a <div> here would produce invalid nesting.
  it("renders only inline-safe elements", () => {
    const { container } = render(<InlineCode>{PR_URL}</InlineCode>);
    expect(container.querySelectorAll("div, p, pre")).toHaveLength(0);
  });

  it("passes axe accessibility checks", async () => {
    stubClipboard();
    const { axe } = await import("vitest-axe");
    const { container } = render(<InlineCode>{PR_URL}</InlineCode>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
