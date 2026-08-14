import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { PermissionBanner } from "./PermissionBanner.js";
import { DensityProvider } from "./density.js";
import { MagicUIDashboard } from "./MagicUIDashboard.js";
import {
  decisionResponseToWire,
  toDecisionModel,
  type DecisionRuntimeResponse,
} from "../magic-ui/bridge.js";

/** How long the dashboard runtime gets to ACK that it rendered a decision's
 *  controls before the classic PermissionBanner appears as fallback. */
const DECISION_ACK_TIMEOUT_MS = 4_000;

/**
 * MagicUI session view: a full-width, AI-generated live dashboard of the
 * session, with a small always-visible strip of the raw session output on
 * top so activity stays legible, and the Composer at the bottom.
 *
 * Decision safety contract: interactive decision controls on the dashboard
 * are built from REAL pending-permission data (never watcher output). Every
 * pending decision starts a timer when handed to the iframe; if the runtime
 * doesn't ACK rendering within DECISION_ACK_TIMEOUT_MS — or reports an
 * error — the classic PermissionBanner appears for that request and stays
 * (sticky, no flicker). A decision can never be lost.
 */
export function MagicUIView({ sessionId }: { sessionId: string }) {
  const sessionPerms = useStore((s) => s.pendingPermissions.get(sessionId));
  const removePermission = useStore((s) => s.removePermission);
  const connStatus = useStore(
    (s) => s.connectionStatus.get(sessionId) ?? "disconnected",
  );
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);

  const perms = useMemo(
    () => (sessionPerms ? Array.from(sessionPerms.values()) : []),
    [sessionPerms],
  );

  // ── Decision fallback machinery ──────────────────────────────────────
  const [fallbackIds, setFallbackIds] = useState<ReadonlySet<string>>(new Set());
  const ackedRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    for (const p of perms) {
      const id = p.request_id;
      if (ackedRef.current.has(id) || fallbackIds.has(id) || timersRef.current.has(id)) continue;
      timersRef.current.set(id, setTimeout(() => {
        timersRef.current.delete(id);
        if (!ackedRef.current.has(id)) {
          setFallbackIds((prev) => new Set(prev).add(id));
        }
      }, DECISION_ACK_TIMEOUT_MS));
    }
    // Drop timers for requests that resolved/cancelled meanwhile.
    for (const [id, timer] of timersRef.current) {
      if (!perms.some((p) => p.request_id === id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [perms, fallbackIds]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const handleDecisionAck = useCallback((requestId: string) => {
    ackedRef.current.add(requestId);
    const timer = timersRef.current.get(requestId);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(requestId);
    }
  }, []);

  const handleDecisionResponse = useCallback(
    (requestId: string, response: DecisionRuntimeResponse) => {
      const perm = useStore.getState().pendingPermissions.get(sessionId)?.get(requestId);
      if (!perm) return;
      sendToSession(sessionId, decisionResponseToWire(perm, response));
      removePermission(sessionId, requestId);
    },
    [sessionId, removePermission],
  );

  const handleRuntimeError = useCallback(() => {
    // The generated UI is misbehaving — arm the fallback for everything
    // currently pending. New requests still try the magic path first.
    setFallbackIds((prev) => {
      const next = new Set(prev);
      for (const p of useStore.getState().pendingPermissions.get(sessionId)?.values() ?? []) {
        next.add(p.request_id);
      }
      return next;
    });
  }, [sessionId]);

  // Decisions handed to the dashboard = pending minus fallback-armed ones.
  const decisions = useMemo(
    () => perms.filter((p) => !fallbackIds.has(p.request_id)).map(toDecisionModel),
    [perms, fallbackIds],
  );
  const fallbackPerms = useMemo(
    () => perms.filter((p) => fallbackIds.has(p.request_id)),
    [perms, fallbackIds],
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
        <MagicUIDashboard
          sessionId={sessionId}
          decisions={decisions}
          onDecisionAck={handleDecisionAck}
          onDecisionResponse={handleDecisionResponse}
          onRuntimeError={handleRuntimeError}
        />
      </div>

      {/* Fallback decision popups — only for requests the dashboard failed
          to render in time. Sticky per request; a decision is never lost. */}
      {fallbackPerms.length > 0 && (
        <div className="shrink-0 max-h-[50dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
          {fallbackPerms.map((p) => (
            <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
          ))}
        </div>
      )}

      <Composer sessionId={sessionId} />
    </div>
  );
}
