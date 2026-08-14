import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store.js";
import { sendMagicUiSync } from "../ws.js";
import {
  buildMagicUiSrcdoc,
  isRuntimeMessage,
  MAGIC_UI_CHANNEL,
  type DecisionModel,
  type DecisionRuntimeResponse,
} from "../magic-ui/bridge.js";

/**
 * Host for the sandboxed MagicUI dashboard iframe.
 *
 * Security model: sandbox="allow-scripts" WITHOUT allow-same-origin →
 * opaque origin; plus a no-network CSP inside the srcdoc. The iframe can
 * only talk to us via postMessage. Because an opaque origin serializes as
 * the literal string "null", we authenticate messages by comparing
 * event.source against our iframe's contentWindow — never by origin.
 */
export function MagicUIDashboard({
  sessionId,
  decisions,
  onDecisionAck,
  onDecisionResponse,
  onRuntimeError,
}: {
  sessionId: string;
  /** Live decision models derived from REAL pending permissions. */
  decisions?: DecisionModel[];
  onDecisionAck?: (requestId: string) => void;
  onDecisionResponse?: (requestId: string, response: DecisionRuntimeResponse) => void;
  onRuntimeError?: (message: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const darkMode = useStore((s) => s.darkMode);
  const state = useStore((s) => s.magicUiState.get(sessionId));

  // Keep latest values available to the stable message listener.
  const latestRef = useRef({ state, darkMode, decisions, onDecisionAck, onDecisionResponse, onRuntimeError });
  latestRef.current = { state, darkMode, decisions, onDecisionAck, onDecisionResponse, onRuntimeError };

  // srcdoc is assembled once per mount; theme updates flow over the bridge.
  const srcdoc = useMemo(() => buildMagicUiSrcdoc(darkMode ? "dark" : "light"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  const postToRuntime = (msg: Record<string, unknown>) => {
    // targetOrigin must be "*": an opaque-origin iframe can never match a
    // concrete origin. Safe because the payload contains no secrets beyond
    // what the dashboard displays anyway, and replies are source-checked.
    iframeRef.current?.contentWindow?.postMessage({ channel: MAGIC_UI_CHANNEL, ...msg }, "*");
  };
  const postRef = useRef(postToRuntime);
  postRef.current = postToRuntime;

  // Bridge listener (stable for the lifetime of the component).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isRuntimeMessage(event.data)) return;
      const latest = latestRef.current;
      switch (event.data.type) {
        case "ready": {
          readyRef.current = true;
          postRef.current({ type: "init", theme: latest.darkMode ? "dark" : "light" });
          if (latest.state) postRef.current({ type: "state", state: latest.state });
          for (const d of latest.decisions ?? []) {
            postRef.current({ type: "decision_show", request: d });
          }
          break;
        }
        case "copy_request": {
          // The opaque-origin iframe cannot use the clipboard API itself.
          navigator.clipboard?.writeText(event.data.text).catch(() => {});
          break;
        }
        case "decision_ack":
          latest.onDecisionAck?.(event.data.requestId);
          break;
        case "decision_response":
          latest.onDecisionResponse?.(event.data.requestId, event.data.response);
          break;
        case "runtime_error":
          console.warn("[magic-ui] runtime error:", event.data.message);
          latest.onRuntimeError?.(event.data.message);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Ask the server for the current snapshot on mount / session switch.
  useEffect(() => {
    readyRef.current = false;
    sendMagicUiSync(sessionId);
  }, [sessionId]);

  // Push state / theme / decisions as they change.
  useEffect(() => {
    if (readyRef.current && state) postRef.current({ type: "state", state });
  }, [state]);

  useEffect(() => {
    if (readyRef.current) postRef.current({ type: "theme", theme: darkMode ? "dark" : "light" });
  }, [darkMode]);

  const shownDecisionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!readyRef.current) return;
    const current = new Set((decisions ?? []).map((d) => d.requestId));
    for (const d of decisions ?? []) {
      if (!shownDecisionsRef.current.has(d.requestId)) {
        postRef.current({ type: "decision_show", request: d });
      }
    }
    for (const shown of shownDecisionsRef.current) {
      if (!current.has(shown)) {
        postRef.current({ type: "decision_hide", requestId: shown });
      }
    }
    shownDecisionsRef.current = current;
  }, [decisions]);

  return (
    <iframe
      ref={iframeRef}
      title="Magic dashboard"
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      className="absolute inset-0 w-full h-full border-0 bg-transparent"
    />
  );
}
