import { createLogger } from '@coremail/core';
import type { ParsedAttachment } from '@coremail/storage';

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

export interface AttachmentFilterResult {
  blocked: boolean;
  reason?: string;
  filename?: string;
}

export function checkAttachments(
  attachments: ParsedAttachment[],
  maxSizeBytes = 50 * 1024 * 1024, // 50 MB default
): AttachmentFilterResult {
  for (const att of attachments) {
    if (BLOCKED_MIME_TYPES.has(att.mimeType.toLowerCase())) {
      log.warn({ filename: att.filename, mimeType: att.mimeType }, 'Attachment: blocked MIME type');
      return {
        blocked: true,
        reason: `Attachment type not allowed: ${att.mimeType}`,
        filename: att.filename,
      };
    }

    if (DANGEROUS_DOUBLE_EXT_RE.test(att.filename)) {
      log.warn({ filename: att.filename }, 'Attachment: dangerous double extension');
      return {
        blocked: true,
        reason: `Dangerous file extension: ${att.filename}`,
        filename: att.filename,
      };
    }

    if (att.size > maxSizeBytes) {
      log.warn({ filename: att.filename, size: att.size }, 'Attachment: too large');
      return {
        blocked: true,
        reason: `Attachment too large: ${att.filename} (${att.size} bytes)`,
        filename: att.filename,
      };
    }
  }

  return { blocked: false };
}
