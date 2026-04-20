import { useEffect, useRef, useState } from "react";

const COPIED_FLASH_MS = 1500;

interface CopyButtonProps {
  /** Text placed on the clipboard on click. */
  text: string;
  /** Accessible name + tooltip. Defaults to "Copy". */
  label?: string;
  /** Extra classes for the outer button — use to position. */
  className?: string;
}

// Falls back to document.execCommand when navigator.clipboard is unavailable
// (older browsers, insecure contexts). Returns true on success.
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export function CopyButton({ text, label = "Copy", className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onClick = async () => {
    const ok = await writeClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FLASH_MS);
  };

  const effectiveLabel = copied ? "Copied" : label;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={effectiveLabel}
      title={effectiveLabel}
      className={`inline-flex items-center justify-center w-6 h-6 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors ${className}`}
    >
      {copied ? (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5 text-cc-success"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          className="w-3.5 h-3.5"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="8" height="9" rx="1.25" />
          <path d="M10.5 5V3.75A.75.75 0 009.75 3H3.75A.75.75 0 003 3.75v6a.75.75 0 00.75.75H5" />
        </svg>
      )}
    </button>
  );
}
