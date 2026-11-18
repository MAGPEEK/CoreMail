/**
 * "Von" of a compose (9.3): inside a shared mailbox the user may send as / on
 * behalf of it (the shared identity is the default); the server re-checks the
 * permission on save and send. A reopened draft's sender is offered even when
 * it is not in the list any more. 9.4: the signature defaults follow the identity.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { useAccessibleMailboxes } from './useActiveMailbox.js';
import {
  findMailboxEntry, senderKey, senderOptions, type MailboxRef, type SenderOption,
} from '../lib/mailboxContext.js';
import { signatureIdentity } from '../lib/signaturePick.js';

export interface ComposeSender {
  choices: SenderOption[];
  selected: SenderOption | undefined;
  fromKey: string | null;
  setFromKey: (key: string | null) => void;
  draftSender: SenderOption | undefined;
  setDraftSender: (s: SenderOption | undefined) => void;
  /** Identity of the signature defaults ('own' / 'shared:<id>'). */
  signatureKey: string;
  /** Own address + the mailbox composed in (left out of reply-all lists). */
  ownAddresses: string[];
  ownEmail: string;
  /** The mailbox list is needed (shared mailbox) and not loaded yet. */
  pending: boolean;
}

export function useComposeSender(mailbox: MailboxRef, initial: { fromKey?: string | null; draftSender?: SenderOption | undefined } = {}): ComposeSender {
  // after a reload (or in an own compose window) the store has no profile yet
  const storeEmail = useAuthStore((s) => s.email);
  const { data: profile } = useQuery({
    queryKey: ['user', 'profile'],
    queryFn: () => api.get<{ email: string }>('/user/profile'),
    enabled: !storeEmail,
    staleTime: 5 * 60_000,
  });
  const ownEmail = storeEmail ?? profile?.email ?? '';
  const { data: accessible } = useAccessibleMailboxes();
  const [draftSender, setDraftSender] = useState<SenderOption | undefined>(initial.draftSender);
  const [fromKey, setFromKey] = useState<string | null>(initial.fromKey ?? null);
  const entry = findMailboxEntry(mailbox, accessible);
  const choices = senderOptions(ownEmail, entry);
  if (draftSender && !choices.some((o) => senderKey(o) === senderKey(draftSender))) choices.unshift(draftSender);
  const selected = choices.find((o) => senderKey(o) === fromKey) ?? choices[0];
  return {
    choices,
    selected,
    fromKey,
    setFromKey,
    draftSender,
    setDraftSender,
    signatureKey: signatureIdentity(mailbox, !!selected && selected.mode !== 'self'),
    ownAddresses: [ownEmail, ...(entry?.email ? [entry.email] : [])],
    ownEmail,
    pending: mailbox.kind !== 'own' && !accessible,
  };
}
