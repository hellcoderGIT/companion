import { formatBytes, isImageMediaType } from "../utils/attachment.js";

/**
 * Small icon used as a fallback preview for non-image attachments. Picks a
 * symbol based on the file extension so PDFs / archives / docs are visually
 * distinguishable at a glance.
 */
function FileTypeIcon({ name, mediaType }: { name: string; mediaType: string }) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  // High-level category by extension or media type
  let label = "FILE";
  if (mediaType === "application/pdf" || ext === "pdf") label = "PDF";
  else if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext)) label = "ZIP";
  else if (["csv", "tsv"].includes(ext)) label = "CSV";
  else if (["json", "yaml", "yml", "toml", "xml"].includes(ext)) label = "DATA";
  else if (["md", "txt", "log"].includes(ext)) label = "TXT";
  else if (["doc", "docx", "rtf", "odt"].includes(ext)) label = "DOC";
  else if (["xls", "xlsx", "ods"].includes(ext)) label = "XLS";
  else if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) label = "AUD";
  else if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) label = "VID";
  else if (ext) label = ext.slice(0, 4).toUpperCase();

  return (
    <div className="flex flex-col items-center justify-center w-full h-full bg-cc-hover/60 text-cc-muted">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-4 h-4 mb-0.5">
        <path d="M3 1.75h6.5L13 5.25v9A1.25 1.25 0 0 1 11.75 15.5h-7.5A1.25 1.25 0 0 1 3 14.25V1.75z" />
        <path d="M9.5 1.75V5.25H13" />
      </svg>
      <span className="text-[8px] font-mono-code tracking-tight">{label}</span>
    </div>
  );
}

interface AttachmentThumbnailProps {
  name: string;
  mediaType: string;
  base64: string;
  size: number;
  onRemove?: () => void;
  /** Tailwind sizing class — default 12x12 (Composer); pass "w-10 h-10" for HomePage. */
  className?: string;
}

/**
 * Composer-style chip for an attachment that hasn't been sent yet (still in
 * the input bar). Image previews render as a thumbnail; everything else gets
 * a generic file icon with the extension label and size on hover.
 */
export function AttachmentChip({
  name,
  mediaType,
  base64,
  size,
  onRemove,
  className = "w-12 h-12",
}: AttachmentThumbnailProps) {
  const isImage = isImageMediaType(mediaType);
  return (
    <div className="relative group" title={`${name} (${formatBytes(size)})`}>
      <div className={`${className} rounded-lg overflow-hidden border border-cc-border`}>
        {isImage ? (
          <img
            src={`data:${mediaType};base64,${base64}`}
            alt={name}
            className="w-full h-full object-cover"
          />
        ) : (
          <FileTypeIcon name={name} mediaType={mediaType} />
        )}
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * MessageBubble-style attachment renderer for sent messages. Images keep their
 * inline preview; non-images render as a download-link card with filename and
 * size.
 */
export function MessageAttachment({
  name,
  mediaType,
  data,
  size,
}: {
  name: string;
  mediaType: string;
  data: string;
  size: number;
}) {
  const isImage = isImageMediaType(mediaType);
  if (isImage) {
    return (
      <img
        src={`data:${mediaType};base64,${data}`}
        alt={name || "attachment"}
        className="max-w-[150px] sm:max-w-[200px] max-h-[120px] sm:max-h-[150px] rounded-xl object-cover border border-cc-border/30"
      />
    );
  }
  return (
    <a
      href={`data:${mediaType};base64,${data}`}
      download={name || "attachment"}
      className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-cc-border/40 bg-cc-hover/40 hover:bg-cc-hover transition-colors max-w-[260px] no-underline"
    >
      <div className="w-8 h-8 shrink-0 rounded-md overflow-hidden">
        <FileTypeIcon name={name} mediaType={mediaType} />
      </div>
      <div className="min-w-0 flex flex-col">
        <span className="text-[12px] font-medium text-cc-fg truncate">{name || "attachment"}</span>
        <span className="text-[10px] text-cc-muted">{formatBytes(size)}</span>
      </div>
    </a>
  );
}
