import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { BackendType } from "../types.js";
import { getModelsForBackend, toModelOptions, type ModelOption } from "./backends.js";

/**
 * Fetch the live model list for a backend (Claude: from the installed CLI's
 * initialize handshake; Codex: from the app-server `model/list` RPC) as picker
 * options. Resolves to null when the server has nothing (404, network error,
 * empty list) so callers can fall back to the static list. Never rejects.
 *
 * The server caches the probe, so calling this per picker mount is cheap.
 */
export function fetchBackendModelOptions(backend: BackendType): Promise<ModelOption[] | null> {
  return Promise.resolve()
    .then(() => api.getBackendModels(backend))
    .then((models) => (Array.isArray(models) && models.length > 0 ? toModelOptions(models) : null))
    .catch(() => null);
}

/**
 * Model options for a backend: the live list once loaded, otherwise the static
 * fallback (so the picker renders immediately and still works offline).
 */
export function useBackendModels(backend: BackendType): ModelOption[] {
  const [live, setLive] = useState<{ backend: BackendType; models: ModelOption[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBackendModelOptions(backend).then((models) => {
      if (!cancelled && models) setLive({ backend, models });
    });
    return () => { cancelled = true; };
  }, [backend]);

  // Ignore a stale list from a previous backend while the new one loads.
  return live && live.backend === backend ? live.models : getModelsForBackend(backend);
}
