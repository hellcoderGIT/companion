// @vitest-environment jsdom
// Tests for the MagicUIView session view.
//
// Validates the fixed layout contract of magic mode (mini output strip,
// full-width dashboard, Composer) and — safety-critical — the decision
// fallback machinery: pending decisions are handed to the dashboard first;
// the classic PermissionBanner appears only when the runtime misses the 4s
// render-ACK (or reports an error), and it is sticky per request so a
// decision can never be lost.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

const mockSendToSession = vi.fn();

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
  sendMagicUiSync: vi.fn(),
}));

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

// Capture the decision props handed to the dashboard so tests can drive the
// ack/response callbacks like the real iframe runtime would.
interface CapturedDashboardProps {
  decisions?: Array<{ requestId: string }>;
  onDecisionAck?: (id: string) => void;
  onDecisionResponse?: (id: string, response: unknown) => void;
  onRuntimeError?: (message: string) => void;
}
let dashboardProps: CapturedDashboardProps = {};
vi.mock("./MagicUIDashboard.js", () => ({
  MagicUIDashboard: (props: CapturedDashboardProps & { sessionId: string }) => {
    dashboardProps = props;
    return <div data-testid="magic-dashboard">{props.sessionId}</div>;
  },
}));

import { MagicUIView } from "./MagicUIView.js";

function makePerm(id: string, tool = "Bash") {
  return {
    request_id: id,
    tool_name: tool,
    input: { command: "echo hi" },
    tool_use_id: `t-${id}`,
    timestamp: 1,
  };
}

const mockRemovePermission = vi.fn();

function setStore(opts: {
  pending?: Array<ReturnType<typeof makePerm>>;
  connStatus?: "connected" | "connecting" | "disconnected";
  cliConnected?: boolean;
}) {
  const pendingMap = new Map((opts.pending ?? []).map((p) => [p.request_id, p]));
  mockStoreState = {
    pendingPermissions: new Map([["sess-1", pendingMap]]),
    connectionStatus: new Map([["sess-1", opts.connStatus ?? "connected"]]),
    cliConnected: new Map([["sess-1", opts.cliConnected ?? true]]),
    removePermission: mockRemovePermission,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  dashboardProps = {};
  setStore({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MagicUIView", () => {
  it("renders the mini output strip, dashboard area and composer", () => {
    render(<MagicUIView sessionId="sess-1" />);
    expect(screen.getByTestId("message-feed")).toHaveTextContent("sess-1");
    expect(screen.getByTestId("magic-dashboard")).toHaveTextContent("sess-1");
    expect(screen.getByTestId("composer")).toHaveTextContent("sess-1");
  });

  it("hands pending decisions to the dashboard, not the banner, at first", () => {
    setStore({ pending: [makePerm("req-1")] });
    render(<MagicUIView sessionId="sess-1" />);
    expect(dashboardProps.decisions?.map((d) => d.requestId)).toEqual(["req-1"]);
    expect(screen.queryByTestId("permission-req-1")).not.toBeInTheDocument();
  });

  it("shows the fallback banner when the runtime misses the ACK deadline", () => {
    setStore({ pending: [makePerm("req-1")] });
    render(<MagicUIView sessionId="sess-1" />);
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    expect(screen.getByTestId("permission-req-1")).toBeInTheDocument();
    // ...and the request is no longer offered to the dashboard
    expect(dashboardProps.decisions?.map((d) => d.requestId)).toEqual([]);
  });

  it("suppresses the fallback when the runtime ACKs in time", () => {
    setStore({ pending: [makePerm("req-1")] });
    render(<MagicUIView sessionId="sess-1" />);
    act(() => {
      dashboardProps.onDecisionAck?.("req-1");
      vi.advanceTimersByTime(4_100);
    });
    expect(screen.queryByTestId("permission-req-1")).not.toBeInTheDocument();
  });

  it("arms the fallback for all pending requests on a runtime error", () => {
    setStore({ pending: [makePerm("req-1"), makePerm("req-2")] });
    render(<MagicUIView sessionId="sess-1" />);
    act(() => {
      dashboardProps.onRuntimeError?.("boom");
    });
    expect(screen.getByTestId("permission-req-1")).toBeInTheDocument();
    expect(screen.getByTestId("permission-req-2")).toBeInTheDocument();
  });

  it("sends a wire-standard permission_response when the dashboard decides", () => {
    setStore({ pending: [makePerm("req-1")] });
    render(<MagicUIView sessionId="sess-1" />);
    act(() => {
      dashboardProps.onDecisionResponse?.("req-1", { action: "deny" });
    });
    expect(mockSendToSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      type: "permission_response",
      request_id: "req-1",
      behavior: "deny",
    }));
    expect(mockRemovePermission).toHaveBeenCalledWith("sess-1", "req-1");
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
    vi.useRealTimers();
    setStore({ pending: [makePerm("req-1")] });
    const { container } = render(<MagicUIView sessionId="sess-1" />);
    const { axe } = await import("vitest-axe");
    expect(await axe(container)).toHaveNoViolations();
  });
});
