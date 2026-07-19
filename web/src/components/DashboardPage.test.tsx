// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import type { DashboardData, DashboardSessionEntry } from "../api.js";

// ─── Mock setup ─────────────────────────────────────────────────────────────

const mockApi = {
  getDashboard: vi.fn(),
  runDashboardUpdate: vi.fn(),
  getDashboardRunStatus: vi.fn(),
  archiveSession: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getDashboard: (...args: unknown[]) => mockApi.getDashboard(...args),
    runDashboardUpdate: (...args: unknown[]) => mockApi.runDashboardUpdate(...args),
    getDashboardRunStatus: (...args: unknown[]) => mockApi.getDashboardRunStatus(...args),
    archiveSession: (...args: unknown[]) => mockApi.archiveSession(...args),
  },
}));

import { DashboardPage } from "./DashboardPage.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<DashboardSessionEntry> = {}): DashboardSessionEntry {
  return {
    sessionId: `cli-${Math.random().toString(36).slice(2, 10)}`,
    cwd: "/root/projects/demo",
    gitBranch: "main",
    slug: "fix-login",
    summary: "Fixed the login redirect loop and added a regression test.",
    status: "completed",
    openItems: [],
    archivable: false,
    lastActivityAt: Date.now() - 3_600_000,
    summarizedAt: Date.now() - 1_800_000,
    model: "claude-haiku-4-5",
    ...overrides,
  };
}

function makeData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    enabled: true,
    model: "claude-haiku-4-5",
    runHour: 3,
    anthropicApiKeyConfigured: true,
    runMeta: {
      lastRunAt: Date.now() - 7_200_000,
      lastRunCompletedAt: Date.now() - 7_100_000,
      lastRunStatus: "success",
      trigger: "scheduled",
      model: "claude-haiku-4-5",
      sessionsProcessed: 2,
      sessionsSkipped: 5,
      sessionsFailed: 0,
    },
    progress: { state: "idle", total: 0, processed: 0, failed: 0 },
    sessions: [],
    ...overrides,
  };
}

// ─── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getDashboard.mockResolvedValue(makeData());
  mockApi.runDashboardUpdate.mockResolvedValue({ started: true });
  mockApi.getDashboardRunStatus.mockResolvedValue({
    progress: { state: "idle", total: 0, processed: 0, failed: 0 },
    runMeta: null,
  });
  mockApi.archiveSession.mockResolvedValue({ ok: true });
});

describe("DashboardPage", () => {
  // Basic render: header, last-run info, and the empty state when no summaries exist
  it("renders the header and empty state", async () => {
    render(<DashboardPage />);
    expect(await screen.findByText("Project Dashboard")).toBeInTheDocument();
    expect(await screen.findByText("No session summaries yet")).toBeInTheDocument();
    expect(screen.getByText(/Last updated/)).toBeInTheDocument();
  });

  // Sessions must be grouped under their project directory with status + summary visible
  it("groups sessions by project and shows summaries with status badges", async () => {
    mockApi.getDashboard.mockResolvedValue(makeData({
      sessions: [
        makeSession({ sessionId: "s1", cwd: "/root/projects/demo", status: "completed" }),
        makeSession({
          sessionId: "s2",
          cwd: "/root/projects/other",
          slug: "add-feature",
          status: "in_progress",
          summary: "Halfway through the new export feature.",
          openItems: ["wire the download button"],
        }),
      ],
    }));

    render(<DashboardPage />);
    expect(await screen.findByRole("region", { name: "Project demo" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Project other" })).toBeInTheDocument();
    expect(screen.getByText("Halfway through the new export feature.")).toBeInTheDocument();
    expect(screen.getByText("wire the download button")).toBeInTheDocument();
    // "Completed" also appears as a filter chip label, so scope to at-least-one match.
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  // "Update now" must kick off a run and immediately surface the progress bar
  it("starts a manual update and shows the progress bar", async () => {
    mockApi.getDashboard.mockResolvedValue(makeData({ sessions: [makeSession()] }));
    render(<DashboardPage />);

    const button = await screen.findByRole("button", { name: "Update now" });
    fireEvent.click(button);

    await waitFor(() => expect(mockApi.runDashboardUpdate).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("progressbar", { name: "Dashboard update progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
  });

  // The button must be disabled (not silently failing) without an API key,
  // and the user pointed at Settings
  it("disables Update now and explains when no API key is configured", async () => {
    mockApi.getDashboard.mockResolvedValue(makeData({ anthropicApiKeyConfigured: false }));
    render(<DashboardPage />);

    expect(await screen.findByRole("button", { name: "Update now" })).toBeDisabled();
    expect(screen.getByText(/needs an Anthropic API key/)).toBeInTheDocument();
  });

  // Filter chips narrow the visible sessions
  it("filters sessions with the filter chips", async () => {
    mockApi.getDashboard.mockResolvedValue(makeData({
      sessions: [
        makeSession({ sessionId: "s1", slug: "done-task", status: "completed" }),
        makeSession({ sessionId: "s2", slug: "open-task", status: "in_progress", summary: "Still going." }),
      ],
    }));

    render(<DashboardPage />);
    await screen.findByText("Still going.");

    fireEvent.click(screen.getByRole("button", { name: /Unfinished/ }));
    expect(screen.getByText("Still going.")).toBeInTheDocument();
    expect(screen.queryByText("Fixed the login redirect loop and added a regression test.")).not.toBeInTheDocument();
  });

  // Archivable companion sessions expose an Archive action wired to the sessions API
  it("archives an archivable companion session", async () => {
    mockApi.getDashboard.mockResolvedValue(makeData({
      sessions: [
        makeSession({
          sessionId: "cli-1",
          companionSessionId: "companion-1",
          archivable: true,
          status: "completed",
        }),
      ],
    }));

    render(<DashboardPage />);
    const archiveButton = await screen.findByRole("button", { name: "Archive" });
    fireEvent.click(archiveButton);

    await waitFor(() =>
      expect(mockApi.archiveSession).toHaveBeenCalledWith("companion-1", { linearTransition: "none" }),
    );
    // The archived session disappears from the dashboard list.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument(),
    );
  });

  // External transcripts (not launched via the companion) must be labeled and not archivable
  it("labels external sessions and hides the archive action for them", async () => {
    mockApi.getDashboard.mockResolvedValue(makeData({
      sessions: [makeSession({ archivable: true })], // archivable but no companionSessionId
    }));

    render(<DashboardPage />);
    expect(await screen.findByText("External")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  // Accessibility: no axe violations in the populated state
  it("has no axe accessibility violations", async () => {
    const { axe } = await import("vitest-axe");
    mockApi.getDashboard.mockResolvedValue(makeData({
      sessions: [
        makeSession({ sessionId: "s1", status: "completed" }),
        makeSession({ sessionId: "s2", status: "awaiting_user", slug: "waiting-task" }),
      ],
    }));

    const { container } = render(<DashboardPage />);
    await screen.findByText("Project Dashboard");
    await screen.findByRole("region", { name: "Project demo" });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
