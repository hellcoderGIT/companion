import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton.js";
import { childrenToPlainText } from "../utils/children-text.js";
import { linkify } from "../utils/linkify.js";

const MAX_LABEL_CHARS = 40;

interface InlineCodeProps {
  children?: ReactNode;
  /** Extra classes on the pill wrapper. */
  className?: string;
  /** Overrides the default size/color classes on the inner <code>. */
  textClassName?: string;
}

/** Keeps the copy button's accessible name distinguishable without reading out a whole URL. */
function copyLabelFor(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "Copy";
  const shown = flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
  return `Copy ${shown}`;
}

/**
 * Inline `code` span with two affordances the bare <code> pill lacked:
 *
 * 1. A copy button — selecting inline text by hand is near-impossible on touch,
 *    and these spans routinely hold PR URLs, IDs and paths that exist purely to
 *    be copied elsewhere.
 * 2. Clickable URLs — markdown treats code-span content as literal, so a URL in
 *    backticks renders inert. We linkify it back.
 *
 * Renders only inline elements (span/code/a/button) so it stays valid inside a
 * <p>, which is where ReactMarkdown puts inline code.
 */
export function InlineCode({ children, className = "", textClassName = "text-[12.5px] text-cc-fg/80" }: InlineCodeProps) {
  const text = childrenToPlainText(children);

  // Non-textual children (or an empty span) have nothing to copy or link —
  // fall back to the plain pill rather than showing a button that copies "".
  if (!text) {
    return (
      <code
        className={`px-1.5 py-0.5 rounded-md bg-cc-fg/[0.06] font-mono-code border border-cc-border/40 ${textClassName} ${className}`}
      >
        {children}
      </code>
    );
  }

  const segments = linkify(text);

  return (
    <span
      className={`inline-flex items-center align-middle max-w-full gap-1 pl-1.5 pr-1 py-0.5 rounded-md bg-cc-fg/[0.06] border border-cc-border/40 ${className}`}
    >
      <code className={`min-w-0 break-all font-mono-code ${textClassName}`}>
        {segments.map((seg, i) =>
          seg.type === "link" ? (
            <a
              key={i}
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cc-primary underline decoration-cc-primary/40 hover:decoration-cc-primary"
            >
              {seg.value}
            </a>
          ) : (
            <span key={i}>{seg.value}</span>
          ),
        )}
      </code>
      <CopyButton
        text={text}
        label={copyLabelFor(text)}
        className="shrink-0 self-center w-4 h-4 -my-0.5 opacity-60 hover:opacity-100"
      />
    </span>
  );
}
