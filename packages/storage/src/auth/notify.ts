/**
 * Security notifications (v8.1): a short system mail into the user's own INBOX
 * when a credential is added to the account (e.g. an app password). Same pattern
 * as the api-gateway's internal-notify helper (direct message-store write, no
 * SMTP round trip, atomic UID/modSeq via createMessage).
 *
 * Never throws — a failed notification must not fail the protected action.
 * Test seam: setSecurityNotifier(fn) replaces the delivery (null restores it).
 */
import { randomBytes } from 'node:crypto';
import { createLogger } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import { createMessage } from '../message-store.js';
import { getProductName } from '../branding.js';

const log = createLogger('auth:notify');

export interface SecurityNotice {
  userId: string;
  subject: string;
  bodyText: string;
  /** 10.6: optional HTML body (escaped by the caller); default: the text in a <pre>. */
  bodyHtml?: string;
}

type Notifier = (n: SecurityNotice) => Promise<void>;
let override: Notifier | null = null;

/** Tests: capture notices instead of writing messages. */
export function setSecurityNotifier(fn: Notifier | null): void {
  override = fn;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function deliver(n: SecurityNotice): Promise<void> {
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: n.userId }, include: { folders: true } });
  const inbox = mailbox?.folders.find((f) => f.name === 'INBOX' || f.name === 'Inbox' || f.displayName === 'Inbox');
  if (!mailbox || !inbox) {
    log.warn({ userId: n.userId }, 'security notice dropped — no mailbox/INBOX');
    return;
  }
  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } });
  const host = settings?.publicHostname || 'localhost';
  const productName = await getProductName(); // 9.3: branded product name
  const bodyHtml = n.bodyHtml ?? `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(n.bodyText)}</pre>`;
  await prisma.$transaction((tx) => createMessage(tx, mailbox.id, inbox.id, {
    flags: [],
    subject: n.subject,
    fromAddr: `system@${host}`,
    fromName: `${productName} Security`,
    toAddrs: [],
    ccAddrs: [],
    bccAddrs: [],
    date: new Date(),
    bodyText: n.bodyText,
    bodyHtml,
    rawSize: Buffer.byteLength(`${n.subject}\n\n${n.bodyText}`, 'utf8'),
    messageId: `<${Date.now()}.${randomBytes(8).toString('hex')}@coremail.system>`,
    references: '',
  }));
  await prisma.folder.update({
    where: { id: inbox.id },
    data: { totalCount: { increment: 1 }, unreadCount: { increment: 1 } },
  }).catch(() => undefined);
}

/** Delivers a security notice to the user's INBOX (fire-and-forget safe). */
export async function notifySecurityEvent(n: SecurityNotice): Promise<void> {
  try {
    await (override ?? deliver)(n);
  } catch (err) {
    log.error({ err, userId: n.userId }, 'security notice failed');
  }
}
