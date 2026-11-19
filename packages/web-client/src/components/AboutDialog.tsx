/** "Über CoreMail" of the ribbons' Hilfe tab (mail, calendar, contacts): product name and the released version (GET /changelog). */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Modal } from './Modal.js';
import { useBranding } from '../hooks/useBranding.js';
import { latestReleasedVersion } from '../lib/ribbon.js';
import { fmt, useT } from '../i18n/useT.js';

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { productName } = useBranding();
  const { data, isError } = useQuery({
    queryKey: ['changelog-version'],
    queryFn: () => api.get<{ versions: { version: string }[] }>('/changelog'),
    staleTime: 60 * 60_000,
    retry: false,
    meta: { silentError: true },
  });
  const version = latestReleasedVersion(data?.versions);
  return (
    <Modal onClose={onClose} labelledBy="about-title" className="bg-surface rounded-xl shadow-2xl w-full max-w-sm p-6">
      <h2 id="about-title" className="text-lg font-semibold text-fg">{fmt(t('help_cmd_about'), { product: productName })}</h2>
      <p className="mt-2 text-sm text-fg-muted">
        {version ? fmt(t('help_about_version'), { version }) : isError ? t('help_about_unknown') : '…'}
      </p>
      <div className="mt-6 flex justify-end">
        <button type="button" autoFocus onClick={onClose} className="btn-secondary text-sm">OK</button>
      </div>
    </Modal>
  );
}
