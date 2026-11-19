/** "Über CoreMail": product name and the running version (from the changelog API). */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { useBranding } from '../../hooks/useBranding.js';
import { Modal } from '../Modal.js';

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { productName } = useBranding();
  const { data } = useQuery({
    queryKey: ['about', 'version'],
    queryFn: () => api.get<{ versions: Array<{ version: string }> }>('/changelog'),
    staleTime: 10 * 60_000,
    retry: false,
    meta: { silentError: true },
  });
  const version = data?.versions[0]?.version;
  return (
    <Modal onClose={onClose} labelledBy="about-title" className="bg-surface rounded-xl shadow-2xl w-full max-w-sm p-6">
      <h2 id="about-title" className="text-lg font-semibold text-fg">Über {productName}</h2>
      <p className="mt-2 text-sm text-fg-muted">{version ? `Version ${version}` : 'Version nicht verfügbar'}</p>
      <div className="mt-5 flex justify-end">
        <button type="button" className="btn-primary text-sm" onClick={onClose}>Schließen</button>
      </div>
    </Modal>
  );
}
