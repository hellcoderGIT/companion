import type { Hono } from "hono";
import {
  cancelLogin,
  getAccountStatus,
  getLoginStatus,
  logout,
  startLogin,
  submitCode,
} from "../claude-auth.js";

/**
 * Claude Code sign-in from Settings instead of a terminal.
 *
 * Two-step by nature: POST /login returns an authorize URL, the user approves
 * out-of-band, then POST /login/code carries the code they were shown back.
 *
 * Following the tailscale/codex-auth convention, failures that carry useful
 * detail are returned as 200 with an `error` field rather than a non-2xx
 * status, so the frontend `post()` helper doesn't throw the detail away.
 */
export function registerClaudeAuthRoutes(api: Hono): void {
  api.get("/claude/auth/account", async (c) => {
    return c.json(await getAccountStatus());
  });

  api.get("/claude/auth/login", (c) => {
    return c.json(getLoginStatus());
  });

  api.post("/claude/auth/login", async (c) => {
    try {
      return c.json(await startLogin());
    } catch (e) {
      return c.json({ state: "error" as const, error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.post("/claude/auth/login/code", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : "";
    try {
      return c.json(await submitCode(code));
    } catch (e) {
      return c.json({ state: "error" as const, error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.post("/claude/auth/login/cancel", (c) => {
    return c.json(cancelLogin());
  });

  api.post("/claude/auth/logout", async (c) => {
    return c.json(await logout());
  });
}
