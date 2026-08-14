import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { MagicUiDashboardState } from "../../server/magic-ui-types.js";

/**
 * Client-side MagicUI state: the latest full dashboard snapshot per session
 * as pushed by the server (magic_ui_state messages). The server always sends
 * complete snapshots — there is deliberately no client-side patch reducer;
 * the iframe runtime diffs snapshots against its DOM via per-slot updatedAt.
 */
export interface MagicUiSlice {
  magicUiState: Map<string, MagicUiDashboardState>;

  setMagicUiState: (sessionId: string, state: MagicUiDashboardState) => void;
  clearMagicUiState: (sessionId: string) => void;
}

export const createMagicUiSlice: StateCreator<AppState, [], [], MagicUiSlice> = (set) => ({
  magicUiState: new Map(),

  setMagicUiState: (sessionId, state) =>
    set((s) => {
      const existing = s.magicUiState.get(sessionId);
      // Snapshots can arrive out of order around reconnects; never regress.
      if (existing && existing.version > state.version) return {};
      const magicUiState = new Map(s.magicUiState);
      magicUiState.set(sessionId, state);
      return { magicUiState };
    }),

  clearMagicUiState: (sessionId) =>
    set((s) => {
      if (!s.magicUiState.has(sessionId)) return {};
      const magicUiState = new Map(s.magicUiState);
      magicUiState.delete(sessionId);
      return { magicUiState };
    }),
});
