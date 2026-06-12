// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

const mockExportSession = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    exportSession: (...args: unknown[]) => mockExportSession(...args),
  },
}));

vi.mock("../analytics.js", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { ExportMenu } from "./ExportMenu.js";

// Stub the blob-download plumbing jsdom doesn't implement.
let clickedAnchors: HTMLAnchorElement[] = [];
beforeEach(() => {
  mockExportSession.mockReset();
  mockCaptureException.mockReset();
  clickedAnchors = [];
  globalThis.URL.createObjectURL = vi.fn(() => "blob:http://localhost/fake");
  globalThis.URL.revokeObjectURL = vi.fn();
  // Capture the synthetic <a> click so we can assert the download filename.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchors.push(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExportMenu", () => {
  it("renders the export trigger button (closed by default)", () => {
    render(<ExportMenu sessionId="s1" />);
    const btn = screen.getByRole("button", { name: "Export session" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu and toggles aria-expanded", () => {
    render(<ExportMenu sessionId="s1" />);
    const btn = screen.getByRole("button", { name: "Export session" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Download as HTML/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Download as Text/ })).toBeInTheDocument();
  });

  it("downloads HTML via api.exportSession and triggers a file download", async () => {
    mockExportSession.mockResolvedValue({
      blob: new Blob(["<html></html>"], { type: "text/html" }),
      filename: "My-Session-2026-06-11.html",
    });
    render(<ExportMenu sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Export session" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Download as HTML/ }));

    await waitFor(() => expect(mockExportSession).toHaveBeenCalledWith("s1", "html"));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(clickedAnchors[0].download).toBe("My-Session-2026-06-11.html");
    // Menu closes after a successful download.
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("requests the txt format when 'Download as Text' is clicked", async () => {
    mockExportSession.mockResolvedValue({
      blob: new Blob(["text"], { type: "text/plain" }),
      filename: "s.txt",
    });
    render(<ExportMenu sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Export session" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Download as Text/ }));
    await waitFor(() => expect(mockExportSession).toHaveBeenCalledWith("s1", "txt"));
  });

  it("surfaces an error (and reports it) when export fails", async () => {
    mockExportSession.mockRejectedValue(new Error("boom"));
    render(<ExportMenu sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Export session" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Download as HTML/ }));

    await waitFor(() => expect(screen.getByText("Export failed")).toBeInTheDocument());
    expect(mockCaptureException).toHaveBeenCalled();
    expect(clickedAnchors).toHaveLength(0);
  });

  it("passes an axe accessibility scan with the menu open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ExportMenu sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Export session" }));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
