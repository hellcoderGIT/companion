/**
 * Feature flags for the fork.
 *
 * SANDBOX / container support is DISABLED by default because it depends on the
 * upstream, no-longer-maintained `docker.io/stangirard/the-companion` image.
 * Running an unmaintained image (privileged, no less) is a security risk, so the
 * fork ships with it off.
 *
 * The code is intentionally kept intact: set COMPANION_SANDBOX_ENABLED=1 (or
 * "true") to re-enable it — e.g. once we publish and point at our own image.
 *
 * Read as a function (not a cached const) so tests and runtime env changes take
 * effect without reimporting the module.
 */
export function isSandboxEnabled(): boolean {
  const v = process.env.COMPANION_SANDBOX_ENABLED;
  return v === "1" || v === "true";
}
