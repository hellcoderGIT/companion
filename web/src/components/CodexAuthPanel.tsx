import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CodexAccountStatus, type CodexLoginStatus } from "../api.js";

const POLL_INTERVAL_MS = 2000;

/**
 * Sign in to Codex with a ChatGPT subscription, from the browser.
 *
 * Uses Codex's device-code flow rather than its localhost-callback OAuth flow,
 * because Companion typically drives a remote machine: the callback would land
 * on the server's loopback, not the user's browser. With a device code the user
 * approves on whatever device they are already on, so there's no need to SSH in
 * and run `codex login` by hand.
 */
export function CodexAuthPanel(): React.ReactElement {
  const [account, setAccount] = useState<CodexAccountStatus | null>(null);
  const [login, setLogin] = useState<CodexLoginStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshAccount = useCallback(async () => {
    try {
      setAccount(await api.getCodexAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Poll only while a login is actually pending; stop as soon as it resolves so
  // we don't spawn an app-server every 2s forever.
  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = await api.getCodexLoginStatus();
        setLogin(status);
        if (status.state !== "pending") {
          stopPolling();
          if (status.state === "success") void refreshAccount();
        }
      } catch {
        // Transient network failure — keep polling.
      }
    }, POLL_INTERVAL_MS);
  }, [refreshAccount, stopPolling]);

  useEffect(() => {
    void refreshAccount();
    // Resume an attempt started elsewhere (another tab, or before a reload).
    void api.getCodexLoginStatus().then((s) => {
      setLogin(s);
      if (s.state === "pending") startPolling();
    }).catch(() => {});
    return stopPolling;
  }, [refreshAccount, startPolling, stopPolling]);

  const onStart = async () => {
    setBusy(true);
    setError("");
    try {
      const status = await api.startCodexLogin();
      setLogin(status);
      if (status.state === "pending") startPolling();
      else if (status.error) setError(status.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    setBusy(true);
    stopPolling();
    try {
      setLogin(await api.cancelCodexLogin());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onLogout = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.codexLogout();
      if (!res.ok && res.error) setError(res.error);
      setLogin({ state: "idle" });
      await refreshAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCopyCode = async () => {
    if (!login.userCode) return;
    try {
      await navigator.clipboard.writeText(login.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context) — the code is visible anyway.
    }
  };

  const pending = login.state === "pending";
  const cliMissing = account?.cliAvailable === false;

  return (
    <div className="space-y-2">
      <h3 className="block text-sm font-medium">ChatGPT Subscription (Codex)</h3>
      <p className="text-xs text-cc-muted">
        Sign in with your ChatGPT plan to use Codex without an API key. You&apos;ll get a
        code to enter on any device — no terminal access needed.
      </p>

      {cliMissing && (
        <div
          role="status"
          className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error"
        >
          Codex CLI not found on this machine. Install it to sign in.
        </div>
      )}

      {!cliMissing && account && !pending && (
        <p className="text-xs text-cc-muted" data-testid="codex-account-status">
          {account.authenticated
            ? account.method === "apiKey"
              ? "Authenticated with an OpenAI API key"
              : `Signed in as ${account.email || "ChatGPT account"}${account.planType ? ` (${account.planType})` : ""}`
            : "Not signed in"}
        </p>
      )}

      {pending && (
        <div className="px-3 py-3 rounded-lg bg-cc-bg border border-cc-primary/20 space-y-2">
          <p className="text-xs text-cc-muted">
            1. Open{" "}
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cc-primary underline"
            >
              {login.verificationUrl}
            </a>
          </p>
          <p className="text-xs text-cc-muted">2. Enter this code:</p>
          <div className="flex items-center gap-2">
            <code
              className="font-mono-code text-lg tracking-widest bg-cc-code-bg px-3 py-1.5 rounded text-cc-code-fg"
              data-testid="codex-user-code"
            >
              {login.userCode}
            </code>
            <button
              type="button"
              onClick={onCopyCode}
              className="px-2 py-1 min-h-[32px] rounded-md text-xs bg-cc-hover text-cc-fg cursor-pointer"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-cc-muted" role="status">
            Waiting for approval…
          </p>
        </div>
      )}

      {login.state === "success" && (
        <div
          role="status"
          className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success"
        >
          Signed in to Codex. New sessions will use this account.
        </div>
      )}

      {(login.state === "error" || error) && (
        <div
          role="alert"
          className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error"
        >
          {error || login.error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {pending ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-hover text-cc-fg cursor-pointer"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={busy || cliMissing}
            className={`px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
              busy || cliMissing
                ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
            }`}
          >
            {busy ? "Starting…" : account?.authenticated ? "Sign in again" : "Sign in with ChatGPT"}
          </button>
        )}

        {account?.authenticated && !pending && (
          <button
            type="button"
            onClick={onLogout}
            disabled={busy}
            className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium bg-cc-hover text-cc-fg cursor-pointer"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}
