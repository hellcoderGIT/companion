/**
 * Parallel WSS listener on [::1] for the patched Claude binary's --sdk-url.
 *
 * The main companion server stays on its existing port (plain HTTP for the
 * browser UI). After the binary patch, the spawned Claude CLI connects to
 * `wss://[::1]:<port>/ws/cli/<sessionId>` instead of the plain ws:// URL —
 * the lockdown validator demands wss:// even with [::1] hostname allowed.
 *
 * We pick a random free port at startup, persist it to settings, and bind
 * with a self-signed cert (SAN IP:::1). Listens only for the CLI upgrade
 * path; everything else gets 404. Delegates open/message/close to the
 * exact same WsBridge methods the main server uses, so the bridge code has
 * no idea which listener delivered the socket.
 */

import type { ServerWebSocket } from "bun";
import type { WsBridge, SocketData } from "./ws-bridge.js";
import type { CliLauncher } from "./cli-launcher.js";
import { ensureCliBridgeCert } from "./claude-tls.js";

export interface CliIngressServer {
  /** Canonical URL prefix to hand to spawned CLIs, e.g. "wss://[::1]:54321". */
  urlPrefix: string;
  port: number;
  stop: () => void;
}

export async function startCliIngressServer(deps: {
  wsBridge: WsBridge;
  launcher: CliLauncher;
}): Promise<CliIngressServer> {
  const { cert, key } = await ensureCliBridgeCert();

  const server = Bun.serve<SocketData>({
    hostname: "::1",
    port: 0, // Bun picks a free port
    idleTimeout: 0,
    tls: { cert, key },
    fetch(req, server) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
      if (!match) {
        return new Response("Not Found", { status: 404 });
      }
      const sessionId = match[1];

      // jsonHandoff bridge tokens still apply when set — same logic as the
      // main server's CLI upgrade handler. Sessions launched in the new
      // "patched" mode don't use bridgeToken (TLS + loopback is the guard);
      // but if a session was created with jsonHandoff this listener will
      // honor the token check too, for symmetry.
      const session = deps.launcher.getSession(sessionId);
      if (session?.bridgeToken) {
        const presented = url.searchParams.get("token")
          || req.headers.get("sec-websocket-protocol")?.split(",").map((s: string) => s.trim()).find(Boolean);
        if (presented !== session.bridgeToken) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
      idleTimeout: 0,
      sendPings: false,
      open(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind !== "cli") return;
        deps.wsBridge.handleCLIOpen(ws, ws.data.sessionId);
        deps.launcher.markConnected(ws.data.sessionId);
      },
      message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
        if (ws.data.kind !== "cli") return;
        deps.wsBridge.handleCLIMessage(ws, msg);
      },
      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind !== "cli") return;
        deps.wsBridge.handleCLIClose(ws);
      },
    },
  });

  // Bun.serve types server.port as number | undefined because port: 0 is
  // technically resolvable late; in practice port is bound synchronously and
  // populated by the time Bun.serve returns. Crash early if not.
  const port = server.port;
  if (typeof port !== "number") {
    throw new Error("Bun.serve did not assign a port to the CLI ingress listener");
  }
  const urlPrefix = `wss://[::1]:${port}`;
  console.log(`[cli-ingress] Listening on ${urlPrefix} (TLS, patched-bridge mode)`);

  return {
    urlPrefix,
    port,
    stop: () => { server.stop(true); },
  };
}
