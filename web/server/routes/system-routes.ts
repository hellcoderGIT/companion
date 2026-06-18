import type { Hono } from "hono";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { TerminalManager } from "../terminal-manager.js";
import { getUsageLimits } from "../usage-limits.js";
import { getSystemMemory } from "../system-memory.js";
import {
  getUpdateState,
  checkForUpdate,
  isUpdateAvailable,
  setUpdateInProgress,
} from "../update-checker.js";
import { refreshServiceDefinition } from "../service.js";
import { getSettings, updateSettings } from "../settings-manager.js";
import { imagePullManager } from "../image-pull-manager.js";
import { isSandboxEnabled } from "../feature-flags.js";
import { checkCompat, getCompatState } from "../claude-compat-checker.js";
import { pinToVersion, patchBinary, unpatch } from "../claude-patcher.js";
import {
  startCliIngressServer,
  type CliIngressServer,
} from "../cli-ingress-server.js";

/**
 * Module-level handle to the running CLI ingress server (patched-bridge mode).
 * Owned by this module so the patch / unpatch routes can start and stop it.
 * Set by the bootstrap in index.ts when settings indicate patched mode at
 * startup; otherwise populated by the /claude-compat/patch route.
 */
let cliIngress: CliIngressServer | null = null;
export function getCliIngressServer(): CliIngressServer | null { return cliIngress; }
export function setCliIngressServer(s: CliIngressServer | null): void { cliIngress = s; }

export function registerSystemRoutes(
  api: Hono,
  deps: {
    launcher: CliLauncher;
    wsBridge: WsBridge;
    terminalManager: TerminalManager;
    updateCheckStaleMs: number;
  },
): void {
  api.get("/usage-limits", async (c) => {
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/system/memory", (c) => {
    return c.json(getSystemMemory());
  });

  api.get("/sessions/:id/usage-limits", async (c) => {
    const sessionId = c.req.param("id");
    const session = deps.wsBridge.getSession(sessionId);
    const empty = { five_hour: null, seven_day: null, extra_usage: null };

    if (session?.backendType === "codex") {
      const rl = deps.wsBridge.getCodexRateLimits(sessionId);
      if (!rl) return c.json(empty);
      const toEpochMs = (value: number): number => (
        value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
      );
      const mapLimit = (l: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null) => {
        if (!l) return null;
        const resetsAtMs = toEpochMs(l.resetsAt);
        return {
          utilization: l.usedPercent,
          resets_at: resetsAtMs ? new Date(resetsAtMs).toISOString() : null,
        };
      };
      return c.json({
        five_hour: mapLimit(rl.primary),
        seven_day: mapLimit(rl.secondary),
        extra_usage: null,
      });
    }

    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/update-check", async (c) => {
    const initialState = getUpdateState();
    const needsRefresh =
      initialState.lastChecked === 0
      || Date.now() - initialState.lastChecked > deps.updateCheckStaleMs;
    if (needsRefresh) {
      await checkForUpdate();
    }

    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
      channel: state.channel,
    });
  });

  api.post("/update-check", async (c) => {
    await checkForUpdate();
    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
      channel: state.channel,
    });
  });

  api.post("/update", async (c) => {
    const state = getUpdateState();
    if (!state.isServiceMode) {
      return c.json(
        { error: "Update & restart is only available in service mode" },
        400,
      );
    }
    if (!isUpdateAvailable()) {
      return c.json({ error: "No update available" }, 400);
    }
    if (state.updateInProgress) {
      return c.json({ error: "Update already in progress" }, 409);
    }

    setUpdateInProgress(true);

    setTimeout(async () => {
      try {
        console.log(
          `[update] Updating @hellcoder/companion to ${state.latestVersion}...`,
        );
        const proc = Bun.spawn(
          ["bun", "install", "-g", `@hellcoder/companion@${state.latestVersion}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          console.error(
            `[update] bun install failed (code ${exitCode}):`,
            stderr,
          );
          setUpdateInProgress(false);
          return;
        }

        // Re-pull Docker image if auto-update is enabled (and sandbox isn't
        // disabled — we never refresh the unmaintained upstream image).
        if (isSandboxEnabled() && getSettings().dockerAutoUpdate) {
          try {
            console.log("[update] Re-pulling Docker image (dockerAutoUpdate enabled)...");
            imagePullManager.pull("the-companion:latest");
            const ready = await imagePullManager.waitForReady("the-companion:latest", 120_000);
            if (ready) {
              console.log("[update] Docker image re-pull complete.");
            } else {
              console.warn("[update] Docker image re-pull failed or timed out, continuing with restart.");
            }
          } catch (err) {
            console.warn("[update] Docker image re-pull error, continuing:", err);
          }
        }

        try {
          refreshServiceDefinition();
          console.log("[update] Service definition refreshed.");
        } catch (err) {
          console.warn("[update] Failed to refresh service definition:", err);
        }

        console.log("[update] Update successful, restarting service...");

        const isLinux = process.platform === "linux";
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        const restartCmd = isLinux
          ? ["systemctl", "--user", "restart", "the-companion.service"]
          : uid !== undefined
            ? ["launchctl", "kickstart", "-k", `gui/${uid}/sh.thecompanion.app`]
            : ["launchctl", "kickstart", "-k", "sh.thecompanion.app"];

        Bun.spawn(restartCmd, {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: isLinux
            ? {
                ...process.env,
                XDG_RUNTIME_DIR:
                  process.env.XDG_RUNTIME_DIR ||
                  `/run/user/${uid ?? 1000}`,
              }
            : undefined,
        });

        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        console.error("[update] Update failed:", err);
        setUpdateInProgress(false);
      }
    }, 100);

    return c.json({
      ok: true,
      message: "Update started. Server will restart shortly.",
    });
  });

  api.get("/terminal", (c) => {
    const terminalId = c.req.query("terminalId");
    const info = deps.terminalManager.getInfo(terminalId || undefined);
    if (!info) return c.json({ active: false });
    return c.json({ active: true, terminalId: info.id, cwd: info.cwd });
  });

  api.post("/terminal/spawn", async (c) => {
    const body = await c.req.json<{ cwd: string; cols?: number; rows?: number; containerId?: string }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const terminalId = deps.terminalManager.spawn(body.cwd, body.cols, body.rows, {
      containerId: body.containerId,
    });
    return c.json({ terminalId });
  });

  api.post("/terminal/kill", async (c) => {
    const body = await c.req.json<{ terminalId?: string }>().catch(() => undefined);
    const terminalId = body?.terminalId?.trim();
    if (!terminalId) return c.json({ error: "terminalId is required" }, 400);
    deps.terminalManager.kill(terminalId);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/message", async (c) => {
    const id = c.req.param("id");
    const session = deps.launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!deps.launcher.isAlive(id)) return c.json({ error: "Session is not running" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    deps.wsBridge.injectUserMessage(id, body.content);
    return c.json({ ok: true, sessionId: id });
  });

  // ── Claude CLI compatibility (post-2.1.121 --sdk-url lockdown) ──────────────
  // Read more in claude-versions.ts. The UI consumes /claude-compat to render a
  // banner offering Pin (downgrade) or Patch (byte-replace + TLS bridge).
  function compatPayload() {
    const compat = getCompatState();
    const settings = getSettings();
    return {
      installedVersion: compat.installedVersion,
      installedPath: compat.installedPath,
      isIncompatible: compat.isIncompatible,
      isPatched: compat.isPatched,
      availableKnownGood: compat.availableKnownGood,
      suggestedPinTarget: compat.suggestedPinTarget,
      lastChecked: compat.lastChecked,
      error: compat.error,
      bridgeMode: settings.claudeBridgeMode ?? "none",
      ingressUrl: settings.claudeBridgeIngressUrl ?? "",
      bannerDismissedVersion: settings.claudeCompatBannerDismissedVersion ?? "",
    };
  }

  api.get("/claude-compat", async (c) => {
    const initial = getCompatState();
    const staleMs = deps.updateCheckStaleMs;
    if (initial.lastChecked === 0 || Date.now() - initial.lastChecked > staleMs) {
      await checkCompat();
    }
    return c.json(compatPayload());
  });

  api.post("/claude-compat/refresh", async (c) => {
    await checkCompat();
    return c.json(compatPayload());
  });

  api.post("/claude-compat/pin", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const version = typeof body.version === "string" && body.version.trim()
      ? body.version.trim()
      : getCompatState().suggestedPinTarget;
    if (!version) {
      return c.json({ error: "No known-good Claude version is cached locally to pin to." }, 400);
    }
    const res = await pinToVersion(version);
    if (!res.ok) return c.json({ error: res.error }, 400);

    // Pinning means we're back on a non-validator binary; turn off patched
    // bridge mode so we don't continue routing through wss://[::1].
    if (cliIngress) {
      cliIngress.stop();
      cliIngress = null;
    }
    updateSettings({ claudeBridgeMode: "none", claudeBridgeIngressUrl: "" });

    await checkCompat();
    return c.json({ ok: true, pinnedTo: version, ...compatPayload() });
  });

  api.post("/claude-compat/patch", async (c) => {
    const patchRes = await patchBinary();
    if (!patchRes.ok) return c.json({ error: patchRes.error }, 400);

    // Start (or restart) the TLS ingress listener and persist the URL so
    // cli-launcher emits it on the next spawn.
    if (cliIngress) {
      cliIngress.stop();
      cliIngress = null;
    }
    try {
      cliIngress = await startCliIngressServer({
        wsBridge: deps.wsBridge,
        launcher: deps.launcher,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Patched binary but TLS ingress failed: ${msg}` }, 500);
    }
    updateSettings({
      claudeBridgeMode: "patched",
      claudeBridgeIngressUrl: cliIngress.urlPrefix,
    });

    await checkCompat();
    return c.json({
      ok: true,
      patchedPath: patchRes.patchedPath,
      replacements: patchRes.replacements,
      ...compatPayload(),
    });
  });

  api.post("/claude-compat/unpatch", async (c) => {
    const res = await unpatch();
    if (!res.ok) return c.json({ error: res.error }, 400);

    if (cliIngress) {
      cliIngress.stop();
      cliIngress = null;
    }
    updateSettings({ claudeBridgeMode: "none", claudeBridgeIngressUrl: "" });

    await checkCompat();
    return c.json({ ok: true, target: res.target, ...compatPayload() });
  });

  api.post("/claude-compat/dismiss-banner", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const version = typeof body.version === "string" && body.version.trim()
      ? body.version.trim()
      : getCompatState().installedVersion ?? "";
    if (!version) {
      return c.json({ error: "No version available to record as dismissed" }, 400);
    }
    updateSettings({ claudeCompatBannerDismissedVersion: version });
    return c.json({ ok: true, dismissedVersion: version });
  });
}
