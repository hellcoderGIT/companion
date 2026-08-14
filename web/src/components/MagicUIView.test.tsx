// @vitest-environment jsdom
// Tests for the MagicUIView session view shell.
//
// Validates the fixed layout contract of magic mode:
// - a small raw-output strip on top (MessageFeed forced to compact density),
// - a full-width dashboard area (placeholder until the runtime mounts),
// - the Composer at the bottom,
// - and — safety-critical — the classic PermissionBanner fallback rendering
//   for every pending permission so a decision can never be lost even if the
//   generated dashboard misbehaves.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

let mockStoreState: Record<string, unknown> = {};

vi.mock("../store.js", () => {
  const useStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStoreState);
  useStore.getState = () => mockStoreState;
  return { useStore };
});

// Stub heavy children — their own behavior is covered by their own tests.
vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="message-feed">{sessionId}</div>
  ),
}));
vi.mock("./Composer.js", () => ({
  Composer: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="composer">{sessionId}</div>
  ),
}));
vi.mock("./PermissionBanner.js", () => ({
  PermissionBanner: ({ permission }: { permission: { request_id: string } }) => (
    <div data-testid={`permission-${permission.request_id}`} />
  ),
}));
vi.mock("./MagicUIDashboard.js", () => ({
  MagicUIDashboard: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="magic-dashboard">{sessionId}</div>
  ),
}));

import { MagicUIView } from "./MagicUIView.js";

function setStore(opts: {
  pending?: Array<{ request_id: string }>;
  connStatus?: "connected" | "connecting" | "disconnected";
  cliConnected?: boolean;
}) {
  const pendingMap = new Map(
    (opts.pending ?? []).map((p) => [p.request_id, p]),
  );
  mockStoreState = {
    pendingPermissions: new Map([["sess-1", pendingMap]]),
    connectionStatus: new Map([["sess-1", opts.connStatus ?? "connected"]]),
    cliConnected: new Map([["sess-1", opts.cliConnected ?? true]]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setStore({});
});

describe("MagicUIView", () => {
  it("renders the mini output strip, dashboard area and composer", () => {
    render(<MagicUIView sessionId="sess-1" />);
    expect(screen.getByTestId("message-feed")).toHaveTextContent("sess-1");
    expect(screen.getByTestId("magic-dashboard")).toHaveTextContent("sess-1");
    expect(screen.getByTestId("composer")).toHaveTextContent("sess-1");
  });

  it("renders a fallback permission banner for every pending decision", () => {
    setStore({ pending: [{ request_id: "req-1" }, { request_id: "req-2" }] });
    render(<MagicUIView sessionId="sess-1" />);
    expect(screen.getByTestId("permission-req-1")).toBeInTheDocument();
    expect(screen.getByTestId("permission-req-2")).toBeInTheDocument();
  });

  it("shows a slim notice when the websocket is reconnecting", () => {
    setStore({ connStatus: "disconnected" });
    render(<MagicUIView sessionId="sess-1" />);
    expect(screen.getByText(/reconnecting to session/i)).toBeInTheDocument();
  });

  it("shows a slim notice when the CLI is disconnected", () => {
    setStore({ connStatus: "connected", cliConnected: false });
    render(<MagicUIView sessionId="sess-1" />);
    expect(screen.getByText(/cli disconnected/i)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    setStore({ pending: [{ request_id: "req-1" }] });
    const { container } = render(<MagicUIView sessionId="sess-1" />);
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });
});
