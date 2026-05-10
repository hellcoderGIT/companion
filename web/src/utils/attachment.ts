/**
 * File attachments uploaded by the user (images, PDFs, or any other file).
 *
 * The bridge dispatches these by mediaType:
 *  - image/* and application/pdf go inline as Claude content blocks
 *  - everything else is written to disk in the session cwd and referenced
 *    by relative path so the model can Read it via its tools
 */
export interface Attachment {
  name: string;
  base64: string;
  mediaType: string;
  /** Decoded byte size (not base64 length). */
  size: number;
}

/**
 * Per-attachment cap. Larger files are rejected client-side before encoding to
 * avoid OOMs (base64 inflates by ~33%). Backend re-validates with the same cap.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Aggregate cap across all attachments in a single message. Keeps WebSocket
 * frames under the default Bun maxPayloadLength even after base64 expansion.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB

export function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      // file.type can be empty for some extensions; default to a generic binary type
      const mediaType = file.type || "application/octet-stream";
      resolve({ base64, mediaType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Format byte count for display in attachment previews. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

export function isPdfMediaType(mediaType: string): boolean {
  return mediaType === "application/pdf";
}
