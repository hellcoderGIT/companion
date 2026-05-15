/**
 * Self-signed TLS material for the [::1] CLI ingress listener.
 *
 * After we patch the Claude CLI binary so it accepts `wss://[::1]:<port>/...`,
 * the scheme check still requires TLS. We don't need real PKI: we generate
 * an ephemeral self-signed cert (SAN IP:::1) once, cache it under
 * ~/.companion/tls/, and spawn Claude with NODE_TLS_REJECT_UNAUTHORIZED=0
 * so its WebSocket client trusts it without keychain integration.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";

const TLS_DIR = join(COMPANION_HOME, "tls");
const CERT_PATH = join(TLS_DIR, "cli-bridge.cert.pem");
const KEY_PATH = join(TLS_DIR, "cli-bridge.key.pem");

/** Re-generate if the existing cert is within this many ms of expiry. */
const RENEW_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CliBridgeCert {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
}

function certIsCurrent(): boolean {
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) return false;
  try {
    // openssl puts validity into the cert itself, but stat mtime is a cheap
    // proxy: we issued the cert with `-days 3650`, so any file written less
    // than ~3620 days ago is still well-within validity.
    const stat = statSync(CERT_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    const validForMs = 3650 * 24 * 60 * 60 * 1000;
    return ageMs < validForMs - RENEW_THRESHOLD_MS;
  } catch {
    return false;
  }
}

async function generateCert(): Promise<void> {
  mkdirSync(TLS_DIR, { recursive: true });
  const proc = Bun.spawn(
    [
      "openssl", "req", "-x509",
      "-newkey", "rsa:2048",
      "-keyout", KEY_PATH,
      "-out", CERT_PATH,
      "-days", "3650",
      "-nodes",
      "-subj", "/CN=companion-cli-bridge",
      "-addext", "subjectAltName=IP:::1,IP:127.0.0.1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `openssl cert generation failed (exit ${exitCode}): ${stderr.trim()}.` +
      ` Is openssl installed?`,
    );
  }
}

/**
 * Returns the cert + key for the CLI ingress listener, generating them if
 * missing or near expiry. The returned strings are the PEM contents, suitable
 * for passing directly to `Bun.serve({ tls: { cert, key } })`.
 */
export async function ensureCliBridgeCert(): Promise<CliBridgeCert> {
  if (!certIsCurrent()) {
    await generateCert();
  }
  const cert = readFileSync(CERT_PATH, "utf-8");
  const key = readFileSync(KEY_PATH, "utf-8");
  return { cert, key, certPath: CERT_PATH, keyPath: KEY_PATH };
}

/** Test-only: directory the cert lives in (under COMPANION_HOME). */
export const _TLS_DIR_FOR_TEST = TLS_DIR;
