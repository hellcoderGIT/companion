import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../codex-auth.js", () => ({
  getAccountStatus: vi.fn(),
  getLoginStatus: vi.fn(),
  startDeviceLogin: vi.fn(),
  cancelLogin: vi.fn(),
  logout: vi.fn(),
}));

import { Hono } from "hono";
import {
  getAccountStatus, getLoginStatus, startDeviceLogin, cancelLogin, logout,
} from "../codex-auth.js";
import { registerCodexAuthRoutes } from "./codex-auth-routes.js";

const mockAccount = vi.mocked(getAccountStatus);
const mockLoginStatus = vi.mocked(getLoginStatus);
const mockStart = vi.mocked(startDeviceLogin);
const mockCancel = vi.mocked(cancelLogin);
const mockLogout = vi.mocked(logout);

function createApp() {
  const api = new Hono();
  registerCodexAuthRoutes(api);
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /codex/auth/account", () => {
  it("returns the current account status", async () => {
    const status = {
      cliAvailable: true, authenticated: true, method: "chatgpt" as const,
      email: "user@example.com", planType: "pro",
    };
    mockAccount.mockResolvedValue(status);

    const res = await createApp().request("/codex/auth/account");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });
});

describe("GET /codex/auth/login", () => {
  it("returns the pending login status for the client to poll", async () => {
    const status = {
      state: "pending" as const,
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    };
    mockLoginStatus.mockReturnValue(status);

    const res = await createApp().request("/codex/auth/login");

    expect(await res.json()).toEqual(status);
  });
});

describe("POST /codex/auth/login", () => {
  it("starts a device login and returns the user code", async () => {
    mockStart.mockResolvedValue({
      state: "pending", userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    });

    const res = await createApp().request("/codex/auth/login", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "pending", userCode: "ABCD-1234" });
  });

  it("returns 200 with an error field when starting fails, so the client keeps the detail", async () => {
    // The frontend post() helper throws away the body on non-2xx, so structured
    // failures are deliberately reported as 200 (same convention as tailscale).
    mockStart.mockRejectedValue(new Error("Codex CLI not found on PATH"));

    const res = await createApp().request("/codex/auth/login", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "error", error: "Codex CLI not found on PATH" });
  });
});

describe("POST /codex/auth/login/cancel", () => {
  it("cancels the in-flight login", async () => {
    mockCancel.mockResolvedValue({ state: "canceled" });

    const res = await createApp().request("/codex/auth/login/cancel", { method: "POST" });

    expect(await res.json()).toEqual({ state: "canceled" });
    expect(mockCancel).toHaveBeenCalled();
  });
});

describe("POST /codex/auth/logout", () => {
  it("signs the account out", async () => {
    mockLogout.mockResolvedValue({ ok: true });

    const res = await createApp().request("/codex/auth/logout", { method: "POST" });

    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes through a logout failure reason", async () => {
    mockLogout.mockResolvedValue({ ok: false, error: "boom" });

    const res = await createApp().request("/codex/auth/logout", { method: "POST" });

    expect(await res.json()).toEqual({ ok: false, error: "boom" });
  });
});
