import { Calendar, Repeat } from 'lucide-react';
import { Modal } from '../Modal.js';

/**
 * 9.4: opening an occurrence of a recurring event — edit only this occurrence
 * (override) or the whole series.
 */
interface Props {
  summary: string;
  onChoose: (scope: 'occurrence' | 'series') => void;
  onClose: () => void;
}

export function OccurrenceChoice({ summary, onChoose, onClose }: Props) {
  return (
    <Modal onClose={onClose} label="Serientermin öffnen" className="bg-surface rounded-lg shadow-xl w-full max-w-sm p-5">
      <h2 className="text-sm font-semibold text-fg mb-1">„{summary}" ist ein Serientermin</h2>
      <p className="text-xs text-fg-subtle mb-4">Was möchtest du öffnen?</p>
      <div className="space-y-2">
        <button type="button" autoFocus onClick={() => onChoose('occurrence')}
          className="w-full flex items-center gap-2 px-3 py-2 rounded border border-line-strong text-sm text-fg hover:bg-surface-2">
          <Calendar size={15} aria-hidden="true" />Nur dieses Ereignis
        </button>
        <button type="button" onClick={() => onChoose('series')}
          className="w-full flex items-center gap-2 px-3 py-2 rounded border border-line-strong text-sm text-fg hover:bg-surface-2">
          <Repeat size={15} aria-hidden="true" />Die gesamte Serie
        </button>
      </div>
      <div className="mt-4 text-right">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-2 rounded">Abbrechen</button>
      </div>
    </Modal>
  );
}
