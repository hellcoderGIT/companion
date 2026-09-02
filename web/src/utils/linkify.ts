/**
 * Splits plain text into text/link segments so URLs can be rendered as
 * clickable anchors.
 *
 * This exists for contexts where the markdown renderer will NOT autolink for
 * us — most importantly inline code spans, whose content is literal by
 * definition. A message like:
 *
 *   Faktura PR: `https://bitbucket.example.local/.../pull-requests/6517`
 *
 * renders the URL as inert text, which is exactly the case we want clickable.
 */

export type LinkifySegment =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string };

// Deliberately conservative: only explicit http(s) schemes. Bare `www.` or
// host-only strings are skipped because inline code is full of things that
// look host-ish but are not URLs (`package.json`, `a.b.c`).
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

// Sentence punctuation that commonly abuts a URL but is not part of it.
const TRAILING_PUNCT = ".,;:!?]}>'\"";

/**
 * Trims trailing punctuation that belongs to the surrounding prose rather than
 * the URL. A closing paren is kept when the URL itself opened one, so wiki-style
 * links such as `https://en.wikipedia.org/wiki/Foo_(bar)` survive intact.
 */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (ch === ")") {
      const slice = url.slice(0, end);
      const opens = (slice.match(/\(/g) || []).length;
      const closes = (slice.match(/\)/g) || []).length;
      if (opens >= closes) break; // balanced — the paren is part of the URL
      end--;
      continue;
    }
    if (TRAILING_PUNCT.includes(ch)) {
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

/** True when the match still has a host after the scheme (rejects a bare `https://`). */
function hasHost(url: string): boolean {
  return /^https?:\/\/[^\s/]/i.test(url);
}

/**
 * Returns `text` split into ordered segments. Text with no URLs yields a single
 * text segment; empty input yields an empty array.
 */
export function linkify(text: string): LinkifySegment[] {
  if (!text) return [];

  const segments: LinkifySegment[] = [];
  let cursor = 0;
  URL_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    const url = trimTrailingPunctuation(match[0]);
    // Not a usable link — leave the run as prose. `cursor` is intentionally not
    // advanced so the text lands in a later text segment.
    if (!url || !hasHost(url)) continue;

    if (match.index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, match.index) });
    }
    segments.push({ type: "link", value: url, href: url });
    cursor = match.index + url.length;
    // Resume scanning after the trimmed URL, not after the raw match, so any
    // punctuation we gave back is still eligible to be emitted as text.
    URL_RE.lastIndex = cursor;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}

/** Convenience predicate — true when `text` contains at least one linkable URL. */
export function hasLink(text: string): boolean {
  return linkify(text).some((s) => s.type === "link");
}
