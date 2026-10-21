// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// CronManager talks to the REST api for jobs and for the live model list.
// Everything is mocked so tests control the server responses.
const mockApi = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
  getBackendModels: vi.fn(),
  createCronJob: vi.fn(),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  toggleCronJob: vi.fn(),
  runCronJob: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));
vi.mock("./FolderPicker.js", () => ({ FolderPicker: () => null }));

import { CronManager } from "./CronManager.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listCronJobs.mockResolvedValue([]);
  mockApi.getBackendModels.mockResolvedValue([]);
});

describe("CronManager", () => {
  it("renders the scheduled tasks view", async () => {
    render(<CronManager embedded />);
    expect(await screen.findByText("Run autonomous Claude Code or Codex sessions on a schedule.")).toBeInTheDocument();
    await waitFor(() => expect(mockApi.listCronJobs).toHaveBeenCalled());
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<CronManager embedded />);
    await waitFor(() => expect(mockApi.listCronJobs).toHaveBeenCalled());
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // The create form's model picker uses the live list for Claude too (not just
  // Codex): models come from the installed CLI, so a model newer than this
  // Companion build is offered. When the current default isn't in the live
  // list, the form switches to the list's first entry (the CLI's default).
  it("uses the live Claude model list in the create form", async () => {
    mockApi.getBackendModels.mockResolvedValue([
      { value: "claude-fable-9-9", label: "Fable 9.9", description: "" },
      { value: "claude-sonnet-9-9", label: "Sonnet 9.9", description: "" },
    ]);
    render(<CronManager embedded />);
    fireEvent.click(await screen.findByText("New Task"));

    await waitFor(() => expect(mockApi.getBackendModels).toHaveBeenCalledWith("claude"));
    const modelButton = await screen.findByRole("button", { name: /Fable 9\.9/ });
    fireEvent.click(modelButton);
    fireEvent.click(screen.getByRole("button", { name: /Sonnet 9\.9/ }));
    expect(screen.getByRole("button", { name: /Sonnet 9\.9/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fable 9\.9/ })).not.toBeInTheDocument();
  });

  // CLI missing / probe failed → keep the static fallback list.
  it("falls back to the static Claude list when the live fetch fails", async () => {
    mockApi.getBackendModels.mockRejectedValue(new Error("404"));
    render(<CronManager embedded />);
    fireEvent.click(await screen.findByText("New Task"));
    expect(await screen.findByRole("button", { name: /Opus 5\.5/ })).toBeInTheDocument();
  });
});
