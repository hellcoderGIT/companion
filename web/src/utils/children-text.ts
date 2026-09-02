/**
 * Flattens the React children passed to a ReactMarkdown renderer into a plain
 * string so features like copy-to-clipboard and linkification have a stable
 * payload.
 *
 * ReactMarkdown hands a `code` renderer either a raw string (fenced block) or
 * an array containing a single string, but syntax plugins can nest elements —
 * this walker handles all three without pulling in a full React->text helper.
 */
export function childrenToPlainText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenToPlainText).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    // ReactElement — recurse into its children prop
    const el = node as { props?: { children?: unknown } };
    return childrenToPlainText(el.props?.children);
  }
  return "";
}
