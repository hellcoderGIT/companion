// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import "vitest-axe/extend-expect";

/**
 * Tests for the in-UI Claude sign-in panel.
 *
 * This replaces "SSH in and run `claude setup-token`". The flow is paste-code:
 * the panel shows a link, the user approves elsewhere, then pastes the code
 * back. The behaviours worth pinning down are the account summary line, and
 * that a rejected code leaves the input open for a retry instead of forcing a
 * brand new link.
 */

const mockApi = {
  getClaudeAccount: vi.fn(),
  getClaudeLoginStatus: vi.fn(),
  startClaudeLogin: vi.fn(),
  submitClaudeLoginCode: vi.fn(),
  cancelClaudeLogin: vi.fn(),
  claudeLogout: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getClaudeAccount: (...a: unknown[]) => mockApi.getClaudeAccount(...a),
    getClaudeLoginStatus: (...a: unknown[]) => mockApi.getClaudeLoginStatus(...a),
    startClaudeLogin: (...a: unknown[]) => mockApi.startClaudeLogin(...a),
    submitClaudeLoginCode: (...a: unknown[]) => mockApi.submitClaudeLoginCode(...a),
    cancelClaudeLogin: (...a: unknown[]) => mockApi.cancelClaudeLogin(...a),
    claudeLogout: (...a: unknown[]) => mockApi.claudeLogout(...a),
  },
}));

import { ClaudeAuthPanel } from "./ClaudeAuthPanel.js";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a";

const SIGNED_OUT = {
  cliAvailable: true, authenticated: false, method: null,
  email: null, orgName: null, subscriptionType: null,
};
const SIGNED_IN = {
  cliAvailable: true, authenticated: true, method: "claude.ai",
  email: "user@example.com", orgName: "Acme Inc", subscriptionType: "max",
};
const AWAITING = { state: "awaiting_code" as const, authUrl: AUTH_URL };

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getClaudeAccount.mockResolvedValue(SIGNED_OUT);
  mockApi.getClaudeLoginStatus.mockResolvedValue({ state: "idle" });
});

describe("ClaudeAuthPanel", () => {
  it("renders the signed-out state with a sign-in action", async () => {
    render(<ClaudeAuthPanel />);

    expect(await screen.findByRole("button", { name: /sign in with claude/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("claude-account-status")).toHaveTextContent(/not signed in/i),
    );
  });

  it("shows the account email, plan and org once signed in", async () => {
    mockApi.getClaudeAccount.mockResolvedValue(SIGNED_IN);

    render(<ClaudeAuthPanel />);

    const line = await screen.findByTestId("claude-account-status");
    expect(line).toHaveTextContent("user@example.com");
    expect(line).toHaveTextContent("Max");
    expect(line).toHaveTextContent("Acme Inc");
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("omits the org when it merely restates the email (personal accounts)", async () => {
    // The CLI reports orgName as "<email>'s Organization" for personal plans,
    // which would otherwise print the address twice.
    mockApi.getClaudeAccount.mockResolvedValue({
      ...SIGNED_IN, orgName: "user@example.com's Organization",
    });

    render(<ClaudeAuthPanel />);

    const line = await screen.findByTestId("claude-account-status");
    expect(line).toHaveTextContent("Signed in as user@example.com · Max");
    expect(line).not.toHaveTextContent("Organization");
  });

  it("shows the authorize link and a code input after starting", async () => {
    mockApi.startClaudeLogin.mockResolvedValue(AWAITING);
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    expect(await screen.findByTestId("claude-auth-url")).toHaveAttribute("href", AUTH_URL);
    expect(screen.getByLabelText(/paste the code/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("submits the pasted code and reports success", async () => {
    mockApi.startClaudeLogin.mockResolvedValue(AWAITING);
    mockApi.submitClaudeLoginCode.mockResolvedValue({ state: "success" });
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with claude/i }));
    await user.type(await screen.findByLabelText(/paste the code/i), "my-code-123");
    mockApi.getClaudeAccount.mockResolvedValue(SIGNED_IN);
    await user.click(screen.getByRole("button", { name: /^submit$/i }));

    expect(mockApi.submitClaudeLoginCode).toHaveBeenCalledWith("my-code-123");
    expect(await screen.findByText(/signed in to claude/i)).toBeInTheDocument();
  });

  it("submits on Enter as well as the button", async () => {
    mockApi.startClaudeLogin.mockResolvedValue(AWAITING);
    mockApi.submitClaudeLoginCode.mockResolvedValue({ state: "success" });
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with claude/i }));
    await user.type(await screen.findByLabelText(/paste the code/i), "my-code-123{Enter}");

    await waitFor(() => expect(mockApi.submitClaudeLoginCode).toHaveBeenCalledWith("my-code-123"));
  });

  it("keeps the input open for a retry when the code is rejected", async () => {
    mockApi.startClaudeLogin.mockResolvedValue(AWAITING);
    mockApi.submitClaudeLoginCode.mockResolvedValue({
      state: "awaiting_code", authUrl: AUTH_URL,
      error: "That code wasn't accepted. Make sure you copied all of it, then try again.",
    });
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with claude/i }));
    await user.type(await screen.findByLabelText(/paste the code/i), "bad");
    await user.click(screen.getByRole("button", { name: /^submit$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/wasn't accepted/i);
    // Still in the paste step, with the same link — no need to start over.
    expect(screen.getByLabelText(/paste the code/i)).toBeInTheDocument();
    expect(screen.getByTestId("claude-auth-url")).toHaveAttribute("href", AUTH_URL);
  });

  it("disables submit until a code is entered", async () => {
    mockApi.startClaudeLogin.mockResolvedValue(AWAITING);
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    expect(await screen.findByRole("button", { name: /^submit$/i })).toBeDisabled();
  });

  it("surfaces a failure to start the login", async () => {
    mockApi.startClaudeLogin.mockResolvedValue({
      state: "error", error: "Claude CLI not found on PATH",
    });
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Claude CLI not found on PATH"),
    );
  });

  it("cancels an in-flight attempt and returns to the sign-in action", async () => {
    mockApi.startClaudeLogin.mockResolvedValue(AWAITING);
    mockApi.cancelClaudeLogin.mockResolvedValue({ state: "canceled" });
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign in with claude/i }));
    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(mockApi.cancelClaudeLogin).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("signs out and refreshes the account", async () => {
    mockApi.getClaudeAccount.mockResolvedValue(SIGNED_IN);
    mockApi.claudeLogout.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ClaudeAuthPanel />);

    await user.click(await screen.findByRole("button", { name: /sign out/i }));

    expect(mockApi.claudeLogout).toHaveBeenCalled();
    // Mount probe + post-logout refresh.
    await waitFor(() => expect(mockApi.getClaudeAccount).toHaveBeenCalledTimes(2));
  });

  it("disables sign-in and explains when the Claude CLI is missing", async () => {
    mockApi.getClaudeAccount.mockResolvedValue({ ...SIGNED_OUT, cliAvailable: false });

    render(<ClaudeAuthPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in with claude/i })).toBeDisabled(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/claude cli not found/i);
  });

  it("resumes an attempt started elsewhere (another tab or before a reload)", async () => {
    mockApi.getClaudeLoginStatus.mockResolvedValue(AWAITING);

    render(<ClaudeAuthPanel />);

    expect(await screen.findByTestId("claude-auth-url")).toHaveAttribute("href", AUTH_URL);
  });

  it("has no accessibility violations", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ClaudeAuthPanel />);
    await screen.findByRole("button", { name: /sign in with claude/i });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
