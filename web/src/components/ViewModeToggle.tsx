import { useCallback } from "react";
import { useStore } from "../store.js";
import { sendSetMagicUi } from "../ws.js";

/**
 * View mode control for the top bar.
 *
 * When the MagicUI feature is unavailable (globally disabled, no Claude CLI,
 * or no current session) this renders exactly the classic two-state message
 * density toggle — nothing changes for existing users.
 *
 * When MagicUI is available it becomes a three-way segmented control:
 * Standard | Compact | Magic. Standard/Compact drive the per-browser density
 * preference (and switch MagicUI off for the session if it was on); Magic
 * flips the per-session server-side opt-in that all connected browsers share.
 */
export function ViewModeToggle({ sessionId }: { sessionId: string | null }) {
  const density = useStore((s) => s.density);
  const magicUiAvailable = useStore((s) => s.magicUiAvailable);
  const magicActive = useStore(
    (s) => !!sessionId && s.sessions.get(sessionId)?.magicUiActive === true,
  );

  const deactivateMagic = useCallback(() => {
    if (!sessionId) return;
    const state = useStore.getState();
    if (state.sessions.get(sessionId)?.magicUiActive === true) {
      state.setSessionMagicUi(sessionId, false);
      sendSetMagicUi(sessionId, false);
    }
  }, [sessionId]);

  const selectStandard = useCallback(() => {
    useStore.getState().setDensity("standard");
    deactivateMagic();
  }, [deactivateMagic]);

  const selectCompact = useCallback(() => {
    useStore.getState().setDensity("compact");
    deactivateMagic();
  }, [deactivateMagic]);

  const selectMagic = useCallback(() => {
    if (!sessionId) return;
    // Optimistic local write; the server echoes a session_update.
    useStore.getState().setSessionMagicUi(sessionId, true);
    sendSetMagicUi(sessionId, true);
  }, [sessionId]);

  if (!magicUiAvailable || !sessionId) {
    return <DensityToggle />;
  }

  const isCompact = density === "compact";
  const segments = [
    {
      key: "standard",
      label: "Standard view",
      active: !magicActive && !isCompact,
      onClick: selectStandard,
      icon: <StandardIcon />,
    },
    {
      key: "compact",
      label: "Compact view",
      active: !magicActive && isCompact,
      onClick: selectCompact,
      icon: <CompactIcon />,
    },
    {
      key: "magic",
      label: "Magic dashboard view",
      active: magicActive,
      onClick: selectMagic,
      icon: <MagicIcon />,
    },
  ];

  return (
    <div
      role="group"
      aria-label="View mode"
      className="flex items-center rounded-md border border-cc-border overflow-hidden"
    >
      {segments.map((seg) => (
        <button
          key={seg.key}
          onClick={seg.onClick}
          className={`flex items-center justify-center w-8 h-8 transition-colors cursor-pointer ${
            seg.active
              ? "text-cc-primary bg-cc-active"
              : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
          title={seg.label}
          aria-label={seg.label}
          aria-pressed={seg.active}
        >
          {seg.icon}
        </button>
      ))}
    </div>
  );
}

/**
 * Message density switch, sitting with the other view preferences (theme,
 * context panel) on the right of the top bar. Same store action the Settings
 * page uses, so the two surfaces can never drift apart.
 */
export function DensityToggle() {
  const density = useStore((s) => s.density);
  const toggle = useCallback(() => useStore.getState().toggleDensity(), []);
  const isCompact = density === "compact";
  const label = isCompact ? "Switch to standard density" : "Switch to compact density";

  return (
    <button
      onClick={toggle}
      className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer ${
        isCompact
          ? "text-cc-primary bg-cc-active"
          : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      }`}
      title={label}
      aria-label={label}
      aria-pressed={isCompact}
    >
      {isCompact ? <CompactIcon /> : <StandardIcon />}
    </button>
  );
}

// Standard: three rules with room to breathe.
function StandardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-[15px] h-[15px]" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

// Compact: four tightly stacked rules.
function CompactIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-[15px] h-[15px]" aria-hidden="true">
      <path d="M4 7h16M4 11h16M4 15h16M4 19h16" />
    </svg>
  );
}

// Magic: a sparkle.
function MagicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[15px] h-[15px]" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    </svg>
  );
}
