/** Read view of a global address book entry (name, address, domain). Mail via the action row of the details card. */
import { AtSign, Building2 } from 'lucide-react';
import { ContactAvatar } from './ContactDetails.js';
import type { DirectoryEntry } from '../../lib/contactsList.js';

export function DirectoryDetails({ entry }: { entry: DirectoryEntry }) {
  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="flex items-start gap-4 mb-6">
        <ContactAvatar name={entry.displayName} email={entry.email} className="w-16 h-16 text-xl" />
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-fg leading-tight">{entry.displayName}</h2>
          <p className="text-sm text-fg-subtle mt-0.5">Globales Adressbuch</p>
        </div>
      </div>
      <dl className="border border-line rounded-lg divide-y divide-line text-sm">
        <div className="flex items-start gap-3 px-4 py-3">
          <AtSign size={15} className="text-fg-subtle mt-0.5" aria-hidden="true" />
          <dt className="text-xs text-fg-subtle w-32 shrink-0 mt-0.5">E-Mail</dt>
          <dd className="min-w-0 break-words"><a href={`mailto:${entry.email}`} className="text-accent-fg hover:underline">{entry.email}</a></dd>
        </div>
        {entry.domain && (
          <div className="flex items-start gap-3 px-4 py-3">
            <Building2 size={15} className="text-fg-subtle mt-0.5" aria-hidden="true" />
            <dt className="text-xs text-fg-subtle w-32 shrink-0 mt-0.5">Domain</dt>
            <dd className="min-w-0 break-words">{entry.domain}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
