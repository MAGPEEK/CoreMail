/**
 * What the loaded message lists know about the command targets (flags, pin,
 * categories) — live with the query cache, so labels such as "Kennzeichnen" /
 * "Kennzeichnung aufheben" follow every refetch.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type { Message, MessagesResponse, MessageSummary } from '../api/types.js';

export interface TargetMessage {
  id: string;
  flags: string[];
  pinnedAt: string | null;
  categoryIds: string[];
}

function toTarget(m: MessageSummary): TargetMessage {
  return { id: m.id, flags: m.flags, pinnedAt: m.pinnedAt ?? null, categoryIds: (m.categories ?? []).map((c) => c.id) };
}

/** Targets found in the cached folder pages / search results, else the open message. */
function lookup(qc: QueryClient, ids: readonly string[]): TargetMessage[] {
  // Runs on every query-cache event: nothing to act on → no scan of the cached lists
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const found = new Map<string, TargetMessage>();
  for (const [, data] of qc.getQueriesData<InfiniteData<MessagesResponse>>({ queryKey: ['messages'] })) {
    for (const page of data?.pages ?? []) {
      for (const m of page.messages ?? []) {
        if (wanted.has(m.id) && !found.has(m.id)) found.set(m.id, toTarget(m));
      }
    }
    if (found.size === wanted.size) break;
  }
  for (const id of ids) {
    if (found.has(id)) continue;
    const open = qc.getQueryData<Message>(['message', id]);
    if (open) found.set(id, toTarget(open));
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

export function useTargetMessages(ids: readonly string[]): TargetMessage[] {
  const qc = useQueryClient();
  const subscribe = useCallback((onChange: () => void) => qc.getQueryCache().subscribe(onChange), [qc]);
  // A string snapshot: stable between cache events that do not change the targets
  const snapshot = useSyncExternalStore(subscribe, () => JSON.stringify(lookup(qc, ids)));
  return useMemo(() => JSON.parse(snapshot) as TargetMessage[], [snapshot]);
}
