/**
 * 9.5: read view of a contact — every typed value with its German type label.
 * Web pages are links only for http(s); chat addresses are plain text.
 */
import type { ReactNode } from 'react';
import {
  AtSign, Briefcase, Cake, Globe, Heart, MapPin, MessageCircle, MessageSquare, Phone, Tag, User,
} from 'lucide-react';
import {
  PHONE_TYPE_LABEL, PLACE_TYPE_LABEL, addressLines, formatGermanDate, formFromContact, isWebUrl, type ContactDetail,
} from '../../lib/contactForm.js';
import { CategoryChips } from '../CategoryPicker.js';
import { AvatarPhoto } from '../Avatar.js';
import { getInitials } from '../../lib/initials.js';
import { usePhotoForAddress } from '../../hooks/useUserPhoto.js';

function DetailRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 text-sm">
      <span className="text-fg-subtle shrink-0 mt-0.5" aria-hidden="true">{icon}</span>
      <span className="text-xs text-fg-subtle w-32 shrink-0 mt-0.5">{label}</span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/** Round contact picture: the profile photo of an internal address (9.5), else the initials. */
export function ContactAvatar({ name, email, className }: { name: string; email?: string | null | undefined; className: string }) {
  const photoUrl = usePhotoForAddress(email);
  return (
    <div className={`${className} rounded-full bg-accent flex items-center justify-center text-white font-bold shrink-0 overflow-hidden`} aria-hidden="true">
      {photoUrl ? <AvatarPhoto src={photoUrl} /> : getInitials(name, email)}
    </div>
  );
}

/** The commands (edit, delete, e-mail, call) live in the action row of the details card (lib/contactsCommands.ts). */
export function ContactDetails({ contact }: { contact: ContactDetail }) {
  const view = formFromContact(contact);
  const primary = view.emails[0]?.value;
  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="flex items-start gap-4 mb-6">
        <ContactAvatar name={contact.displayName} email={primary} className="w-16 h-16 text-xl" />
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-semibold text-fg leading-tight">{contact.displayName}</h2>
          {(contact.jobTitle || contact.department) && (
            <p className="text-sm text-fg-subtle mt-0.5">{[contact.jobTitle, contact.department].filter(Boolean).join(' · ')}</p>
          )}
          {contact.company && <p className="text-sm text-fg-subtle">{contact.company}</p>}
          {view.categories.length > 0 && <div className="mt-2"><CategoryChips names={view.categories} /></div>}
        </div>
      </div>

      <div className="border border-line rounded-lg divide-y divide-line">
        {view.nickname && <DetailRow icon={<User size={15} />} label="Spitzname">{view.nickname}</DetailRow>}
        {view.emails.map((e) => (
          <DetailRow key={e.key} icon={<AtSign size={15} />} label={`E-Mail (${PLACE_TYPE_LABEL[e.type]})`}>
            <a href={`mailto:${e.value}`} className="text-accent-fg hover:underline">{e.value}</a>
          </DetailRow>
        ))}
        {view.phones.map((p) => (
          <DetailRow key={p.key} icon={<Phone size={15} />} label={`Telefon (${PHONE_TYPE_LABEL[p.type]})`}>
            <a href={`tel:${p.value.replace(/[^\d+]/g, '')}`} className="hover:underline">{p.value}</a>
          </DetailRow>
        ))}
        {view.addresses.map((a) => (
          <DetailRow key={a.key} icon={<MapPin size={15} />} label={`Adresse (${PLACE_TYPE_LABEL[a.type]})`}>
            <address className="not-italic">{addressLines(a).map((l, i) => <span key={i} className="block">{l}</span>)}</address>
          </DetailRow>
        ))}
        {view.urls.map((u) => (
          <DetailRow key={u.key} icon={<Globe size={15} />} label={`Webseite (${PLACE_TYPE_LABEL[u.type]})`}>
            {isWebUrl(u.value)
              ? <a href={u.value} target="_blank" rel="noopener noreferrer" className="text-accent-fg hover:underline">{u.value}</a>
              : u.value}
          </DetailRow>
        ))}
        {view.ims.map((i) => (
          <DetailRow key={i.key} icon={<MessageCircle size={15} />} label={`Chat (${PLACE_TYPE_LABEL[i.type]})`}>{i.value}</DetailRow>
        ))}
        {view.birthday && <DetailRow icon={<Cake size={15} />} label="Geburtstag">{formatGermanDate(contact.birthday)}</DetailRow>}
        {view.anniversary && <DetailRow icon={<Heart size={15} />} label="Jahrestag">{formatGermanDate(contact.anniversary)}</DetailRow>}
        {view.fileAs && <DetailRow icon={<Tag size={15} />} label="Speichern unter">{view.fileAs}</DetailRow>}
        {contact.company && (
          <DetailRow icon={<Briefcase size={15} />} label="Firma">
            {[contact.company, contact.department].filter(Boolean).join(' · ')}
          </DetailRow>
        )}
        {contact.notes && (
          <DetailRow icon={<MessageSquare size={15} />} label="Notizen">
            <p className="text-fg-muted whitespace-pre-wrap leading-relaxed">{contact.notes}</p>
          </DetailRow>
        )}
      </div>
    </div>
  );
}
