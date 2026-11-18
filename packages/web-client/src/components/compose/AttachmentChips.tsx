/** Attachment chips above the body: name, size, remove. */
import { FileIcon, X } from 'lucide-react';
import { isDraftAttachment } from '../../lib/draft-autosave.js';
import { formatSize } from '../../lib/composeRules.js';
import type { ComposeAttachment } from '../../store/ui.js';
import { fmt, useT } from '../../i18n/useT.js';

export const attachmentName = (a: ComposeAttachment): string => (isDraftAttachment(a) ? a.filename : a.name);

interface Props {
  attachments: ComposeAttachment[];
  onRemove: (index: number) => void;
}

export function AttachmentChips({ attachments, onRemove }: Props) {
  const t = useT();
  if (attachments.length === 0) return null;
  return (
    <ul aria-label={t('compose_attachments')} className="flex flex-wrap gap-2">
      {attachments.map((a, i) => {
        const name = attachmentName(a);
        return (
          <li key={`${name}-${i}`} className="flex items-center gap-1.5 bg-surface-2 border border-line rounded px-2.5 py-1 text-xs text-fg-muted">
            <FileIcon size={13} className="text-accent-fg shrink-0" aria-hidden="true" />
            <span className="max-w-[12rem] truncate text-fg" title={name}>{name}</span>
            <span className="text-fg-subtle shrink-0">{formatSize(a.size)}</span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={fmt(t('compose_remove_attachment'), { name })}
              title={fmt(t('compose_remove_attachment'), { name })}
              className="p-0.5 rounded text-fg-subtle hover:text-danger-fg hover:bg-surface-3 shrink-0"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
