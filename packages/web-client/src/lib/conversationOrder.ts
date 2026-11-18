/**
 * 9.4: message-list order. The server sorts (date/from/subject/size, see
 * api-gateway lib/message-sort.ts); with "group by conversation" on, messages
 * with the same conversation subject are listed together — the conversation at
 * the position of its first message in the server order, its messages newest
 * or oldest first (Settings → Ansicht). No imports — unit-tested.
 */
export type ConversationOrder = 'newestFirst' | 'oldestFirst';

/** Subject without reply/forward prefixes — identifies a conversation (also n/p keys). */
export function conversationKey(subject: string): string {
  return subject.replace(/^\s*((re|aw|fwd?|wg|tr|rv|r)\s*(\[\d+\])?\s*:\s*)+/i, '').trim().toLowerCase();
}

export function sortParams(sortBy: string, sortDir: string): string {
  return `sort=${encodeURIComponent(sortBy)}&dir=${sortDir === 'asc' ? 'asc' : 'desc'}`;
}

export function orderForDisplay<T extends { subject: string; date: string }>(
  messages: readonly T[], group: boolean, order: ConversationOrder,
): T[] {
  if (!group) return [...messages];
  const groups = new Map<string, T[]>();
  for (const m of messages) {
    const key = conversationKey(m.subject) || `\u0000${groups.size}`;
    const list = groups.get(key);
    if (list) list.push(m); else groups.set(key, [m]);
  }
  const sign = order === 'newestFirst' ? -1 : 1;
  const out: T[] = [];
  for (const list of groups.values()) {
    out.push(...[...list].sort((a, b) => sign * (Date.parse(a.date) - Date.parse(b.date))));
  }
  return out;
}
