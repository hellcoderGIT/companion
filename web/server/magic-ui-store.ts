// ─── MagicUI dashboard state persistence ─────────────────────────────────────
//
// One JSON file per session under ~/.companion/magic-ui/. Debounced writes
// (same 150ms pattern as session-store.ts) because the watcher can emit
// several patches in quick succession. State survives server restarts so a
// reload / late-joining browser instantly sees the current dashboard.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { emptyMagicUiState, type MagicUiDashboardState } from "./magic-ui-types.js";

const WRITE_DEBOUNCE_MS = 150;

export class MagicUiStore {
  private readonly dir: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, MagicUiDashboardState>();

  constructor(dir?: string) {
    this.dir = dir || join(COMPANION_HOME, "magic-ui");
  }

  private fileFor(sessionId: string): string {
    // Session ids are UUIDs, but never trust them as path components.
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  load(sessionId: string, now: number): MagicUiDashboardState {
    try {
      const file = this.fileFor(sessionId);
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<MagicUiDashboardState>;
        if (raw && typeof raw.version === "number" && raw.slots && typeof raw.slots === "object") {
          return {
            ...emptyMagicUiState(now),
            ...raw,
            // A freshly loaded dashboard is not being driven yet.
            status: "stopped",
          } as MagicUiDashboardState;
        }
      }
    } catch {
      // Corrupt state file → start fresh; the watcher rebuilds from its seed.
    }
    return emptyMagicUiState(now);
  }

  save(sessionId: string, state: MagicUiDashboardState): void {
    this.pending.set(sessionId, state);
    if (this.timers.has(sessionId)) return;
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        this.flush(sessionId);
      }, WRITE_DEBOUNCE_MS),
    );
  }

  flush(sessionId: string): void {
    const state = this.pending.get(sessionId);
    if (!state) return;
    this.pending.delete(sessionId);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.fileFor(sessionId), JSON.stringify(state), "utf-8");
    } catch (err) {
      console.warn(`[magic-ui] Failed to persist dashboard for ${sessionId}:`, err);
    }
  }

  flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      const timer = this.timers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.timers.delete(sessionId);
      this.flush(sessionId);
    }
  }

  remove(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.pending.delete(sessionId);
    try {
      rmSync(this.fileFor(sessionId), { force: true });
    } catch {
      // best-effort
    }
  }
}
