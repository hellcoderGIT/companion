// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import "vitest-axe/extend-expect";

/**
 * Tests for the in-UI Codex ChatGPT sign-in panel.
 *
 * The panel replaces the old "SSH in and run `codex login`" instructions, so
 * the behaviour that matters is: it shows the device code, polls until the
 * login resolves, and stops polling afterwards (each poll spawns a Codex
 * process server-side, so a runaway poll loop would be costly).
 */

const mockApi = {
  getCodexAccount: vi.fn(),
  getCodexLoginStatus: vi.fn(),
  startCodexLogin: vi.fn(),
  cancelCodexLogin: vi.fn(),
  codexLogout: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getCodexAccount: (...a: unknown[]) => mockApi.getCodexAccount(...a),
    getCodexLoginStatus: (...a: unknown[]) => mockApi.getCodexLoginStatus(...a),
    startCodexLogin: (...a: unknown[]) => mockApi.startCodexLogin(...a),
    cancelCodexLogin: (...a: unknown[]) => mockApi.cancelCodexLogin(...a),
    codexLogout: (...a: unknown[]) => mockApi.codexLogout(...a),
  },
}));

import { CodexAuthPanel } from "./CodexAuthPanel.js";

const SIGNED_OUT = {
  cliAvailable: true, authenticated: false, method: null, email: null, planType: null,
};
const SIGNED_IN = {
  cliAvailable: true, authenticated: true, method: "chatgpt" as const,
  email: "user@example.com", planType: "pro",
};
const PENDING = {
  state: "pending" as const,
  userCode: "ABCD-1234",
  verificationUrl: "https://auth.openai.com/codex/device",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getCodexAccount.mockResolvedValue(SIGNED_OUT);
  mockApi.getCodexLoginStatus.mockResolvedValue({ state: "idle" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CodexAuthPanel", () => {
  it("renders the signed-out state with a sign-in action", async () => {
    render(<CodexAuthPanel />);

    expect(await screen.findByRole("button", { name: /sign in with chatgpt/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("codex-account-status")).toHaveTextContent(/not signed in/i),
    );
  });

  it("shows the signed-in account email and plan", async () => {
    mockApi.getCodexAccount.mockResolvedValue(SIGNED_IN);

    render(<CodexAuthPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("codex-account-status")).toHaveTextContent("user@example.com"),
    );
    expect(screen.getByTestId("codex-account-status")).toHaveTextContent("pro");
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("labels API-key auth distinctly from a ChatGPT subscription", async () => {
    mockApi.getCodexAccount.mockResolvedValue({ ...SIGNED_IN, method: "apiKey", email: null });

    render(<CodexAuthPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("codex-account-status")).toHaveTextContent(/openai api key/i),
    );
  });

  it("displays the device code and verification link after starting a login", async () => {
    mockApi.startCodexLogin.mockResolvedValue(PENDING);
    const user = userEvent.setup();
    render(<CodexAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with chatgpt/i }));

    expect(await screen.findByTestId("codex-user-code")).toHaveTextContent("ABCD-1234");
    const link = screen.getByRole("link", { name: /auth\.openai\.com/i });
    expect(link).toHaveAttribute("href", PENDING.verificationUrl);
    // A pending login must offer a way out, not trap the user.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("polls until the login succeeds, then stops polling and refreshes the account", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi.startCodexLogin.mockResolvedValue(PENDING);
    mockApi.getCodexLoginStatus.mockResolvedValue({ state: "idle" });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<CodexAuthPanel />);
    await user.click(await screen.findByRole("button", { name: /sign in with chatgpt/i }));
    await screen.findByTestId("codex-user-code");

    mockApi.getCodexLoginStatus.mockResolvedValue({ state: "success" });
    mockApi.getCodexAccount.mockResolvedValue(SIGNED_IN);

    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(screen.getByText(/signed in to codex/i)).toBeInTheDocument());

    // Polling must stop once resolved: each poll spawns a Codex app-server.
    const callsAfterResolve = mockApi.getCodexLoginStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockApi.getCodexLoginStatus.mock.calls.length).toBe(callsAfterResolve);
  });

  it("surfaces the error message when the login fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi.startCodexLogin.mockResolvedValue(PENDING);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<CodexAuthPanel />);
    await user.click(await screen.findByRole("button", { name: /sign in with chatgpt/i }));
    await screen.findByTestId("codex-user-code");

    mockApi.getCodexLoginStatus.mockResolvedValue({ state: "error", error: "Login was not completed" });
    await vi.advanceTimersByTimeAsync(2100);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Login was not completed"),
    );
  });

  it("shows an error when starting the login fails outright", async () => {
    mockApi.startCodexLogin.mockResolvedValue({ state: "error", error: "Codex CLI not found on PATH" });
    const user = userEvent.setup();
    render(<CodexAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with chatgpt/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Codex CLI not found on PATH"),
    );
  });

  it("cancels an in-flight login and returns to the sign-in action", async () => {
    mockApi.startCodexLogin.mockResolvedValue(PENDING);
    mockApi.cancelCodexLogin.mockResolvedValue({ state: "canceled" });
    const user = userEvent.setup();
    render(<CodexAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with chatgpt/i }));
    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(mockApi.cancelCodexLogin).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("signs out and refreshes the account state", async () => {
    mockApi.getCodexAccount.mockResolvedValue(SIGNED_IN);
    mockApi.codexLogout.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<CodexAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign out/i }));

    expect(mockApi.codexLogout).toHaveBeenCalled();
    // Two reads: the mount probe and the post-logout refresh.
    await waitFor(() => expect(mockApi.getCodexAccount).toHaveBeenCalledTimes(2));
  });

  it("disables sign-in and explains when the Codex CLI is missing", async () => {
    mockApi.getCodexAccount.mockResolvedValue({ ...SIGNED_OUT, cliAvailable: false });

    render(<CodexAuthPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in with chatgpt/i })).toBeDisabled(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/codex cli not found/i);
  });

  it("resumes polling for a login started elsewhere (another tab or before reload)", async () => {
    mockApi.getCodexLoginStatus.mockResolvedValue(PENDING);

    render(<CodexAuthPanel />);

    expect(await screen.findByTestId("codex-user-code")).toHaveTextContent("ABCD-1234");
  });

  it("has no accessibility violations", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<CodexAuthPanel />);
    await screen.findByRole("button", { name: /sign in with chatgpt/i });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
