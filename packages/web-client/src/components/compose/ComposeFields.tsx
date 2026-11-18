/**
 * Von (with a choice of senders, or after "…" → Absender anzeigen: then the own
 * address, read-only) / An with the Cc and Bcc buttons / Cc / Bcc / Betreff.
 * Entries "Namen prüfen" could not resolve are marked in their field.
 */
import { useId, type ReactNode, type RefObject } from 'react';
import { RecipientField } from './RecipientField.js';
import { senderKey, type SenderOption } from '../../lib/mailboxContext.js';
import type { FieldVisibility } from '../../lib/composeRules.js';
import type { RecipientValue } from '../../lib/recipients.js';
import type { UnresolvedReason } from '../../lib/nameCheck.js';
import { useT } from '../../i18n/useT.js';

function FieldRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 border-b border-line">
      <label htmlFor={htmlFor} className="text-sm text-fg-muted w-14 shrink-0 pt-1">{label}</label>
      {children}
    </div>
  );
}

interface Props {
  visibility: FieldVisibility;
  senders: SenderOption[];
  sender: SenderOption | undefined;
  onSender: (key: string) => void;
  to: RecipientValue;
  cc: RecipientValue;
  bcc: RecipientValue;
  onTo: (v: RecipientValue) => void;
  onCc: (v: RecipientValue) => void;
  onBcc: (v: RecipientValue) => void;
  onShowCc: () => void;
  onShowBcc: () => void;
  subject: string;
  onSubject: (v: string) => void;
  onAnnounce: (text: string) => void;
  /** Entries "Namen prüfen" could not resolve, with the reason. */
  unresolved: Readonly<Record<string, UnresolvedReason>>;
  refs: { to: RefObject<HTMLInputElement | null>; cc: RefObject<HTMLInputElement | null>; bcc: RefObject<HTMLInputElement | null> };
}

export function ComposeFields(p: Props) {
  const t = useT();
  const id = useId();
  const ids = { from: `${id}-from`, to: `${id}-to`, cc: `${id}-cc`, bcc: `${id}-bcc`, subject: `${id}-subject` };
  return (
    <div className="shrink-0">
      {p.visibility.from && p.sender && (
        <FieldRow label={t('compose_from')} htmlFor={ids.from}>
          {p.senders.length > 1 ? (
            <select
              id={ids.from}
              value={senderKey(p.sender)}
              onChange={(e) => p.onSender(e.target.value)}
              className="flex-1 min-w-0 text-sm bg-surface text-fg rounded px-1 py-1 border border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
            >
              {p.senders.map((o) => <option key={senderKey(o)} value={senderKey(o)}>{o.label}</option>)}
            </select>
          ) : (
            <input
              id={ids.from}
              readOnly
              value={p.sender.label}
              className="flex-1 min-w-0 text-sm bg-transparent text-fg py-1 outline-none rounded-sm focus-visible:ring-2 focus-visible:ring-accent-fg"
            />
          )}
        </FieldRow>
      )}
      <FieldRow label={t('compose_to')} htmlFor={ids.to}>
        <RecipientField id={ids.to} label={t('compose_to')} value={p.to} onChange={p.onTo} onAnnounce={p.onAnnounce} unresolved={p.unresolved} inputRef={p.refs.to} />
        <div className="flex gap-1 shrink-0 pt-0.5">
          {p.visibility.ccToggle && (
            <button type="button" onClick={p.onShowCc} aria-label={t('compose_show_cc')} title={t('compose_show_cc')}
              className="px-2 py-0.5 text-sm rounded text-accent-fg hover:bg-surface-2">{t('compose_cc')}</button>
          )}
          {p.visibility.bccToggle && (
            <button type="button" onClick={p.onShowBcc} aria-label={t('compose_show_bcc')} title={t('compose_show_bcc')}
              className="px-2 py-0.5 text-sm rounded text-accent-fg hover:bg-surface-2">{t('compose_bcc')}</button>
          )}
        </div>
      </FieldRow>
      {p.visibility.cc && (
        <FieldRow label={t('compose_cc')} htmlFor={ids.cc}>
          <RecipientField id={ids.cc} label={t('compose_cc')} value={p.cc} onChange={p.onCc} onAnnounce={p.onAnnounce} unresolved={p.unresolved} inputRef={p.refs.cc} />
        </FieldRow>
      )}
      {p.visibility.bcc && (
        <FieldRow label={t('compose_bcc')} htmlFor={ids.bcc}>
          <RecipientField id={ids.bcc} label={t('compose_bcc')} value={p.bcc} onChange={p.onBcc} onAnnounce={p.onAnnounce} unresolved={p.unresolved} inputRef={p.refs.bcc} />
        </FieldRow>
      )}
      <FieldRow label={t('compose_subject')} htmlFor={ids.subject}>
        <input
          id={ids.subject}
          value={p.subject}
          placeholder={t('compose_subject_placeholder')}
          onChange={(e) => p.onSubject(e.target.value)}
          className="flex-1 min-w-0 text-sm font-medium bg-transparent text-fg outline-none py-1 rounded-sm focus-visible:ring-2 focus-visible:ring-accent-fg"
        />
      </FieldRow>
    </div>
  );
}
