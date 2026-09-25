import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../claude-auth.js", () => ({
  getAccountStatus: vi.fn(),
  getLoginStatus: vi.fn(),
  startLogin: vi.fn(),
  submitCode: vi.fn(),
  cancelLogin: vi.fn(),
  logout: vi.fn(),
}));

import { Hono } from "hono";
import {
  getAccountStatus, getLoginStatus, startLogin, submitCode, cancelLogin, logout,
} from "../claude-auth.js";
import { registerClaudeAuthRoutes } from "./claude-auth-routes.js";

const mockAccount = vi.mocked(getAccountStatus);
const mockLoginStatus = vi.mocked(getLoginStatus);
const mockStart = vi.mocked(startLogin);
const mockSubmit = vi.mocked(submitCode);
const mockCancel = vi.mocked(cancelLogin);
const mockLogout = vi.mocked(logout);

function createApp() {
  const api = new Hono();
  registerClaudeAuthRoutes(api);
  return api;
}

const AUTH_URL = "https://claude.com/cai/oauth/authorize?code=true";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /claude/auth/account", () => {
  it("returns the account status", async () => {
    const status = {
      cliAvailable: true, authenticated: true, method: "claude.ai",
      email: "user@example.com", orgName: "Acme Inc", subscriptionType: "max",
    };
    mockAccount.mockResolvedValue(status);

    const res = await createApp().request("/claude/auth/account");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });
});

describe("GET /claude/auth/login", () => {
  it("returns the in-flight login status for polling/resume", async () => {
    mockLoginStatus.mockReturnValue({ state: "awaiting_code", authUrl: AUTH_URL });

    const res = await createApp().request("/claude/auth/login");

    expect(await res.json()).toEqual({ state: "awaiting_code", authUrl: AUTH_URL });
  });
});

describe("POST /claude/auth/login", () => {
  it("starts a login and returns the authorize URL", async () => {
    mockStart.mockResolvedValue({ state: "awaiting_code", authUrl: AUTH_URL });

    const res = await createApp().request("/claude/auth/login", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "awaiting_code", authUrl: AUTH_URL });
  });

  it("returns 200 with an error field when starting fails", async () => {
    // Non-2xx would make the frontend post() helper discard the detail.
    mockStart.mockRejectedValue(new Error("Claude CLI not found on PATH"));

    const res = await createApp().request("/claude/auth/login", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "error", error: "Claude CLI not found on PATH" });
  });
});

describe("POST /claude/auth/login/code", () => {
  it("forwards the pasted code and reports success", async () => {
    mockSubmit.mockResolvedValue({ state: "success" });

    const res = await createApp().request("/claude/auth/login/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc123" }),
    });

    expect(await res.json()).toEqual({ state: "success" });
    expect(mockSubmit).toHaveBeenCalledWith("abc123");
  });

  it("passes a rejected code back as a retryable awaiting_code", async () => {
    mockSubmit.mockResolvedValue({
      state: "awaiting_code", authUrl: AUTH_URL, error: "That code wasn't accepted.",
    });

    const res = await createApp().request("/claude/auth/login/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "nope" }),
    });

    expect(await res.json()).toMatchObject({ state: "awaiting_code", error: expect.stringMatching(/accepted/) });
  });

  it("treats a missing body as an empty code rather than erroring", async () => {
    mockSubmit.mockResolvedValue({ state: "awaiting_code", error: "Enter the code first." });

    const res = await createApp().request("/claude/auth/login/code", { method: "POST" });

    expect(res.status).toBe(200);
    expect(mockSubmit).toHaveBeenCalledWith("");
  });
});

describe("POST /claude/auth/login/cancel", () => {
  it("cancels the attempt", async () => {
    mockCancel.mockReturnValue({ state: "canceled" });

    const res = await createApp().request("/claude/auth/login/cancel", { method: "POST" });

    expect(await res.json()).toEqual({ state: "canceled" });
  });
});

describe("POST /claude/auth/logout", () => {
  it("signs out", async () => {
    mockLogout.mockResolvedValue({ ok: true });

    const res = await createApp().request("/claude/auth/logout", { method: "POST" });

    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes through a failure reason", async () => {
    mockLogout.mockResolvedValue({ ok: false, error: "not logged in" });

    const res = await createApp().request("/claude/auth/logout", { method: "POST" });

    expect(await res.json()).toEqual({ ok: false, error: "not logged in" });
  });
});
