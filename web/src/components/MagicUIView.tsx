import { useMemo } from "react";
import { useStore } from "../store.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { PermissionBanner } from "./PermissionBanner.js";
import { DensityProvider } from "./density.js";
import { MagicUIDashboard } from "./MagicUIDashboard.js";

/**
 * MagicUI session view: a full-width, AI-generated live dashboard of the
 * session, with a small always-visible strip of the raw session output on
 * top so activity stays legible, and the Composer at the bottom.
 *
 * The dashboard itself (sandboxed iframe runtime driven by the server-side
 * Haiku watcher) mounts in the center area. Decisions are rendered by the
 * dashboard runtime from real pending-permission data; the classic
 * PermissionBanner stays wired underneath as the guaranteed fallback so a
 * decision can never be lost — even if the generated UI misbehaves.
 */
export function MagicUIView({ sessionId }: { sessionId: string }) {
  const sessionPerms = useStore((s) => s.pendingPermissions.get(sessionId));
  const connStatus = useStore(
    (s) => s.connectionStatus.get(sessionId) ?? "disconnected",
  );
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);

  const perms = useMemo(
    () => (sessionPerms ? Array.from(sessionPerms.values()) : []),
    [sessionPerms],
  );

  const showCliBanner = connStatus === "connected" && !cliConnected;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Slim connection notices (full controls live in the standard view) */}
      {(showCliBanner || connStatus === "disconnected") && (
        <div className="px-4 py-1.5 bg-gradient-to-r from-cc-warning/8 to-cc-warning/4 border-b border-cc-warning/15 flex items-center justify-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-cc-warning animate-[pulse-dot_1.5s_ease-in-out_infinite] shrink-0" />
          <span className="text-xs text-cc-warning font-medium">
            {connStatus === "disconnected" ? "Reconnecting to session…" : "CLI disconnected — switch to Standard view to reconnect"}
          </span>
        </div>
      )}

      {/* Mini raw-output strip: small fixed height, forced compact density */}
      <div
        className="h-36 shrink-0 border-b border-cc-border relative overflow-hidden"
        aria-label="Raw session output"
      >
        <DensityProvider value="compact">
          <MessageFeed sessionId={sessionId} />
        </DensityProvider>
      </div>

      {/* Dashboard area: full width, no max-w constraint */}
      <div className="flex-1 min-h-0 relative bg-cc-bg">
        <MagicUIDashboard sessionId={sessionId} />
      </div>

      {/* Fallback decision popups — never lose a decision */}
      {perms.length > 0 && (
        <div className="shrink-0 max-h-[50dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
          {perms.map((p) => (
            <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
          ))}
        </div>
      )}

      <Composer sessionId={sessionId} />
    </div>
  );
}

