import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type DashboardData,
  type DashboardRunProgress,
  type DashboardSessionEntry,
  type DashboardSessionStatus,
} from "../api.js";
import { timeAgo } from "../utils/time-ago.js";
import { extractProjectLabel } from "../utils/project-grouping.js";
import { navigateToSession } from "../utils/routing.js";

type DashboardFilter = "all" | "unfinished" | "awaiting_user" | "completed" | "archivable";

const FILTERS: Array<{ id: DashboardFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unfinished", label: "Unfinished" },
  { id: "awaiting_user", label: "Needs input" },
  { id: "completed", label: "Completed" },
  { id: "archivable", label: "Archivable" },
];

const STATUS_META: Record<DashboardSessionStatus, { label: string; className: string; dotClassName: string }> = {
  completed: {
    label: "Completed",
    className: "bg-cc-success/10 text-cc-success border-cc-success/20",
    dotClassName: "bg-cc-success",
  },
  in_progress: {
    label: "In progress",
    className: "bg-cc-primary/10 text-cc-primary border-cc-primary/20",
    dotClassName: "bg-cc-primary",
  },
  awaiting_user: {
    label: "Needs input",
    className: "bg-cc-warning/10 text-cc-warning border-cc-warning/20",
    dotClassName: "bg-cc-warning",
  },
  stalled: {
    label: "Stalled",
    className: "bg-cc-error/10 text-cc-error border-cc-error/20",
    dotClassName: "bg-cc-error",
  },
};

function matchesFilter(session: DashboardSessionEntry, filter: DashboardFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unfinished":
      return session.status === "in_progress" || session.status === "stalled";
    case "awaiting_user":
      return session.status === "awaiting_user";
    case "completed":
      return session.status === "completed";
    case "archivable":
      return session.archivable && !session.companionArchived;
  }
}

interface ProjectBucket {
  key: string;
  label: string;
  sessions: DashboardSessionEntry[];
  lastActivityAt: number;
}

function groupByProject(sessions: DashboardSessionEntry[]): ProjectBucket[] {
  const buckets = new Map<string, ProjectBucket>();
  for (const session of sessions) {
    const key = session.cwd.replace(/\/+$/, "") || "/";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label: extractProjectLabel(key), sessions: [], lastActivityAt: 0 };
      buckets.set(key, bucket);
    }
    bucket.sessions.push(session);
    bucket.lastActivityAt = Math.max(bucket.lastActivityAt, session.lastActivityAt);
  }
  const sorted = Array.from(buckets.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  for (const bucket of sorted) {
    bucket.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
  return sorted;
}

function sessionTitle(session: DashboardSessionEntry): string {
  return session.displayName || session.slug || `Session ${session.sessionId.slice(0, 8)}`;
}

function StatusBadge({ status }: { status: DashboardSessionStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap ${meta.className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dotClassName}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function RunProgressBar({ progress }: { progress: DashboardRunProgress }) {
  const pct = progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;
  const label = progress.total > 0
    ? `Summarizing session ${Math.min(progress.processed + 1, progress.total)} of ${progress.total}${progress.currentSession ? ` — ${progress.currentSession}` : ""}`
    : "Scanning sessions...";
  return (
    <div className="rounded-xl border border-cc-border bg-cc-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-cc-fg">{label}</span>
        {progress.total > 0 && (
          <span className="text-xs text-cc-muted tabular-nums">{pct}%</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Dashboard update progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.total > 0 ? pct : undefined}
        className="h-2 w-full rounded-full bg-cc-hover overflow-hidden"
      >
        <div
          className={`h-full rounded-full bg-cc-primary transition-all duration-500 ${progress.total === 0 ? "animate-pulse w-1/4" : ""}`}
          style={progress.total > 0 ? { width: `${Math.max(pct, 3)}%` } : undefined}
        />
      </div>
      {progress.failed > 0 && (
        <p className="mt-2 text-[11px] text-cc-warning">{progress.failed} session{progress.failed === 1 ? "" : "s"} failed so far</p>
      )}
    </div>
  );
}

function SessionCard({
  session,
  onArchived,
}: {
  session: DashboardSessionEntry;
  onArchived: (companionSessionId: string) => void;
}) {
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const canArchive = !!session.companionSessionId && session.archivable && !session.companionArchived;
  const metaParts = [
    session.userName ? `by ${session.userName}` : null,
    session.gitBranch ? session.gitBranch : null,
    `active ${timeAgo(session.lastActivityAt)}`,
  ].filter(Boolean);

  async function onArchive() {
    if (!session.companionSessionId) return;
    setArchiving(true);
    setArchiveError("");
    try {
      await api.archiveSession(session.companionSessionId, { linearTransition: "none" });
      onArchived(session.companionSessionId);
    } catch (err: unknown) {
      setArchiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  }

  return (
    <li className="rounded-lg border border-cc-border bg-cc-bg p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {session.companionSessionId && !session.companionArchived ? (
              <button
                type="button"
                onClick={() => navigateToSession(session.companionSessionId!)}
                className="text-sm font-medium text-cc-fg hover:text-cc-primary truncate cursor-pointer text-left"
                title="Open session"
              >
                {sessionTitle(session)}
              </button>
            ) : (
              <span className="text-sm font-medium text-cc-fg truncate">{sessionTitle(session)}</span>
            )}
            <StatusBadge status={session.status} />
            {session.companionArchived && (
              <span className="text-[11px] text-cc-muted border border-cc-border rounded-full px-2 py-0.5">Archived</span>
            )}
            {!session.companionSessionId && (
              <span
                className="text-[11px] text-cc-muted border border-cc-border rounded-full px-2 py-0.5"
                title="Discovered from ~/.claude — not launched through the companion"
              >
                External
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-cc-fg/90 leading-relaxed">{session.summary}</p>
          {session.openItems.length > 0 && (
            <ul className="mt-2 space-y-1">
              {session.openItems.map((item) => (
                <li key={item} className="text-xs text-cc-muted flex items-start gap-1.5">
                  <span className="mt-1 w-1 h-1 rounded-full bg-cc-muted shrink-0" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-cc-muted">{metaParts.join(" · ")}</p>
          {archiveError && (
            <p className="mt-1 text-[11px] text-cc-error">{archiveError}</p>
          )}
        </div>
        {canArchive && (
          <button
            type="button"
            onClick={onArchive}
            disabled={archiving}
            className={`shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              archiving
                ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
            }`}
          >
            {archiving ? "Archiving..." : "Archive"}
          </button>
        )}
      </div>
    </li>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [runError, setRunError] = useState("");
  const [filter, setFilter] = useState<DashboardFilter>("all");
  const [progress, setProgress] = useState<DashboardRunProgress | null>(null);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getDashboard();
      setData(next);
      setProgress(next.progress.state === "running" ? next.progress : null);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll run status while a summarizer run is in flight; refresh data when it finishes.
  useEffect(() => {
    if (!progress || progress.state !== "running") {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = setInterval(async () => {
      try {
        const status = await api.getDashboardRunStatus();
        if (status.progress.state === "running") {
          setProgress(status.progress);
        } else {
          setProgress(null);
          load();
        }
      } catch {
        // Transient polling failures are ignored; next tick retries.
      }
    }, 1500);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [progress, load]);

  async function onUpdateNow() {
    setRunError("");
    try {
      await api.runDashboardUpdate();
      // Optimistic: show the indeterminate bar until the first status poll lands.
      setProgress({ state: "running", trigger: "manual", total: 0, processed: 0, failed: 0 });
    } catch (err: unknown) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }

  const running = progress?.state === "running";

  const visibleSessions = useMemo(() => {
    if (!data) return [];
    return data.sessions
      .filter((s) => !(s.companionSessionId && archivedIds.has(s.companionSessionId)))
      .filter((s) => matchesFilter(s, filter));
  }, [data, filter, archivedIds]);

  const filterCounts = useMemo(() => {
    const counts = new Map<DashboardFilter, number>();
    if (!data) return counts;
    const live = data.sessions.filter(
      (s) => !(s.companionSessionId && archivedIds.has(s.companionSessionId)),
    );
    for (const f of FILTERS) {
      counts.set(f.id, live.filter((s) => matchesFilter(s, f.id)).length);
    }
    return counts;
  }, [data, archivedIds]);

  const projects = useMemo(() => groupByProject(visibleSessions), [visibleSessions]);

  return (
    <div className="h-full overflow-y-auto bg-cc-bg">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-cc-fg">Project Dashboard</h1>
            <p className="mt-0.5 text-xs text-cc-muted">
              {data?.runMeta
                ? `Last updated ${timeAgo(data.runMeta.lastRunCompletedAt)} (${data.runMeta.trigger === "manual" ? "manual" : "nightly"} run, ${data.runMeta.model})`
                : "No summarization run yet"}
            </p>
          </div>
          <button
            type="button"
            onClick={onUpdateNow}
            disabled={running || loading || !data?.claudeCliAvailable}
            className={`px-3 py-2 min-h-[40px] rounded-lg text-sm font-medium transition-colors ${
              running || loading || !data?.claudeCliAvailable
                ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
            }`}
          >
            {running ? "Updating..." : "Update now"}
          </button>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}
        {runError && (
          <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {runError}
          </div>
        )}

        {data && !data.claudeCliAvailable && (
          <div className="px-3 py-2 rounded-lg bg-cc-warning/10 border border-cc-warning/20 text-xs text-cc-warning">
            The Claude Code CLI was not found — the summarizer uses your Claude Code login to
            generate summaries, so the CLI must be installed on this machine.
          </div>
        )}

        {data && data.claudeCliAvailable && !data.enabled && (
          <div className="px-3 py-2 rounded-lg bg-cc-primary/10 border border-cc-primary/20 text-xs text-cc-fg">
            Nightly updates are off — summaries only refresh when you press "Update now".{" "}
            <a href="#/settings" className="underline hover:no-underline">Enable them in Settings</a>.
          </div>
        )}

        {data?.runMeta?.lastRunStatus === "error" && (
          <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            The last run failed{data.runMeta.lastRunError ? `: ${data.runMeta.lastRunError}` : "."}
          </div>
        )}

        {running && progress && <RunProgressBar progress={progress} />}

        {loading ? (
          <div className="text-sm text-cc-muted py-12 text-center">Loading dashboard...</div>
        ) : !data || data.sessions.length === 0 ? (
          <div className="rounded-xl border border-cc-border bg-cc-card p-8 text-center">
            <p className="text-sm text-cc-fg font-medium">No session summaries yet</p>
            <p className="mt-1 text-xs text-cc-muted">
              Press "Update now" to summarize your recent Claude Code sessions, or enable the
              nightly run in Settings to keep this dashboard fresh automatically.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filter sessions">
              {FILTERS.map((f) => {
                const active = filter === f.id;
                const count = filterCounts.get(f.id) ?? 0;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    aria-pressed={active}
                    className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? "bg-cc-primary text-white"
                        : "bg-cc-hover hover:bg-cc-active text-cc-fg"
                    }`}
                  >
                    {f.label} <span className={active ? "opacity-80" : "text-cc-muted"}>{count}</span>
                  </button>
                );
              })}
            </div>

            {projects.length === 0 ? (
              <div className="text-sm text-cc-muted py-8 text-center">
                No sessions match this filter.
              </div>
            ) : (
              projects.map((project) => (
                <section
                  key={project.key}
                  aria-label={`Project ${project.label}`}
                  className="rounded-xl border border-cc-border bg-cc-card p-4"
                >
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <h2 className="text-sm font-semibold text-cc-fg truncate" title={project.key}>
                      {project.label}
                    </h2>
                    <span className="text-[11px] text-cc-muted whitespace-nowrap">
                      {project.sessions.length} session{project.sessions.length === 1 ? "" : "s"} · active {timeAgo(project.lastActivityAt)}
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {project.sessions.map((session) => (
                      <SessionCard
                        key={session.sessionId}
                        session={session}
                        onArchived={(id) => setArchivedIds((prev) => new Set(prev).add(id))}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
