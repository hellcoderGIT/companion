import { useMemo, useState, type ReactNode } from "react";
import { summarizeRun, type ActivityRun } from "./activity-run.js";
import { AssistantAvatar } from "./MessageBubble.js";
import { ToolIcon, getToolIcon } from "./ToolBlock.js";
import { formatElapsed } from "../utils/format.js";

/**
 * ActivityRunBlock — compact-density rendering of a folded stretch of agent
 * work (see `activity-run.ts`).
 *
 * Collapsed (default) it is exactly two lines:
 *   ● Working · 12 tool calls · 1 subagent · 1m 05s          8 steps
 *     $ Terminal · Check hostname, repo state, and list backend docs
 *
 * The second line is the *latest* action and changes as new steps arrive, so a
 * live session still reads as busy without the feed growing. Expanding renders
 * the children with the same components standard density uses; `children` is
 * passed in by the feed (rather than imported) to avoid a MessageFeed ↔
 * ActivityRun import cycle.
 */
export function ActivityRunBlock({
  run,
  live,
  children,
}: {
  run: ActivityRun;
  /** True while the agent is still adding steps to this run. */
  live: boolean;
  /** Fully rendered child entries — only mounted once the run is expanded. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The feed re-renders once a second while a session is running (its elapsed
  // ticker), so reading Date.now() here keeps a live run's timer moving.
  const now = live ? Date.now() : undefined;
  const summary = useMemo(() => summarizeRun(run, now), [run, now]);

  const elapsedMs =
    summary.startedAt !== null && summary.endedAt !== null
      ? Math.max(0, summary.endedAt - summary.startedAt)
      : null;

  const parts: ReactNode[] = [];
  if (summary.toolCalls > 0) {
    parts.push(`${summary.toolCalls} tool call${summary.toolCalls === 1 ? "" : "s"}`);
  }
  if (summary.subagents > 0) {
    parts.push(`${summary.subagents} subagent${summary.subagents === 1 ? "" : "s"}`);
  }
  if (summary.errors > 0) {
    parts.push(
      <span key="err" className="text-cc-error">
        {summary.errors} error{summary.errors === 1 ? "" : "s"}
      </span>,
    );
  }
  if (elapsedMs !== null && elapsedMs >= 1000) {
    parts.push(formatElapsed(elapsedMs));
  }

  const title = live ? "Working" : "Worked";
  const stepsLabel = `${summary.steps} step${summary.steps === 1 ? "" : "s"}`;
  const latest = summary.latest;

  return (
    <div className="animate-[fadeSlideIn_0.3s_ease-out]" data-activity-run={run.key}>
      <div className="flex items-start gap-3">
        <AssistantAvatar />
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${title}: ${stepsLabel}, ${open ? "collapse" : "expand"} details`}
            className="w-full flex items-center gap-1.5 py-0.5 text-left group cursor-pointer min-w-0"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              className={`w-2.5 h-2.5 shrink-0 text-cc-muted/40 group-hover:text-cc-muted/70 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                live
                  ? "bg-cc-primary animate-[typing-breathe_1.5s_ease-in-out_infinite]"
                  : "bg-cc-success/60"
              }`}
            />
            <span className="text-[11px] font-medium text-cc-fg/70 shrink-0">{title}</span>
            {parts.length > 0 && (
              <span className="text-[11px] text-cc-muted/60 font-mono-code truncate min-w-0 tabular-nums">
                {parts.map((p, i) => (
                  <span key={i}>
                    <span className="text-cc-muted/35"> · </span>
                    {p}
                  </span>
                ))}
              </span>
            )}
            <span className="ml-auto text-[10px] text-cc-muted/40 group-hover:text-cc-muted/70 shrink-0 tabular-nums">
              {open ? "hide" : stepsLabel}
            </span>
          </button>

          {!open && latest && (
            <div
              role="status"
              className="flex items-center gap-1.5 pl-4 py-0.5 text-[11px] min-w-0"
            >
              {latest.toolName && <ToolIcon type={getToolIcon(latest.toolName)} />}
              <span
                className={`truncate min-w-0 ${
                  latest.italic
                    ? "italic text-cc-muted/60"
                    : "font-mono-code text-cc-muted/70"
                }`}
              >
                {latest.label}
              </span>
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-5 sm:space-y-7 animate-[fadeSlideIn_0.2s_ease-out]">
          {children}
        </div>
      )}
    </div>
  );
}
