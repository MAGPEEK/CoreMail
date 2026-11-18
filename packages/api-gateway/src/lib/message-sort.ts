/**
 * 9.4: sort order of message lists (`?sort=date|from|subject|size&dir=desc|asc`,
 * webmail setting "Sortierung"). Pinned messages always stay on top; ties are
 * broken by date (newest first) and id so paging is stable. Unknown values fall
 * back to the pre-9.4 order (date, newest first).
 */
export type MessageSortField = 'date' | 'from' | 'subject' | 'size';
type Dir = 'asc' | 'desc';

export type MessageOrder =
  | { pinnedAt: { sort: 'desc'; nulls: 'last' } }
  | { date: Dir } | { fromAddr: Dir } | { subject: Dir } | { rawSize: Dir }
  | { id: 'asc' };

function byField(field: MessageSortField, dir: Dir): MessageOrder {
  switch (field) {
    case 'from': return { fromAddr: dir };
    case 'subject': return { subject: dir };
    case 'size': return { rawSize: dir };
    default: return { date: dir };
  }
}

export function messageOrderBy(query: Record<string, unknown>): MessageOrder[] {
  const raw = String(query['sort'] ?? 'date');
  const field: MessageSortField = raw === 'from' || raw === 'subject' || raw === 'size' ? raw : 'date';
  const dir: Dir = query['dir'] === 'asc' ? 'asc' : 'desc';
  return [
    { pinnedAt: { sort: 'desc', nulls: 'last' } },
    byField(field, dir),
    ...(field !== 'date' ? [{ date: 'desc' } as const] : []),
    { id: 'asc' },
  ];
}
