// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// FolderPicker stub: exposes buttons that drive its onSelect/onClose callbacks.
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({ onSelect, onClose }: { onSelect: (p: string) => void; onClose: () => void }) => (
    <div>
      <button onClick={() => onSelect("/work/my-repo")}>pick-folder</button>
      <button onClick={onClose}>close-folder-picker</button>
    </div>
  ),
}));

import { CronManager } from "./CronManager.js";
import type { CronJobInfo } from "../api.js";

const NOW = Date.now();

// Minimal valid CronJobInfo; individual tests override what they exercise.
function job(overrides: Partial<CronJobInfo> = {}): CronJobInfo {
  return {
    id: "j1",
    name: "Nightly tests",
    prompt: "Run the test suite",
    schedule: "0 8 * * *",
    recurring: true,
    backendType: "claude",
    model: "claude-opus-5-5",
    cwd: "/work/repo",
    enabled: true,
    permissionMode: "bypassPermissions",
    createdAt: NOW,
    updatedAt: NOW,
    consecutiveFailures: 0,
    totalRuns: 0,
    ...overrides,
  };
}

// Fill the name + prompt fields of the (only) open job form.
function fillForm(name: string, prompt: string) {
  fireEvent.change(screen.getByPlaceholderText(/Task name/), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText(/Prompt for the session/), { target: { value: prompt } });
}

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

// ─── Embedded layout: listing ──────────────────────────────────────────────────

describe("CronManager (embedded) job list", () => {
  it("shows a loading state until jobs arrive", async () => {
    mockApi.listCronJobs.mockReturnValue(new Promise(() => {}));
    render(<CronManager embedded />);
    expect(screen.getByText("Loading scheduled tasks...")).toBeInTheDocument();
  });

  it("shows an empty state when there are no jobs", async () => {
    render(<CronManager embedded />);
    expect(await screen.findByText("No scheduled tasks yet.")).toBeInTheDocument();
    expect(screen.getByText("0 tasks")).toBeInTheDocument();
  });

  // Row metadata: backend badge, failure badge, paused badge, next/last run,
  // run count, and the active-count stat (only enabled jobs count).
  it("renders job rows with badges, run info, and stats", async () => {
    mockApi.listCronJobs.mockResolvedValue([
      job({ id: "a", name: "Alpha", nextRunAt: NOW + 3 * 3600_000, lastRunAt: NOW - 60_000, totalRuns: 3 }),
      job({ id: "b", name: "Beta", backendType: "codex", enabled: false, consecutiveFailures: 2, lastRunAt: NOW - 60_000, totalRuns: 1 }),
    ]);
    render(<CronManager embedded />);

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("2 tasks")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("2 fails")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("3 runs")).toBeInTheDocument();
    expect(screen.getByText("1 run")).toBeInTheDocument();
    expect(screen.getByText(/^Next in [23]h$/)).toBeInTheDocument();
  });

  // humanizeSchedule: each supported cron shape renders as readable text;
  // anything else falls back to the raw expression.
  it("humanizes common cron schedules and falls back to the raw expression", async () => {
    const cases: Array<[string, boolean, string]> = [
      ["* * * * *", true, "Every minute"],
      ["*/1 * * * *", true, "Every minute"],
      ["*/5 * * * *", true, "Every 5 minutes"],
      ["0 * * * *", true, "Every hour"],
      ["0 */1 * * *", true, "Every hour"],
      ["0 */2 * * *", true, "Every 2 hours"],
      ["30 0 * * *", true, "Every day at 12:30 AM"],
      ["0 9 * * 1-5", true, "Weekdays at 9:00 AM"],
      ["15 18 * * 0,6", true, "Weekends at 6:15 PM"],
      ["0 12 1 * *", true, "0 12 1 * *"],
      ["bad", true, "bad"],
      ["2026-12-01T00:00:00Z", false, "One-time"],
    ];
    mockApi.listCronJobs.mockResolvedValue(
      cases.map(([schedule, recurring], i) => job({ id: `c${i}`, name: `Job ${i}`, schedule, recurring })),
    );
    render(<CronManager embedded />);
    await screen.findByText("Job 0");
    for (const [, , label] of cases) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("formats next-run times in minutes, days, and 'now'", async () => {
    mockApi.listCronJobs.mockResolvedValue([
      job({ id: "m", name: "M", nextRunAt: NOW + 10 * 60_000 + 30_000 }),
      job({ id: "d", name: "D", nextRunAt: NOW + 3 * 86_400_000 + 60_000 }),
      job({ id: "n", name: "N", nextRunAt: NOW - 1000 }),
    ]);
    render(<CronManager embedded />);
    await screen.findByText("M");
    expect(screen.getByText(/^Next in (9|10)m$/)).toBeInTheDocument();
    expect(screen.getByText("Next in 3d")).toBeInTheDocument();
    expect(screen.getByText("Next now")).toBeInTheDocument();
  });
});

// ─── Embedded layout: actions ─────────────────────────────────────────────────

describe("CronManager (embedded) actions", () => {
  beforeEach(() => {
    mockApi.listCronJobs.mockResolvedValue([job()]);
  });

  it("toggles, runs, and deletes a job via the api", async () => {
    let resolveRun: () => void = () => {};
    mockApi.toggleCronJob.mockResolvedValue({});
    mockApi.runCronJob.mockReturnValue(new Promise<void>((r) => { resolveRun = r; }));
    mockApi.deleteCronJob.mockResolvedValue({});
    render(<CronManager embedded />);
    await screen.findByText("Nightly tests");

    fireEvent.click(screen.getByTitle("Disable"));
    await waitFor(() => expect(mockApi.toggleCronJob).toHaveBeenCalledWith("j1"));

    // While running, the run button is disabled and titled "Running...".
    fireEvent.click(screen.getByLabelText("Run now"));
    await waitFor(() => expect(screen.getByLabelText("Run now")).toBeDisabled());
    expect(screen.getByTitle("Running...")).toBeInTheDocument();
    resolveRun();
    await waitFor(() => expect(screen.getByLabelText("Run now")).not.toBeDisabled());
    expect(mockApi.runCronJob).toHaveBeenCalledWith("j1");

    fireEvent.click(screen.getByLabelText("Delete"));
    await waitFor(() => expect(mockApi.deleteCronJob).toHaveBeenCalledWith("j1"));
  });

  // Failures of row actions surface in the page-level error banner.
  it("shows api errors from row actions", async () => {
    mockApi.toggleCronJob.mockRejectedValue(new Error("toggle failed"));
    mockApi.runCronJob.mockRejectedValue("run failed");
    mockApi.deleteCronJob.mockRejectedValue(new Error("delete failed"));
    render(<CronManager embedded />);
    await screen.findByText("Nightly tests");

    fireEvent.click(screen.getByTitle("Disable"));
    expect(await screen.findByText("toggle failed")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Run now"));
    expect(await screen.findByText("run failed")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(await screen.findByText("delete failed")).toBeInTheDocument();
  });

  // Edit prefills the form from the job, saves trimmed values, and closes.
  it("edits a job and saves the changes", async () => {
    mockApi.updateCronJob.mockResolvedValue({});
    render(<CronManager embedded />);
    await screen.findByText("Nightly tests");

    fireEvent.click(screen.getByLabelText("Edit"));
    expect(screen.getByDisplayValue("Nightly tests")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Task name/), { target: { value: "  Renamed  " } });
    fireEvent.click(screen.getByText("Every hour"));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mockApi.updateCronJob).toHaveBeenCalledWith("j1", expect.objectContaining({
      name: "Renamed",
      prompt: "Run the test suite",
      schedule: "0 * * * *",
      recurring: true,
      cwd: "/work/repo",
    })));
    await waitFor(() => expect(screen.queryByText("Save")).not.toBeInTheDocument());
  });

  it("converts a one-time edit date to an ISO schedule and reports save errors", async () => {
    mockApi.updateCronJob.mockRejectedValue(new Error("save failed"));
    const { container } = render(<CronManager embedded />);
    await screen.findByText("Nightly tests");

    fireEvent.click(screen.getByLabelText("Edit"));
    fireEvent.click(screen.getByText("One-time"));
    const dateInput = container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2030-01-02T03:04" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mockApi.updateCronJob).toHaveBeenCalledWith("j1", expect.objectContaining({
      recurring: false,
      schedule: new Date("2030-01-02T03:04").toISOString(),
    })));
    expect(await screen.findByText("save failed")).toBeInTheDocument();
  });

  // Save is a no-op while name or prompt is blank; Cancel leaves edit mode.
  it("ignores save with a blank name and cancels editing", async () => {
    render(<CronManager embedded />);
    await screen.findByText("Nightly tests");
    fireEvent.click(screen.getByLabelText("Edit"));
    fireEvent.change(screen.getByPlaceholderText(/Task name/), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save"));
    expect(mockApi.updateCronJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
  });

  // Deleting a different job while one is being edited keeps the edit form open.
  it("keeps the edit form open when another job is deleted", async () => {
    mockApi.deleteCronJob.mockResolvedValue({});
    mockApi.listCronJobs.mockResolvedValue([job(), job({ id: "j2", name: "Other" })]);
    render(<CronManager embedded />);
    await screen.findByText("Other");
    fireEvent.click(screen.getAllByLabelText("Edit")[0]);
    // j1 is now an edit form, so the only Delete button left belongs to j2.
    fireEvent.click(screen.getByLabelText("Delete"));
    await waitFor(() => expect(mockApi.deleteCronJob).toHaveBeenCalledWith("j2"));
    expect(screen.getByText("Save")).toBeInTheDocument();
  });
});

// ─── Embedded layout: create form ─────────────────────────────────────────────

describe("CronManager (embedded) create form", () => {
  // The Create button stays disabled until name and prompt are filled; a
  // successful create sends the trimmed payload and closes the form.
  it("creates a recurring job from a preset", async () => {
    mockApi.createCronJob.mockResolvedValue({});
    render(<CronManager embedded />);
    fireEvent.click(await screen.findByText("New Task"));

    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    fillForm(" Daily ", " Do it ");
    fireEvent.click(screen.getByText("Weekdays at 9am"));
    expect(screen.getByText("Weekdays at 9:00 AM")).toBeInTheDocument();
    fireEvent.click(create);

    await waitFor(() => expect(mockApi.createCronJob).toHaveBeenCalledWith(expect.objectContaining({
      name: "Daily",
      prompt: "Do it",
      schedule: "0 9 * * 1-5",
      recurring: true,
      backendType: "claude",
      cwd: undefined,
    })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument());
  });

  it("accepts a custom cron expression", async () => {
    mockApi.createCronJob.mockResolvedValue({});
    render(<CronManager embedded />);
    fireEvent.click(await screen.findByText("New Task"));
    fillForm("Custom", "Go");
    fireEvent.change(screen.getByPlaceholderText(/Cron expression/), { target: { value: "*/15 * * * *" } });
    expect(screen.getByText("Every 15 minutes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockApi.createCronJob).toHaveBeenCalledWith(expect.objectContaining({ schedule: "*/15 * * * *" })));
  });

  it("creates a one-time job with an ISO schedule and a picked folder", async () => {
    mockApi.createCronJob.mockResolvedValue({});
    const { container } = render(<CronManager embedded />);
    fireEvent.click(await screen.findByText("New Task"));
    fillForm("Once", "Run once");
    fireEvent.click(screen.getByText("One-time"));
    fireEvent.change(container.querySelector('input[type="datetime-local"]') as HTMLInputElement, {
      target: { value: "2030-05-06T07:08" },
    });

    // Folder picker: label shows the basename of the chosen path.
    fireEvent.click(screen.getByText("Select folder"));
    fireEvent.click(screen.getByText("pick-folder"));
    expect(screen.getByText("my-repo")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close-folder-picker"));
    expect(screen.queryByText("pick-folder")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Recurring"));
    fireEvent.click(screen.getByText("One-time"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockApi.createCronJob).toHaveBeenCalledWith(expect.objectContaining({
      recurring: false,
      schedule: new Date("2030-05-06T07:08").toISOString(),
      cwd: "/work/my-repo",
    })));
  });

  it("shows create errors inside the form", async () => {
    mockApi.createCronJob.mockRejectedValue(new Error("create failed"));
    render(<CronManager embedded />);
    fireEvent.click(await screen.findByText("New Task"));
    fillForm("X", "Y");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("create failed")).toBeInTheDocument();
    // Toggling the form closed hides it (Cancel label on the toolbar button).
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByPlaceholderText(/Task name/)).not.toBeInTheDocument();
  });

  // Switching the backend resets the model to that backend's default and
  // fetches that backend's live list.
  it("switches the backend to Codex and loads its models", async () => {
    render(<CronManager embedded />);
    fireEvent.click(await screen.findByText("New Task"));
    const trigger = screen.getByRole("button", { name: /Claude Code/ });
    fireEvent.click(trigger);
    fireEvent.click(within(trigger.parentElement!).getByRole("button", { name: "Codex" }));
    await waitFor(() => expect(mockApi.getBackendModels).toHaveBeenCalledWith("codex"));
    expect(screen.getByRole("button", { name: /^Codex$/ })).toBeInTheDocument();
  });
});

// ─── Modal layout ─────────────────────────────────────────────────────────────

describe("CronManager (modal)", () => {
  it("renders in a portal and closes via the close button and the backdrop", async () => {
    const onClose = vi.fn();
    render(<CronManager onClose={onClose} />);
    expect(await screen.findByText("No scheduled tasks yet.")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "Scheduled Tasks" });

    // Clicks inside the panel don't close it.
    fireEvent.click(heading);
    expect(onClose).not.toHaveBeenCalled();

    // The close button is the only button in the panel header.
    fireEvent.click(within(heading.parentElement!.parentElement!).getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(document.body.querySelector(".fixed.inset-0") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows a loading state", () => {
    mockApi.listCronJobs.mockReturnValue(new Promise(() => {}));
    render(<CronManager />);
    expect(screen.getByText("Loading scheduled tasks...")).toBeInTheDocument();
  });

  it("lists jobs with metadata and runs row actions", async () => {
    mockApi.listCronJobs.mockResolvedValue([
      job({ nextRunAt: NOW + 7200_000 + 60_000, lastRunAt: NOW - 60_000, totalRuns: 2 }),
      job({ id: "j2", name: "Codex job", backendType: "codex", enabled: false, consecutiveFailures: 1, lastRunAt: NOW - 60_000, totalRuns: 1, cwd: "" }),
    ]);
    mockApi.toggleCronJob.mockResolvedValue({});
    mockApi.runCronJob.mockResolvedValue({});
    mockApi.deleteCronJob.mockResolvedValue({});
    render(<CronManager />);

    expect(await screen.findByText("Nightly tests")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("1 fail")).toBeInTheDocument();
    expect(screen.getByText("Next: in 2h")).toBeInTheDocument();
    expect(screen.getByText("2 runs")).toBeInTheDocument();
    expect(screen.getByText("/work/repo")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Enable"));
    await waitFor(() => expect(mockApi.toggleCronJob).toHaveBeenCalledWith("j2"));
    fireEvent.click(screen.getAllByText("Run Now")[0]);
    await waitFor(() => expect(mockApi.runCronJob).toHaveBeenCalledWith("j1"));
    fireEvent.click(screen.getAllByText("Delete")[1]);
    await waitFor(() => expect(mockApi.deleteCronJob).toHaveBeenCalledWith("j2"));
  });

  it("edits a job inline and saves or cancels", async () => {
    mockApi.listCronJobs.mockResolvedValue([job()]);
    mockApi.updateCronJob.mockRejectedValueOnce(new Error("nope")).mockResolvedValue({});
    render(<CronManager />);
    await screen.findByText("Nightly tests");

    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByDisplayValue("Run the test suite")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("nope")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(mockApi.updateCronJob).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Save")).not.toBeInTheDocument());

    // Both Cancel buttons (header + form) leave edit mode.
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getAllByText("Cancel")[0]);
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getAllByText("Cancel")[1]);
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
  });

  it("creates a job from the collapsible create section", async () => {
    mockApi.createCronJob.mockResolvedValue({});
    render(<CronManager />);
    fireEvent.click(await screen.findByText("New Scheduled Task"));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fillForm("Modal job", "Prompt");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockApi.createCronJob).toHaveBeenCalledWith(expect.objectContaining({ name: "Modal job" })));
  });
});

