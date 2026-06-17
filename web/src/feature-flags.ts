/**
 * Client feature flags. Mirrors `server/feature-flags.ts`.
 *
 * Sandbox/container support is DISABLED by default because it relies on the
 * upstream, no-longer-maintained `docker.io/stangirard/the-companion` image.
 * The UI is hidden so users can't trigger pulls/runs of that image.
 *
 * Set `VITE_SANDBOX_ENABLED=true` at build time to re-enable it — e.g. once we
 * publish and point at our own image (the server also needs
 * `COMPANION_SANDBOX_ENABLED=1`).
 */
export function isSandboxEnabled(): boolean {
  return import.meta.env.VITE_SANDBOX_ENABLED === "true";
}
