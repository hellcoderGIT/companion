import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { UpdateInfo, CreationProgressEvent, ClaudeCompatInfo } from "../api.js";

function getInitialDismissedVersion(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-update-dismissed") || null;
}

export interface UpdatesSlice {
  updateInfo: UpdateInfo | null;
  updateDismissedVersion: string | null;
  updateOverlayActive: boolean;
  dockerUpdateDialogOpen: boolean;
  creationProgress: CreationProgressEvent[] | null;
  creationError: string | null;
  /** The prompt the user typed when creation failed — surfaced in the overlay so it is never lost. */
  creationDraft: { text: string } | null;
  sessionCreating: boolean;
  sessionCreatingBackend: "claude" | "codex" | null;
  claudeCompatInfo: ClaudeCompatInfo | null;

  setUpdateInfo: (info: UpdateInfo | null) => void;
  dismissUpdate: (version: string) => void;
  setUpdateOverlayActive: (active: boolean) => void;
  setDockerUpdateDialogOpen: (open: boolean) => void;
  addCreationProgress: (step: CreationProgressEvent) => void;
  clearCreation: () => void;
  setSessionCreating: (creating: boolean, backend?: "claude" | "codex") => void;
  setCreationError: (error: string | null, draft?: { text: string } | null) => void;
  setClaudeCompatInfo: (info: ClaudeCompatInfo | null) => void;
}

export const createUpdatesSlice: StateCreator<AppState, [], [], UpdatesSlice> = (set) => ({
  updateInfo: null,
  updateDismissedVersion: getInitialDismissedVersion(),
  updateOverlayActive: false,
  dockerUpdateDialogOpen: false,
  creationProgress: null,
  creationError: null,
  creationDraft: null,
  sessionCreating: false,
  sessionCreatingBackend: null,
  claudeCompatInfo: null,

  setUpdateInfo: (info) => set({ updateInfo: info }),
  dismissUpdate: (version) => {
    localStorage.setItem("cc-update-dismissed", version);
    set({ updateDismissedVersion: version });
  },
  setUpdateOverlayActive: (active) => set({ updateOverlayActive: active }),
  setDockerUpdateDialogOpen: (open) => set({ dockerUpdateDialogOpen: open }),

  addCreationProgress: (step) => set((state) => {
    const existing = state.creationProgress || [];
    const idx = existing.findIndex((s) => s.step === step.step);
    if (idx >= 0) {
      const updated = [...existing];
      updated[idx] = step;
      return { creationProgress: updated };
    }
    return { creationProgress: [...existing, step] };
  }),
  clearCreation: () => set({ creationProgress: null, creationError: null, creationDraft: null, sessionCreating: false, sessionCreatingBackend: null }),
  setSessionCreating: (creating, backend) => set({ sessionCreating: creating, sessionCreatingBackend: backend ?? null }),
  setCreationError: (error, draft) => set({ creationError: error, creationDraft: draft ?? null }),
  setClaudeCompatInfo: (info) => set({ claudeCompatInfo: info }),
});
