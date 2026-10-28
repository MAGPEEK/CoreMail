/**
 * DSN (Delivery Status Notification, RFC 3464) — bounce generator.
 *
 * When a mail could not be delivered after all retries are exhausted (or on an
 * immediate 5xx), the mail server sends a standardized bounce mail back to
 * MAIL FROM. Without DSN, senders would never learn that their mail did not
 * arrive — the gold standard for every RFC-compliant MTA.
 */

import { storeInboundMessage } from '../handlers/message.js';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('smtp:dsn');

/**
 * Heuristic: given an error string (e.g. nodemailer exception), extract
 * the SMTP reply code if present, otherwise null.
 */
export function extractSmtpCode(err: unknown): { code: number | null; isPermanent: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  // Look for a 3-digit SMTP code (common patterns):
  //   "550 5.1.1 User unknown"
  //   "421 4.7.0 Try again later"
  //   "smtp: 553 sorry, ..."
  const m = /\b([2-5])(\d{2})\b/.exec(msg);
  if (!m) return { code: null, isPermanent: false };
  const code = parseInt(m[0]!, 10);
  // 5xx = permanent (RFC 5321 §4.2.1)
  // 4xx = transient (try again)
  // 2xx = success (should not occur here)
  const isPermanent = code >= 500 && code < 600;
  return { code, isPermanent };
}

/**
 * Generates an RFC 3464-compliant bounce mail and delivers it locally via
 * storeInboundMessage() to MAIL FROM (if local) or discards it
 * (if external — otherwise bounce loops would be possible; external senders
 * usually get the info from the MX server via synchronous reject anyway).
 *
 * If MAIL FROM is empty (= already a bounce mail!) → null sender, do not
 * generate a new bounce (RFC 5321 §6.1, "double-bounce prevention").
 */
export async function sendDsnBounce(opts: {
  originalFrom:     string;
  originalTo:       string[];
  originalSubject:  string;
  originalMessageId: string | null;
  failureReason:    string;
  smtpCode:         number | null;
  serverHostname:   string;
}): Promise<void> {
  // RFC 5321 §6.1: no bounce for empty MAIL FROM (= "<>" bounce mail itself)
  if (!opts.originalFrom || opts.originalFrom === '<>') {
    log.info({ originalTo: opts.originalTo }, 'DSN unterdrückt: leere MAIL FROM (double-bounce-Schutz)');
    return;
  }

  // Only to local recipients → for external ones the MX bounce is more reliable
  const [, domain] = opts.originalFrom.toLowerCase().split('@');
  if (!domain) return;
  const localDomain = await prisma.domain.findFirst({
    where: { name: domain, active: true },
    select: { id: true },
  });
  if (!localDomain) {
    log.info({ to: opts.originalFrom }, 'DSN unterdrückt: externer Absender (MX-Server liefert eigenes Bounce)');
    return;
  }

  const date = new Date().toUTCString();
  const dsnMessageId = `<dsn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${opts.serverHostname}>`;
  const codeLine = opts.smtpCode ? `${opts.smtpCode}` : 'unbekannt';
  const recipients = opts.originalTo.join(', ');

  // multipart/report format (RFC 3464)
  const boundary = `dsn-boundary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const subject = `Unzustellbar: ${opts.originalSubject || '(kein Betreff)'}`;
  const refsLine = opts.originalMessageId ? `References: ${opts.originalMessageId}\r\nIn-Reply-To: ${opts.originalMessageId}\r\n` : '';

  const humanReadable =
`Ihre Nachricht konnte nicht zugestellt werden.

  Empfänger:        ${recipients}
  Fehlercode:       ${codeLine}
  Fehlermeldung:    ${opts.failureReason}
  Zeitpunkt:        ${date}

Diese Nachricht wurde nach mehreren erfolglosen Zustellversuchen vom Mailserver
${opts.serverHostname} automatisch generiert. Bitte kontaktieren Sie den
Empfänger über einen alternativen Weg oder versuchen Sie die Adresse zu prüfen.

— CoreMail Mail Delivery System
`;

  const reportPart =
`Reporting-MTA: dns; ${opts.serverHostname}
${opts.originalMessageId ? `Original-Message-ID: ${opts.originalMessageId}` : ''}
Arrival-Date: ${date}

${opts.originalTo.map((rcpt) => `Final-Recipient: rfc822; ${rcpt}
Action: failed
Status: ${opts.smtpCode ? `${Math.floor(opts.smtpCode / 100)}.${Math.floor((opts.smtpCode % 100) / 10)}.${opts.smtpCode % 10}` : '5.0.0'}
${opts.smtpCode ? `Diagnostic-Code: smtp; ${opts.smtpCode} ${opts.failureReason}` : `Diagnostic-Code: ${opts.failureReason}`}`).join('\n\n')}
`;

  const raw =
`From: Mail Delivery System <MAILER-DAEMON@${opts.serverHostname}>
To: ${opts.originalFrom}
Subject: ${subject}
Date: ${date}
Message-ID: ${dsnMessageId}
${refsLine}MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"
Auto-Submitted: auto-replied

--${boundary}
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

${humanReadable}
--${boundary}
Content-Type: message/delivery-status

${reportPart}
--${boundary}--
`;

  try {
    await storeInboundMessage(Buffer.from(raw, 'utf8'), {
      fromAddr: '',     // null sender for bounce (RFC 5321)
      rcptTo:   opts.originalFrom,
      toJunk:   false,
    });
    log.info(
      { to: opts.originalFrom, code: opts.smtpCode, originalMessageId: opts.originalMessageId },
      'DSN-Bounce zugestellt',
    );
  } catch (err) {
    log.error({ err, to: opts.originalFrom }, 'DSN-Bounce-Zustellung fehlgeschlagen');
  }
}
