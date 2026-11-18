/**
 * 9.3: the mailbox the mail view currently shows (own / shared / delegated) with its
 * API base, folder query key and whether write actions are allowed.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
import { useWebmailFeatures } from './useWebmailFeatures.js';
import {
  mailApiBase, mailboxKey, foldersQueryKey, isForeign, isReadOnlyMailbox, findMailboxEntry,
  type AccessibleMailboxEntry, type MailboxRef,
} from '../lib/mailboxContext.js';

export const ACCESSIBLE_MAILBOXES_KEY = ['accessible-mailboxes'] as const;

/** Shared + delegated mailboxes the user may read (GET /user/accessible-mailboxes). */
export function useAccessibleMailboxes() {
  // 9.4: none while the shared-mailbox module is off (webmail policy)
  const enabled = useWebmailFeatures().features.sharedMailboxes;
  return useQuery({
    queryKey: ACCESSIBLE_MAILBOXES_KEY,
    queryFn: () => api.get<AccessibleMailboxEntry[]>('/user/accessible-mailboxes'),
    staleTime: 60_000,
    enabled,
  });
}

export interface MailboxContext {
  ref: MailboxRef;
  key: string;
  base: string;
  foldersKey: readonly unknown[];
  foreign: boolean;
  readOnly: boolean;
  entry: AccessibleMailboxEntry | undefined;
}

/** Context of any mailbox (folder pane sections render several at once). */
export function useMailboxContext(ref: MailboxRef): MailboxContext {
  const { data } = useAccessibleMailboxes();
  const key = mailboxKey(ref);
  return useMemo(() => ({
    ref,
    key,
    base: mailApiBase(ref),
    foldersKey: foldersQueryKey(ref),
    foreign: isForeign(ref),
    readOnly: isReadOnlyMailbox(ref, data),
    entry: findMailboxEntry(ref, data),
  // ref is identified by its key
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [key, data]);
}

/** Context of the mailbox shown in the mail view. */
export function useActiveMailbox(): MailboxContext {
  return useMailboxContext(useUiStore((s) => s.activeMailbox));
}
