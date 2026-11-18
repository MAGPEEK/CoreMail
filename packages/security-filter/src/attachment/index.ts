import { createLogger } from '@coremail/core';
import type { ParsedAttachment } from '@coremail/storage';
import { normalizeExtension, fileExtension } from '@coremail/storage/file-types';

const log = createLogger('security-filter:attachment');

const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-msdos-program',
  'application/x-bat',
  'application/x-msbatch',
  'application/vbs',
  'application/x-vbs',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/x-sh',
]);

// Double extensions that are dangerous (e.g. invoice.pdf.exe)
const DANGEROUS_DOUBLE_EXT_RE = /\.(pdf|doc|docx|xls|xlsx|zip|rar|img|iso)\.(exe|bat|vbs|js|scr|cmd|com|pif)$/i;

/** Schema defaults of SecuritySettings.attachmentBlockedExt / attachmentMaxSizeMb. */
export const DEFAULT_BLOCKED_EXTENSIONS: readonly string[] = ['exe', 'vbs', 'js', 'bat', 'cmd', 'scr', 'pif', 'msi', 'hta', 'com'];
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface AttachmentFilterOptions {
  /** SecuritySettings.attachmentEnabled — false skips the whole filter. */
  enabled?: boolean;
  /** Per-attachment size limit in bytes (SecuritySettings.attachmentMaxSizeMb). */
  maxSizeBytes?: number;
  /** Blocked file extensions without dot, case-insensitive (SecuritySettings.attachmentBlockedExt). */
  blockedExtensions?: readonly string[];
}

export interface AttachmentFilterResult {
  blocked: boolean;
  reason?: string;
  filename?: string;
}

// 9.4: shared with the webmail attachment policy (storage file-types.ts)
export { normalizeExtension, fileExtension };

export function checkAttachments(
  attachments: ParsedAttachment[],
  opts: AttachmentFilterOptions | number = {},
): AttachmentFilterResult {
  // Backwards compatible signature: checkAttachments(atts, maxSizeBytes)
  const o: AttachmentFilterOptions = typeof opts === 'number' ? { maxSizeBytes: opts } : opts;
  if (o.enabled === false) return { blocked: false };
  const maxSizeBytes = o.maxSizeBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const blockedExt = new Set((o.blockedExtensions ?? DEFAULT_BLOCKED_EXTENSIONS).map(normalizeExtension).filter(Boolean));

  for (const att of attachments) {
    const filename = att.filename ?? '';
    if (BLOCKED_MIME_TYPES.has((att.mimeType ?? '').toLowerCase())) {
      log.warn({ filename, mimeType: att.mimeType }, 'Attachment: blocked MIME type');
      return { blocked: true, reason: `Attachment type not allowed: ${att.mimeType}`, filename };
    }

    if (DANGEROUS_DOUBLE_EXT_RE.test(filename.replace(/[\s.]+$/, ''))) {
      log.warn({ filename }, 'Attachment: dangerous double extension');
      return { blocked: true, reason: `Dangerous file extension: ${filename}`, filename };
    }

    const ext = fileExtension(filename);
    if (ext && blockedExt.has(ext)) {
      log.warn({ filename, ext }, 'Attachment: blocked extension');
      return { blocked: true, reason: `Attachment extension not allowed: .${ext}`, filename };
    }

    if (att.size > maxSizeBytes) {
      log.warn({ filename, size: att.size }, 'Attachment: too large');
      return { blocked: true, reason: `Attachment too large: ${filename} (${att.size} bytes)`, filename };
    }
  }

  return { blocked: false };
}
