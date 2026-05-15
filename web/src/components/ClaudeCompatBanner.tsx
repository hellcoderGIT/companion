import { useState } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { captureException } from "../analytics.js";

/**
 * Top-of-app banner that surfaces when the locally-installed Claude CLI is
 * 2.1.121+ (which rejects every non-Anthropic --sdk-url host). Two
 * remediations:
 *
 *  • Pin — re-symlink ~/.local/bin/claude at the latest cached known-good
 *    version (2.1.120 or earlier). No binary modification.
 *
 *  • Patch — byte-replace `claude-staging.fedstart.com` with `[::1]` in a
 *    sibling .patched copy, swap the symlink, and route session WS through
 *    the companion's TLS [::1] ingress. theshadow27/mcp-cli#1808 documented
 *    this approach end-to-end.
 *
 * Dismiss persists the current installed version to the server, so a future
 * Claude bump re-surfaces the banner.
 */
export function ClaudeCompatBanner() {
  const info = useStore((s) => s.claudeCompatInfo);
  const setInfo = useStore((s) => s.setClaudeCompatInfo);
  const [busy, setBusy] = useState<"pin" | "patch" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!info) return null;
  if (!info.isIncompatible) return null;
  if (info.bannerDismissedVersion && info.installedVersion === info.bannerDismissedVersion) return null;

  const handlePin = async () => {
    setError(null);
    setBusy("pin");
    try {
      const next = await api.pinClaudeVersion();
      setInfo(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      captureException(err);
    } finally {
      setBusy(null);
    }
  };

  const handlePatch = async () => {
    setError(null);
    setBusy("patch");
    try {
      const next = await api.patchClaudeBinary();
      setInfo(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      captureException(err);
    } finally {
      setBusy(null);
    }
  };

  const handleDismiss = async () => {
    if (!info.installedVersion) return;
    setError(null);
    setBusy("dismiss");
    try {
      await api.dismissClaudeCompatBanner(info.installedVersion);
      setInfo({ ...info, bannerDismissedVersion: info.installedVersion });
    } catch (err) {
      captureException(err);
    } finally {
      setBusy(null);
    }
  };

  const pinAvailable = info.suggestedPinTarget !== null;
  const pinLabel = pinAvailable
    ? `Pin to v${info.suggestedPinTarget}`
    : "Pin (no cached known-good version)";

  return (
    <div
      role="alert"
      data-testid="claude-compat-banner"
      className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/20 flex items-center justify-center gap-3 flex-wrap"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-red-500 shrink-0" aria-hidden="true">
        <path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm.75 4a.75.75 0 0 0-1.5 0v4a.75.75 0 0 0 1.5 0V5zM8 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
      </svg>

      <span className="text-xs text-cc-fg">
        <span className="font-medium">Claude CLI v{info.installedVersion}</span> rejects local{" "}
        <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">--sdk-url</code> —
        <span className="text-cc-muted ml-1">companion sessions will fail until you pin or patch.</span>
      </span>

      <button
        type="button"
        onClick={handlePin}
        disabled={busy !== null || !pinAvailable}
        className="text-xs font-medium px-2.5 py-0.5 rounded-md bg-cc-elev hover:bg-cc-elev-hover text-cc-fg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        title={pinAvailable
          ? `Re-symlinks ~/.local/bin/claude to the cached v${info.suggestedPinTarget} binary.`
          : "No known-good Claude version is cached under ~/.local/share/claude/versions/."}
      >
        {busy === "pin" ? "Pinning..." : pinLabel}
      </button>

      <button
        type="button"
        onClick={handlePatch}
        disabled={busy !== null}
        className="text-xs font-medium px-2.5 py-0.5 rounded-md bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        title="Byte-patches this version so it accepts [::1] in --sdk-url, then routes session WS through a TLS listener on [::1]."
      >
        {busy === "patch" ? "Patching..." : "Patch this version"}
      </button>

      <button
        type="button"
        onClick={handleDismiss}
        disabled={busy !== null}
        className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer ml-auto disabled:opacity-50"
        title="Dismiss until a new Claude version is installed"
        aria-label="Dismiss compatibility banner"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>

      {error ? (
        <div className="basis-full text-xs text-red-500 text-center mt-1">{error}</div>
      ) : null}
    </div>
  );
}
