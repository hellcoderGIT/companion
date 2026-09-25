import { useCallback, useEffect, useState } from "react";
import { api, type ClaudeAccountStatus, type ClaudeLoginStatus } from "../api.js";

/**
 * Sign in to Claude Code from the browser.
 *
 * The Claude CLI has no device-code flow, but `claude auth login` returns an
 * authorize URL with an Anthropic-hosted redirect (not a localhost callback),
 * so it works fine when the browser and the CLI are on different machines: we
 * show the link, the user approves wherever they are, and pastes the code
 * Anthropic gives them back into this panel.
 *
 * A rejected code is recoverable — the server keeps the CLI process alive and
 * returns to `awaiting_code` with an error, so the input stays open for a retry
 * rather than forcing a fresh link.
 */
export function ClaudeAuthPanel(): React.ReactElement {
  const [account, setAccount] = useState<ClaudeAccountStatus | null>(null);
  const [login, setLogin] = useState<ClaudeLoginStatus>({ state: "idle" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshAccount = useCallback(async () => {
    try {
      setAccount(await api.getClaudeAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshAccount();
    // Resume an attempt started in another tab or before a reload.
    void api.getClaudeLoginStatus().then(setLogin).catch(() => {});
  }, [refreshAccount]);

  const onStart = async () => {
    setBusy(true);
    setError("");
    setCode("");
    try {
      const status = await api.startClaudeLogin();
      setLogin(status);
      if (status.state === "error" && status.error) setError(status.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitCode = async () => {
    setBusy(true);
    setError("");
    try {
      const status = await api.submitClaudeLoginCode(code);
      setLogin(status);
      if (status.state === "success") {
        setCode("");
        await refreshAccount();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    setBusy(true);
    try {
      setLogin(await api.cancelClaudeLogin());
      setCode("");
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
      const res = await api.claudeLogout();
      if (!res.ok && res.error) setError(res.error);
      setLogin({ state: "idle" });
      await refreshAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const awaiting = login.state === "awaiting_code";
  const verifying = login.state === "verifying";
  const inFlight = awaiting || verifying;
  const cliMissing = account?.cliAvailable === false;

  // "email · Max · Org" — whichever parts the CLI reported. Personal accounts
  // report orgName as "<email>'s Organization", so it is dropped when it just
  // restates the email rather than naming a real org.
  const orgName = account?.orgName && account.email && account.orgName.includes(account.email)
    ? null
    : account?.orgName ?? null;
  const accountLine = account?.authenticated
    ? [
        account.email,
        account.subscriptionType ? titleCase(account.subscriptionType) : null,
        orgName,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <div className="space-y-2">
      <h3 className="block text-sm font-medium">Claude Account</h3>
      <p className="text-xs text-cc-muted">
        Sign in with your Claude subscription. You&apos;ll open a link, approve on any
        device, and paste the code back here — no terminal access needed.
      </p>

      {cliMissing && (
        <div
          role="status"
          className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error"
        >
          Claude CLI not found on this machine. Install it to sign in.
        </div>
      )}

      {!cliMissing && account && !inFlight && (
        <p className="text-xs text-cc-muted" data-testid="claude-account-status">
          {accountLine
            ? `Signed in as ${accountLine}`
            : account.authenticated
              ? "Signed in"
              : "Not signed in"}
        </p>
      )}

      {inFlight && (
        <div className="px-3 py-3 rounded-lg bg-cc-bg border border-cc-primary/20 space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs text-cc-muted">1. Open this link and approve:</p>
            <a
              href={login.authUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="claude-auth-url"
              className="block text-xs text-cc-primary underline break-all"
            >
              {login.authUrl}
            </a>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs text-cc-muted" htmlFor="claude-auth-code">
              2. Paste the code you were shown:
            </label>
            <div className="flex items-center gap-2">
              <input
                id="claude-auth-code"
                type="text"
                value={code}
                disabled={verifying}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && code.trim() && !busy) {
                    e.preventDefault();
                    void onSubmitCode();
                  }
                }}
                placeholder="Paste code here"
                className="flex-1 px-3 py-2 min-h-[40px] text-sm font-mono-code bg-cc-bg rounded-lg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40"
              />
              <button
                type="button"
                onClick={onSubmitCode}
                disabled={busy || !code.trim()}
                className={`px-3 py-2 min-h-[40px] rounded-lg text-sm font-medium transition-colors ${
                  busy || !code.trim()
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                }`}
              >
                {verifying ? "Verifying…" : "Submit"}
              </button>
            </div>
          </div>

          {login.error && (
            <p role="alert" className="text-xs text-cc-error">{login.error}</p>
          )}
        </div>
      )}

      {login.state === "success" && (
        <div
          role="status"
          className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success"
        >
          Signed in to Claude. New sessions will use this account.
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
        {inFlight ? (
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
            {busy ? "Starting…" : account?.authenticated ? "Sign in again" : "Sign in with Claude"}
          </button>
        )}

        {account?.authenticated && !inFlight && (
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

/** "max" -> "Max". The CLI reports plan names lowercase. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
