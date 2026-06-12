import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { captureException } from "../analytics.js";

type ExportFormat = "html" | "txt";

export function ExportMenu({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const download = useCallback(
    async (format: ExportFormat) => {
      setBusy(format);
      setError(false);
      try {
        const { blob, filename } = await api.exportSession(sessionId, format);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setOpen(false);
      } catch (err) {
        captureException(err);
        setError(true);
      } finally {
        setBusy(null);
      }
    },
    [sessionId],
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer ${
          open
            ? "text-cc-primary bg-cc-active"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        }`}
        title="Export session"
        aria-label="Export session"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[15px] h-[15px]">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 min-w-[176px] rounded-lg border border-cc-border bg-cc-card shadow-lg py-1 animate-[fadeSlideIn_0.15s_ease-out]"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-cc-muted">
            Export session
          </div>
          <button
            role="menuitem"
            onClick={() => download("html")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {busy === "html" ? "Exporting…" : "Download as HTML"}
            <span className="block text-[10px] text-cc-muted">Includes images</span>
          </button>
          <button
            role="menuitem"
            onClick={() => download("txt")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {busy === "txt" ? "Exporting…" : "Download as Text"}
            <span className="block text-[10px] text-cc-muted">Plain text, no images</span>
          </button>
          {error && (
            <div className="px-3 py-1.5 text-[11px] text-cc-error">Export failed</div>
          )}
        </div>
      )}
    </div>
  );
}
