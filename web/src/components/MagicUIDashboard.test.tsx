// @vitest-environment jsdom
// Tests for the MagicUI iframe host + postMessage bridge.
//
// Security-relevant behaviors pinned here:
// - the iframe is sandboxed with allow-scripts ONLY (no allow-same-origin —
//   the opaque origin is the security boundary),
// - inbound messages are authenticated by event.source identity, not origin
//   (an opaque origin serializes as "null" so origin checks are useless),
// - decision responses/acks are forwarded to the host callbacks,
// - copy requests are executed host-side (the sandboxed iframe has no
//   reliable clipboard access).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";

const mockSendMagicUiSync = vi.fn();

vi.mock("../ws.js", () => ({
  sendMagicUiSync: (...args: unknown[]) => mockSendMagicUiSync(...args),
}));

// ?raw imports resolve through vite in vitest, but stub them for speed —
// the srcdoc contents are covered by the bridge tests.
vi.mock("../magic-ui/bridge.js", async () => {
  const actual = await vi.importActual<typeof import("../magic-ui/bridge.js")>("../magic-ui/bridge.js");
  return { ...actual, buildMagicUiSrcdoc: (theme: string) => `<!doctype html><body data-theme="${theme}"></body>` };
});

let mockStoreState: Record<string, unknown> = {};

vi.mock("../store.js", () => {
  const useStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStoreState);
  useStore.getState = () => mockStoreState;
  return { useStore };
});

import { MagicUIDashboard } from "./MagicUIDashboard.js";
import { MAGIC_UI_CHANNEL } from "../magic-ui/bridge.js";

const DASH_STATE = { version: 3, slots: {}, layout: [], decisionLog: [], openItems: [], sessionSummary: "", status: "live", updatedAt: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreState = {
    darkMode: false,
    magicUiState: new Map([["sess-1", DASH_STATE]]),
  };
});

function getIframe(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("iframe not rendered");
  return iframe;
}

function emitFromIframe(iframe: HTMLIFrameElement, data: Record<string, unknown>) {
  const event = new MessageEvent("message", {
    data,
    source: iframe.contentWindow,
  });
  window.dispatchEvent(event);
}

describe("MagicUIDashboard", () => {
  it("renders a sandboxed iframe with allow-scripts only", () => {
    const { container } = render(<MagicUIDashboard sessionId="sess-1" />);
    const iframe = getIframe(container);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe).toHaveAttribute("title", "Magic dashboard");
  });

  it("requests a dashboard snapshot on mount", () => {
    render(<MagicUIDashboard sessionId="sess-1" />);
    expect(mockSendMagicUiSync).toHaveBeenCalledWith("sess-1");
  });

  it("answers the runtime ready handshake with init + current state", async () => {
    const { container } = render(<MagicUIDashboard sessionId="sess-1" />);
    const iframe = getIframe(container);
    const posted: unknown[] = [];
    // jsdom iframes have a contentWindow; capture what the host posts to it.
    vi.spyOn(iframe.contentWindow as Window, "postMessage").mockImplementation((msg: unknown) => {
      posted.push(msg);
    });
    emitFromIframe(iframe, { channel: MAGIC_UI_CHANNEL, type: "ready" });
    await waitFor(() => {
      expect(posted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "init", theme: "light" }),
          expect.objectContaining({ type: "state", state: DASH_STATE }),
        ]),
      );
    });
  });

  it("ignores messages that are not from its own iframe", () => {
    const onDecisionResponse = vi.fn();
    render(<MagicUIDashboard sessionId="sess-1" onDecisionResponse={onDecisionResponse} />);
    // source: window (an attacker frame), not the iframe's contentWindow
    window.dispatchEvent(new MessageEvent("message", {
      data: { channel: MAGIC_UI_CHANNEL, type: "decision_response", requestId: "r1", response: { action: "allow" } },
      source: window,
    }));
    expect(onDecisionResponse).not.toHaveBeenCalled();
  });

  it("forwards decision acks and responses from the runtime", () => {
    const onDecisionAck = vi.fn();
    const onDecisionResponse = vi.fn();
    const { container } = render(
      <MagicUIDashboard sessionId="sess-1" onDecisionAck={onDecisionAck} onDecisionResponse={onDecisionResponse} />,
    );
    const iframe = getIframe(container);
    emitFromIframe(iframe, { channel: MAGIC_UI_CHANNEL, type: "decision_ack", requestId: "req-1" });
    emitFromIframe(iframe, {
      channel: MAGIC_UI_CHANNEL,
      type: "decision_response",
      requestId: "req-1",
      response: { action: "deny" },
    });
    expect(onDecisionAck).toHaveBeenCalledWith("req-1");
    expect(onDecisionResponse).toHaveBeenCalledWith("req-1", { action: "deny" });
  });

  it("executes copy requests host-side via the clipboard API", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<MagicUIDashboard sessionId="sess-1" />);
    emitFromIframe(getIframe(container), {
      channel: MAGIC_UI_CHANNEL,
      type: "copy_request",
      text: "bun run migrate",
    });
    expect(writeText).toHaveBeenCalledWith("bun run migrate");
  });

  it("reports runtime errors to the host callback", () => {
    const onRuntimeError = vi.fn();
    const { container } = render(<MagicUIDashboard sessionId="sess-1" onRuntimeError={onRuntimeError} />);
    emitFromIframe(getIframe(container), {
      channel: MAGIC_UI_CHANNEL,
      type: "runtime_error",
      message: "boom",
    });
    expect(onRuntimeError).toHaveBeenCalledWith("boom");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<MagicUIDashboard sessionId="sess-1" />);
    const { axe } = await import("vitest-axe");
    // iframes: false — axe cannot descend into a sandboxed srcdoc iframe in
    // jsdom (and the runtime document is not executed there anyway).
    expect(await axe(container, { iframes: false })).toHaveNoViolations();
  });
});
