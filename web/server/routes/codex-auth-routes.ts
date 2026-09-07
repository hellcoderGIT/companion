import type { Hono } from "hono";
import {
  cancelLogin,
  getAccountStatus,
  getLoginStatus,
  logout,
  startDeviceLogin,
} from "../codex-auth.js";

/**
 * Codex ChatGPT-subscription auth, driven from Settings instead of an SSH
 * session. The login is a device-code flow: POST /start returns a user code and
 * a verification URL, the client polls GET /login until it resolves.
 *
 * Following the tailscale-routes convention, failures that carry useful
 * structure are returned as 200 with an `error` field rather than a non-2xx
 * status, so the frontend `post()` helper doesn't throw the detail away.
 */
export function registerCodexAuthRoutes(api: Hono): void {
  // Current account (spawns a short-lived app-server to ask Codex directly).
  api.get("/codex/auth/account", async (c) => {
    return c.json(await getAccountStatus());
  });

  // Poll target for an in-flight (or just-finished) login.
  api.get("/codex/auth/login", (c) => {
    return c.json(getLoginStatus());
  });

  // Begin a device-code login. Idempotent while one is in flight.
  api.post("/codex/auth/login", async (c) => {
    try {
      return c.json(await startDeviceLogin());
    } catch (e) {
      return c.json({
        state: "error" as const,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  api.post("/codex/auth/login/cancel", async (c) => {
    return c.json(await cancelLogin());
  });

  api.post("/codex/auth/logout", async (c) => {
    return c.json(await logout());
  });
}
