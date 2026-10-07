import { describe, it, expect } from "vitest";
import { filterSessions } from "./session-search.js";
import type { SessionItem } from "./project-grouping.js";

function makeItem(id: string, overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id,
    model: "claude-opus-5-5",
    cwd: "/srv/mc-agent",
    gitBranch: "",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: false,
    isReconnecting: false,
    status: null,
    sdkState: null,
    createdAt: 0,
    archived: false,
    backendType: "claude",
    repoRoot: "",
    permCount: 0,
    ...overrides,
  };
}

describe("filterSessions", () => {
  const sessions = [
    makeItem("a", { cwd: "/srv/mc-agent" }),
    makeItem("b", { cwd: "/srv/mc-agent/UserPlayground", repoRoot: "/srv/mc-agent", gitBranch: "feat/pim" }),
    makeItem("c", { cwd: "/srv/mc-procurement", cronJobName: "Nightly backup" }),
  ];
  const names = new Map([
    ["a", "MA_MovingAvgSync"],
    ["b", "MA_PimQuestions"],
    ["c", "MA_ProkuUploadFile"],
  ]);
  const ids = (list: SessionItem[]) => list.map((s) => s.id);

  it("returns the input unchanged (same order) with no query and no project", () => {
    expect(filterSessions(sessions, "   ", null, names)).toBe(sessions);
  });

  it("matches session names case-insensitively", () => {
    expect(ids(filterSessions(sessions, "pimquest", null, names))).toEqual(["b"]);
  });

  it("requires every whitespace-separated term to match (AND)", () => {
    expect(ids(filterSessions(sessions, "ma_ agent", null, names))).toEqual(["a", "b"]);
    expect(ids(filterSessions(sessions, "moving procurement", null, names))).toEqual([]);
  });

  it("matches cwd, branch and cron job name", () => {
    expect(ids(filterSessions(sessions, "UserPlayground", null, names))).toEqual(["b"]);
    expect(ids(filterSessions(sessions, "feat/pim", null, names))).toEqual(["b"]);
    expect(ids(filterSessions(sessions, "nightly", null, names))).toEqual(["c"]);
  });

  it("filters by project key using the repo root, including sub-directories", () => {
    expect(ids(filterSessions(sessions, "", "/srv/mc-agent", names))).toEqual(["a", "b"]);
  });

  it("combines project filter and query", () => {
    expect(ids(filterSessions(sessions, "pim", "/srv/mc-agent", names))).toEqual(["b"]);
    expect(ids(filterSessions(sessions, "proku", "/srv/mc-agent", names))).toEqual([]);
  });
});
