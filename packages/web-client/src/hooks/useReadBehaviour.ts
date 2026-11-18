/**
 * 9.4: reader behaviour from Settings → Lesen (lib/readBehaviour.ts).
 *  - useAutoMarkRead: marks the opened message read immediately / after N
 *    seconds / never (the reader loads it with ?markRead=false).
 *  - useReadReceipt: answers a read-receipt request automatically ("immer") or
 *    exposes send/ignore for the banner ("fragen").
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { Message } from '../api/types.js';
import { usePreferences } from '../store/preferences.js';
import { autoReadDelayMs, receiptAction, type ReceiptAction } from '../lib/readBehaviour.js';

const SEEN = '\\Seen';

export function useAutoMarkRead(msg: Message | undefined, base: string, readOnly: boolean): void {
  const qc = useQueryClient();
  const { markRead, markReadDelaySec } = usePreferences((s) => s.prefs.reading);
  const id = msg?.id;
  const seen = msg?.flags.includes(SEEN) ?? true;
  useEffect(() => {
    if (!id) return;
    const delay = autoReadDelayMs(markRead, markReadDelaySec, seen, readOnly);
    if (delay === null) return;
    const timer = setTimeout(() => {
      api.patch(`${base}/messages/${id}`, { read: true })
        .then(() => {
          qc.setQueryData<Message>(['message', id], (m) => (m ? { ...m, flags: [...new Set([...m.flags, SEEN])] } : m));
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['folders'] });
        })
        .catch(() => undefined); // stays unread; the user can mark it manually
    }, delay);
    return () => clearTimeout(timer);
  }, [id, seen, markRead, markReadDelaySec, readOnly, base, qc]);
}

export interface ReadReceiptState {
  action: ReceiptAction;
  send: () => void;
  ignore: () => void;
  pending: boolean;
}

export function useReadReceipt(msg: Message | undefined, opts: { ownMailbox: boolean; inJunk: boolean }): ReadReceiptState {
  const qc = useQueryClient();
  const policy = usePreferences((s) => s.prefs.reading.answerReceipts);
  const action = msg
    ? receiptAction(policy, {
      requestedBy: msg.dispositionNotificationTo, flags: msg.flags,
      ownMailbox: opts.ownMailbox, inJunk: opts.inJunk, fromAddr: msg.fromAddr,
    })
    : 'none';
  const answer = useMutation({
    mutationFn: (body: { action: 'send' | 'ignore'; mode: 'manual' | 'automatic' }) =>
      api.post(`/mail/messages/${msg?.id ?? ''}/receipt`, body),
    onSettled: () => { if (msg) void qc.invalidateQueries({ queryKey: ['message', msg.id] }); },
  });
  const autoSent = useRef<string | null>(null);
  useEffect(() => {
    if (action !== 'sendAutomatically' || !msg || autoSent.current === msg.id) return;
    autoSent.current = msg.id;
    answer.mutate({ action: 'send', mode: 'automatic' });
  }, [action, msg, answer]);
  return {
    action,
    send: () => answer.mutate({ action: 'send', mode: 'manual' }),
    ignore: () => answer.mutate({ action: 'ignore', mode: 'manual' }),
    pending: answer.isPending,
  };
}
