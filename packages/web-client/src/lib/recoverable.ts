/**
 * Recover deleted items (v8.1, 9.1 for shared mailboxes) — which API the panel
 * talks to. No imports — unit-tested with `node --test`.
 *
 *   own mailbox      → /mail/recoverable
 *   shared mailbox   → /user/shared-mailboxes/:id/recoverable   (FULL_ACCESS)
 */
export type RecoverTarget = { kind: 'own' } | { kind: 'shared'; id: string };

/** API base path (relative to /api/v1); restore/purge append /restore, /purge. */
export function recoverableApiBase(target: RecoverTarget = { kind: 'own' }): string {
  return target.kind === 'shared'
    ? `/user/shared-mailboxes/${encodeURIComponent(target.id)}/recoverable`
    : '/mail/recoverable';
}

/** TanStack Query key of the list (separate per mailbox). */
export function recoverableQueryKey(target: RecoverTarget = { kind: 'own' }): readonly unknown[] {
  return target.kind === 'shared' ? ['recoverable', 'shared', target.id] : ['recoverable'];
}

/** May the user recover items of a shared mailbox? (FULL_ACCESS — the API enforces it too.) */
export function canRecoverShared(permissions: readonly string[]): boolean {
  return permissions.includes('FULL_ACCESS');
}
