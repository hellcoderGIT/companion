import { extractProjectKey, type SessionItem } from "./project-grouping.js";

export interface ProjectFilter {
  /** Normalized project key (repo root or cwd), see extractProjectKey */
  key: string;
  /** Display label (last path component) */
  label: string;
}

export function sessionProjectKey(s: SessionItem): string {
  return extractProjectKey(s.cwd, s.repoRoot || undefined, s.isContainerized);
}

/** Lower-cased haystack of everything a user might search a session by. */
function searchText(s: SessionItem, name: string | undefined): string {
  return [
    name,
    s.id,
    s.cwd,
    s.repoRoot,
    s.gitBranch,
    s.model,
    s.cronJobName,
    s.agentName,
    s.userName,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * Filters sessions by a free-text query and optional project key, preserving order.
 * The query is split on whitespace and every term must match (AND, case-insensitive)
 * somewhere in the session's name, path, branch, model, cron/agent name or user.
 */
export function filterSessions(
  sessions: SessionItem[],
  query: string,
  projectKey: string | null,
  sessionNames: Map<string, string>,
): SessionItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 && !projectKey) return sessions;
  return sessions.filter((s) => {
    if (projectKey && sessionProjectKey(s) !== projectKey) return false;
    if (terms.length === 0) return true;
    const text = searchText(s, sessionNames.get(s.id));
    return terms.every((t) => text.includes(t));
  });
}
