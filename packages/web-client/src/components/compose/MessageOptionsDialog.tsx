/**
 * 9.4: "…" → Nachrichtenoptionen — Vertraulichkeit (Normal / Persönlich /
 * Privat / Vertraulich, the `Sensitivity` header), Lesebestätigung anfordern
 * (only when Settings → Lesen offers it) and Übermittlungsbestätigung
 * anfordern. OK applies, Abbrechen / Esc keeps the previous options.
 */
import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Modal } from '../Modal.js';
import { SENSITIVITY_LEVELS, type Sensitivity } from '../../lib/sensitivity.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

export interface MessageOptions {
  sensitivity: Sensitivity;
  requestReceipt: boolean;
  deliveryReceipt: boolean;
}

interface Props {
  initial: MessageOptions;
  /** The read receipt choice is offered (Settings → Lesen). */
  receiptVisible: boolean;
  onApply: (options: MessageOptions) => void;
  onCancel: () => void;
}

const CHECKBOX = 'h-4 w-4 rounded border-line-strong text-accent focus-visible:ring-2 focus-visible:ring-accent-fg';

export function MessageOptionsDialog({ initial, receiptVisible, onApply, onCancel }: Props) {
  const t = useT();
  const id = useId();
  const [options, setOptions] = useState<MessageOptions>(initial);
  const set = <K extends keyof MessageOptions>(key: K, value: MessageOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  return createPortal(
    <Modal
      onClose={onCancel}
      labelledBy={`${id}-title`}
      overlayClassName="fixed inset-0 z-[200] flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-lg shadow-xl w-[420px] max-w-full"
    >
      <form onSubmit={(e) => { e.preventDefault(); onApply(options); }}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <h3 id={`${id}-title`} className="text-base font-semibold text-fg">{t('compose_options_title')}</h3>
          <button type="button" onClick={onCancel} aria-label={t('compose_close')} className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-2">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label htmlFor={`${id}-sensitivity`} className="block text-sm text-fg-muted mb-1.5">{t('compose_sensitivity')}</label>
            <select
              id={`${id}-sensitivity`}
              value={options.sensitivity}
              onChange={(e) => set('sensitivity', e.target.value as Sensitivity)}
              className="w-full text-sm bg-surface text-fg rounded px-2 py-1.5 border border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
            >
              {SENSITIVITY_LEVELS.map((level) => (
                <option key={level} value={level}>{t(`compose_sensitivity_${level}` as TranslationKey)}</option>
              ))}
            </select>
          </div>
          {receiptVisible && (
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" className={CHECKBOX} checked={options.requestReceipt} onChange={(e) => set('requestReceipt', e.target.checked)} />
              {t('compose_receipt')}
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" className={CHECKBOX} checked={options.deliveryReceipt} onChange={(e) => set('deliveryReceipt', e.target.checked)} />
            {t('compose_delivery_receipt')}
          </label>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-line">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded border border-line-strong text-fg hover:bg-surface-2">
            {t('cancel')}
          </button>
          <button type="submit" className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover">
            {t('compose_options_apply')}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
