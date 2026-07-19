import type { Hono } from "hono";
import { DASHBOARD_MODEL_OPTIONS, DEFAULT_ANTHROPIC_MODEL, getSettings, updateSettings, type UpdateChannel, type CliBridgeMode } from "../settings-manager.js";
import { linearCache } from "../linear-cache.js";
import { listConnections } from "../linear-connections.js";
import { hasContainerCodexAuth } from "../codex-container-auth.js";

export function registerSettingsRoutes(api: Hono): void {
  api.get("/settings", (c) => {
    const settings = getSettings();
    const connections = listConnections();
    return c.json({
      anthropicApiKeyConfigured: !!settings.anthropicApiKey.trim(),
      anthropicModel: settings.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      claudeCodeOAuthTokenConfigured: !!settings.claudeCodeOAuthToken.trim(),
      openaiApiKeyConfigured: !!settings.openaiApiKey.trim(),
      codexDeviceAuthConfigured: hasContainerCodexAuth(),
      onboardingCompleted: settings.onboardingCompleted,
      linearApiKeyConfigured: !!settings.linearApiKey.trim() || connections.length > 0,
      linearConnectionCount: connections.length,
      linearAutoTransition: settings.linearAutoTransition,
      linearAutoTransitionStateName: settings.linearAutoTransitionStateName,
      linearArchiveTransition: settings.linearArchiveTransition,
      linearArchiveTransitionStateName: settings.linearArchiveTransitionStateName,
      linearOAuthConfigured: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim() && settings.linearOAuthAccessToken.trim()),
      linearOAuthCredentialsSaved: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim()),
      aiValidationEnabled: settings.aiValidationEnabled,
      aiValidationAutoApprove: settings.aiValidationAutoApprove,
      aiValidationAutoDeny: settings.aiValidationAutoDeny,
      dashboardEnabled: settings.dashboardEnabled,
      dashboardModel: settings.dashboardModel,
      dashboardRunHour: settings.dashboardRunHour,
      dashboardMaxSessionsPerRun: settings.dashboardMaxSessionsPerRun,
      publicUrl: settings.publicUrl,
      updateChannel: settings.updateChannel,
      dockerAutoUpdate: settings.dockerAutoUpdate,
      proactiveKeepaliveEnabled: settings.proactiveKeepaliveEnabled,
      cliBridgeMode: settings.cliBridgeMode,
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.anthropicApiKey !== undefined && typeof body.anthropicApiKey !== "string") {
      return c.json({ error: "anthropicApiKey must be a string" }, 400);
    }
    if (body.anthropicModel !== undefined && typeof body.anthropicModel !== "string") {
      return c.json({ error: "anthropicModel must be a string" }, 400);
    }
    if (body.linearApiKey !== undefined && typeof body.linearApiKey !== "string") {
      return c.json({ error: "linearApiKey must be a string" }, 400);
    }
    if (body.linearAutoTransition !== undefined && typeof body.linearAutoTransition !== "boolean") {
      return c.json({ error: "linearAutoTransition must be a boolean" }, 400);
    }
    if (body.linearAutoTransitionStateId !== undefined && typeof body.linearAutoTransitionStateId !== "string") {
      return c.json({ error: "linearAutoTransitionStateId must be a string" }, 400);
    }
    if (body.linearAutoTransitionStateName !== undefined && typeof body.linearAutoTransitionStateName !== "string") {
      return c.json({ error: "linearAutoTransitionStateName must be a string" }, 400);
    }
    if (body.linearArchiveTransition !== undefined && typeof body.linearArchiveTransition !== "boolean") {
      return c.json({ error: "linearArchiveTransition must be a boolean" }, 400);
    }
    if (body.linearArchiveTransitionStateId !== undefined && typeof body.linearArchiveTransitionStateId !== "string") {
      return c.json({ error: "linearArchiveTransitionStateId must be a string" }, 400);
    }
    if (body.linearArchiveTransitionStateName !== undefined && typeof body.linearArchiveTransitionStateName !== "string") {
      return c.json({ error: "linearArchiveTransitionStateName must be a string" }, 400);
    }
    if (body.aiValidationEnabled !== undefined && typeof body.aiValidationEnabled !== "boolean") {
      return c.json({ error: "aiValidationEnabled must be a boolean" }, 400);
    }
    if (body.aiValidationAutoApprove !== undefined && typeof body.aiValidationAutoApprove !== "boolean") {
      return c.json({ error: "aiValidationAutoApprove must be a boolean" }, 400);
    }
    if (body.aiValidationAutoDeny !== undefined && typeof body.aiValidationAutoDeny !== "boolean") {
      return c.json({ error: "aiValidationAutoDeny must be a boolean" }, 400);
    }
    if (body.dashboardEnabled !== undefined && typeof body.dashboardEnabled !== "boolean") {
      return c.json({ error: "dashboardEnabled must be a boolean" }, 400);
    }
    if (body.dashboardModel !== undefined && !DASHBOARD_MODEL_OPTIONS.includes(body.dashboardModel)) {
      return c.json({ error: `dashboardModel must be one of: ${DASHBOARD_MODEL_OPTIONS.join(", ")}` }, 400);
    }
    if (
      body.dashboardRunHour !== undefined
      && (typeof body.dashboardRunHour !== "number" || !Number.isInteger(body.dashboardRunHour)
        || body.dashboardRunHour < 0 || body.dashboardRunHour > 23)
    ) {
      return c.json({ error: "dashboardRunHour must be an integer between 0 and 23" }, 400);
    }
    if (
      body.dashboardMaxSessionsPerRun !== undefined
      && (typeof body.dashboardMaxSessionsPerRun !== "number" || !Number.isInteger(body.dashboardMaxSessionsPerRun)
        || body.dashboardMaxSessionsPerRun < 1 || body.dashboardMaxSessionsPerRun > 200)
    ) {
      return c.json({ error: "dashboardMaxSessionsPerRun must be an integer between 1 and 200" }, 400);
    }
    if (body.publicUrl !== undefined) {
      if (typeof body.publicUrl !== "string") {
        return c.json({ error: "publicUrl must be a string" }, 400);
      }
      const trimmed = body.publicUrl.trim().replace(/\/+$/, "");
      if (trimmed !== "" && !/^https?:\/\/.+/.test(trimmed)) {
        return c.json({ error: "publicUrl must be a valid http/https URL" }, 400);
      }
    }
    if (body.updateChannel !== undefined && body.updateChannel !== "stable" && body.updateChannel !== "prerelease") {
      return c.json({ error: "updateChannel must be 'stable' or 'prerelease'" }, 400);
    }
    if (body.linearOAuthClientId !== undefined && typeof body.linearOAuthClientId !== "string") {
      return c.json({ error: "linearOAuthClientId must be a string" }, 400);
    }
    if (body.linearOAuthClientSecret !== undefined && typeof body.linearOAuthClientSecret !== "string") {
      return c.json({ error: "linearOAuthClientSecret must be a string" }, 400);
    }
    if (body.linearOAuthWebhookSecret !== undefined && typeof body.linearOAuthWebhookSecret !== "string") {
      return c.json({ error: "linearOAuthWebhookSecret must be a string" }, 400);
    }
    if (body.claudeCodeOAuthToken !== undefined && typeof body.claudeCodeOAuthToken !== "string") {
      return c.json({ error: "claudeCodeOAuthToken must be a string" }, 400);
    }
    if (body.openaiApiKey !== undefined && typeof body.openaiApiKey !== "string") {
      return c.json({ error: "openaiApiKey must be a string" }, 400);
    }
    if (body.onboardingCompleted !== undefined && typeof body.onboardingCompleted !== "boolean") {
      return c.json({ error: "onboardingCompleted must be a boolean" }, 400);
    }
    if (body.dockerAutoUpdate !== undefined && typeof body.dockerAutoUpdate !== "boolean") {
      return c.json({ error: "dockerAutoUpdate must be a boolean" }, 400);
    }
    if (body.proactiveKeepaliveEnabled !== undefined && typeof body.proactiveKeepaliveEnabled !== "boolean") {
      return c.json({ error: "proactiveKeepaliveEnabled must be a boolean" }, 400);
    }
    if (body.cliBridgeMode !== undefined && body.cliBridgeMode !== "loopback" && body.cliBridgeMode !== "jsonHandoff") {
      return c.json({ error: "cliBridgeMode must be 'loopback' or 'jsonHandoff'" }, 400);
    }
    const hasAnyField = body.anthropicApiKey !== undefined || body.anthropicModel !== undefined
      || body.claudeCodeOAuthToken !== undefined || body.openaiApiKey !== undefined
      || body.onboardingCompleted !== undefined
      || body.linearApiKey !== undefined || body.linearAutoTransition !== undefined
      || body.linearAutoTransitionStateId !== undefined || body.linearAutoTransitionStateName !== undefined
      || body.linearArchiveTransition !== undefined || body.linearArchiveTransitionStateId !== undefined
      || body.linearArchiveTransitionStateName !== undefined
      || body.linearOAuthClientId !== undefined || body.linearOAuthClientSecret !== undefined
      || body.linearOAuthWebhookSecret !== undefined
      || body.aiValidationEnabled !== undefined || body.aiValidationAutoApprove !== undefined
      || body.aiValidationAutoDeny !== undefined
      || body.dashboardEnabled !== undefined || body.dashboardModel !== undefined
      || body.dashboardRunHour !== undefined || body.dashboardMaxSessionsPerRun !== undefined
      || body.publicUrl !== undefined
      || body.updateChannel !== undefined
      || body.dockerAutoUpdate !== undefined
      || body.proactiveKeepaliveEnabled !== undefined
      || body.cliBridgeMode !== undefined;
    if (!hasAnyField) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    if (typeof body.linearApiKey === "string") {
      linearCache.clear();
    }

    const settings = updateSettings({
      anthropicApiKey:
        typeof body.anthropicApiKey === "string"
          ? body.anthropicApiKey.trim()
          : undefined,
      anthropicModel:
        typeof body.anthropicModel === "string"
          ? (body.anthropicModel.trim() || DEFAULT_ANTHROPIC_MODEL)
          : undefined,
      claudeCodeOAuthToken:
        typeof body.claudeCodeOAuthToken === "string"
          ? body.claudeCodeOAuthToken.trim()
          : undefined,
      openaiApiKey:
        typeof body.openaiApiKey === "string"
          ? body.openaiApiKey.trim()
          : undefined,
      onboardingCompleted:
        typeof body.onboardingCompleted === "boolean"
          ? body.onboardingCompleted
          : undefined,
      linearApiKey:
        typeof body.linearApiKey === "string"
          ? body.linearApiKey.trim()
          : undefined,
      linearAutoTransition:
        typeof body.linearAutoTransition === "boolean"
          ? body.linearAutoTransition
          : undefined,
      linearAutoTransitionStateId:
        typeof body.linearAutoTransitionStateId === "string"
          ? body.linearAutoTransitionStateId.trim()
          : undefined,
      linearAutoTransitionStateName:
        typeof body.linearAutoTransitionStateName === "string"
          ? body.linearAutoTransitionStateName.trim()
          : undefined,
      linearArchiveTransition:
        typeof body.linearArchiveTransition === "boolean"
          ? body.linearArchiveTransition
          : undefined,
      linearArchiveTransitionStateId:
        typeof body.linearArchiveTransitionStateId === "string"
          ? body.linearArchiveTransitionStateId.trim()
          : undefined,
      linearArchiveTransitionStateName:
        typeof body.linearArchiveTransitionStateName === "string"
          ? body.linearArchiveTransitionStateName.trim()
          : undefined,
      linearOAuthClientId:
        typeof body.linearOAuthClientId === "string"
          ? body.linearOAuthClientId.trim()
          : undefined,
      linearOAuthClientSecret:
        typeof body.linearOAuthClientSecret === "string"
          ? body.linearOAuthClientSecret.trim()
          : undefined,
      linearOAuthWebhookSecret:
        typeof body.linearOAuthWebhookSecret === "string"
          ? body.linearOAuthWebhookSecret.trim()
          : undefined,
      aiValidationEnabled:
        typeof body.aiValidationEnabled === "boolean"
          ? body.aiValidationEnabled
          : undefined,
      aiValidationAutoApprove:
        typeof body.aiValidationAutoApprove === "boolean"
          ? body.aiValidationAutoApprove
          : undefined,
      aiValidationAutoDeny:
        typeof body.aiValidationAutoDeny === "boolean"
          ? body.aiValidationAutoDeny
          : undefined,
      dashboardEnabled:
        typeof body.dashboardEnabled === "boolean"
          ? body.dashboardEnabled
          : undefined,
      dashboardModel:
        typeof body.dashboardModel === "string"
          ? body.dashboardModel
          : undefined,
      dashboardRunHour:
        typeof body.dashboardRunHour === "number"
          ? body.dashboardRunHour
          : undefined,
      dashboardMaxSessionsPerRun:
        typeof body.dashboardMaxSessionsPerRun === "number"
          ? body.dashboardMaxSessionsPerRun
          : undefined,
      publicUrl:
        typeof body.publicUrl === "string"
          ? body.publicUrl.trim().replace(/\/+$/, "")
          : undefined,
      updateChannel:
        body.updateChannel === "stable" || body.updateChannel === "prerelease"
          ? (body.updateChannel as UpdateChannel)
          : undefined,
      dockerAutoUpdate:
        typeof body.dockerAutoUpdate === "boolean"
          ? body.dockerAutoUpdate
          : undefined,
      proactiveKeepaliveEnabled:
        typeof body.proactiveKeepaliveEnabled === "boolean"
          ? body.proactiveKeepaliveEnabled
          : undefined,
      cliBridgeMode:
        body.cliBridgeMode === "loopback" || body.cliBridgeMode === "jsonHandoff"
          ? (body.cliBridgeMode as CliBridgeMode)
          : undefined,
    });

    const connectionsAfterUpdate = listConnections();
    return c.json({
      anthropicApiKeyConfigured: !!settings.anthropicApiKey.trim(),
      anthropicModel: settings.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      claudeCodeOAuthTokenConfigured: !!settings.claudeCodeOAuthToken.trim(),
      openaiApiKeyConfigured: !!settings.openaiApiKey.trim(),
      codexDeviceAuthConfigured: hasContainerCodexAuth(),
      onboardingCompleted: settings.onboardingCompleted,
      linearApiKeyConfigured: !!settings.linearApiKey.trim() || connectionsAfterUpdate.length > 0,
      linearConnectionCount: connectionsAfterUpdate.length,
      linearAutoTransition: settings.linearAutoTransition,
      linearAutoTransitionStateName: settings.linearAutoTransitionStateName,
      linearArchiveTransition: settings.linearArchiveTransition,
      linearArchiveTransitionStateName: settings.linearArchiveTransitionStateName,
      linearOAuthConfigured: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim() && settings.linearOAuthAccessToken.trim()),
      linearOAuthCredentialsSaved: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim()),
      aiValidationEnabled: settings.aiValidationEnabled,
      aiValidationAutoApprove: settings.aiValidationAutoApprove,
      aiValidationAutoDeny: settings.aiValidationAutoDeny,
      dashboardEnabled: settings.dashboardEnabled,
      dashboardModel: settings.dashboardModel,
      dashboardRunHour: settings.dashboardRunHour,
      dashboardMaxSessionsPerRun: settings.dashboardMaxSessionsPerRun,
      publicUrl: settings.publicUrl,
      updateChannel: settings.updateChannel,
      dockerAutoUpdate: settings.dockerAutoUpdate,
      proactiveKeepaliveEnabled: settings.proactiveKeepaliveEnabled,
      cliBridgeMode: settings.cliBridgeMode,
    });
  });

  api.post("/settings/anthropic/verify", async (c) => {
    const body = await c.req.json().catch(() => ({} as { apiKey?: string }));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return c.json({ valid: false, error: "API key is required" }, 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });

      if (res.ok) {
        return c.json({ valid: true });
      }
      return c.json({ valid: false, error: `API returned ${res.status}` });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return c.json({ valid: false, error: isAbort ? "Request timed out" : "Request failed" });
    } finally {
      clearTimeout(timer);
    }
  });
}
