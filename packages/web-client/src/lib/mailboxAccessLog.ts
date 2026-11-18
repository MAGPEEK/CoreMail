/**
 * 9.4 Settings → Sicherheit: who accessed my mailbox (GET /user/mailbox-access-log).
 * German labels for the actions and clients of the mailbox access audit. Pure, unit-tested.
 */
export interface MailboxAccessEntry {
  id: string;
  at: string;
  actor: string;
  /** Action without the "mailbox.foreign." prefix, e.g. "open", "message.delete". */
  action: string;
  source: string | null;
  count?: number;
  folder?: string;
}

const ACTIONS: Record<string, string> = {
  open: 'Postfach geöffnet',
  send_as: 'Gesendet als',
  send_on_behalf: 'Gesendet im Auftrag',
  'message.move': 'Nachrichten verschoben',
  'message.delete': 'Nachrichten gelöscht',
  'folder.create': 'Ordner erstellt',
  'folder.update': 'Ordner geändert',
  'folder.delete': 'Ordner gelöscht',
  'folder.empty': 'Ordner geleert',
};

const SOURCES: Record<string, string> = {
  webmail: 'Webmail', imap: 'IMAP', jmap: 'JMAP', activesync: 'Mobilgerät (ActiveSync)', smtp: 'Mailprogramm (SMTP)',
};

/** "Nachrichten gelöscht (3) · INBOX" — the action with count and folder when known. */
export function accessActionLabel(e: Pick<MailboxAccessEntry, 'action' | 'count' | 'folder'>): string {
  const base = ACTIONS[e.action] ?? e.action;
  const count = typeof e.count === 'number' ? ` (${e.count})` : '';
  const folder = e.folder ? ` · ${e.folder}` : '';
  return `${base}${count}${folder}`;
}

export function accessSourceLabel(source: string | null): string {
  return source ? (SOURCES[source] ?? source) : '—';
}
