import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "../store.js";
import type { Density } from "../store/ui-slice.js";

export type { Density };

/**
 * Optional per-subtree override of the user's density preference.
 *
 * Normally `null`, and every message-flow component just reads the persisted
 * store value. The override exists so surfaces that need to show both layouts
 * at once (the Playground, tests) can pin one subtree without mutating the
 * user's actual preference.
 */
const DensityOverrideContext = createContext<Density | null>(null);

export function DensityProvider({
  value,
  children,
}: {
  value: Density;
  children: ReactNode;
}) {
  return (
    <DensityOverrideContext.Provider value={value}>
      {children}
    </DensityOverrideContext.Provider>
  );
}

/** Resolved density: subtree override if present, otherwise the stored preference. */
export function useDensity(): Density {
  const override = useContext(DensityOverrideContext);
  const stored = useStore((s) => s.density);
  return override ?? stored;
}

/** Convenience wrapper — the only thing most call sites care about. */
export function useIsCompact(): boolean {
  return useDensity() === "compact";
}

/**
 * Shared disclosure row for compact mode: a chevron + one truncated line.
 * Keeps the "collapsed narrow line" look identical across commands, diffs
 * and tool output instead of re-implementing it per block.
 */
export function CompactDisclosure({
  open,
  onToggle,
  marker,
  label,
  meta,
  labelClassName = "",
}: {
  open: boolean;
  onToggle: () => void;
  /** Tiny mono glyph in front of the label — e.g. "$" for a shell command. */
  marker?: string;
  label: string;
  /** Right-hand hint, e.g. "34 lines". */
  meta?: string;
  labelClassName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center gap-1.5 py-0.5 text-left group cursor-pointer"
    >
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
        className={`w-2.5 h-2.5 shrink-0 text-cc-muted/40 group-hover:text-cc-muted/70 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
      {marker && (
        <span className="text-[11px] font-mono-code text-cc-muted/40 select-none shrink-0">
          {marker}
        </span>
      )}
      <span
        className={`text-[11px] text-cc-muted/60 group-hover:text-cc-muted truncate min-w-0 ${labelClassName}`}
      >
        {label}
      </span>
      {meta && (
        <span className="text-[10px] text-cc-muted/35 shrink-0 ml-auto tabular-nums">
          {meta}
        </span>
      )}
    </button>
  );
}
