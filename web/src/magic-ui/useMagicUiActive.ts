import { useStore } from "../store.js";

/**
 * Whether the MagicUI dashboard view is active for a session.
 *
 * True only when the feature is available (global magicUiEnabled setting AND
 * the server has a usable Claude CLI) and the user explicitly opted this
 * session in (SessionState.magicUiActive === true). Mirrors the server-side
 * resolver in web/server/magic-ui-settings.ts — keep the two in sync.
 */
export function useMagicUiActive(sessionId: string | null): boolean {
  return useStore((s) => {
    if (!sessionId || !s.magicUiAvailable) return false;
    return s.sessions.get(sessionId)?.magicUiActive === true;
  });
}
