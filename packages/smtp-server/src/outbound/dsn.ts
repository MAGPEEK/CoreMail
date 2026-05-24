/**
 * DSN (Delivery Status Notification, RFC 3464) — Bounce-Generator.
 *
 * Wenn eine Mail nach Erschöpfung aller Retries (oder bei sofortigem 5xx) nicht
 * zugestellt werden konnte, sendet der Mailserver eine standardisierte Bounce-Mail
 * an MAIL FROM zurück. Ohne DSN würden Absender nie erfahren dass ihre Mail
 * nicht angekommen ist — Gold-Standard bei jedem RFC-konformen MTA.
 */

import { storeInboundMessage } from '../handlers/message.js';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('smtp:dsn');

/**
 * Heuristik: gegeben einen Fehler-String (z.B. nodemailer-Exception), extrahiere
 * den SMTP-Reply-Code falls vorhanden, sonst null.
 */
export function extractSmtpCode(err: unknown): { code: number | null; isPermanent: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  // Suche nach 3-stelligem SMTP-Code (häufige Patterns):
  //   "550 5.1.1 User unknown"
  //   "421 4.7.0 Try again later"
  //   "smtp: 553 sorry, ..."
  const m = /\b([2-5])(\d{2})\b/.exec(msg);
  if (!m) return { code: null, isPermanent: false };
  const code = parseInt(m[0]!, 10);
  // 5xx = permanent (RFC 5321 §4.2.1)
  // 4xx = transient (try again)
  // 2xx = success (sollte hier nicht vorkommen)
  const isPermanent = code >= 500 && code < 600;
  return { code, isPermanent };
}

/**
 * Generiert eine RFC-3464-konforme Bounce-Mail und stellt sie via
 * storeInboundMessage() lokal an MAIL FROM zu (wenn lokal) oder verwirft sie
 * (wenn extern — sonst wären Bounce-Schleifen möglich; externe Sender bekommen
 * die Info ohnehin oft schon vom MX-Server via Sync-Reject).
 *
 * Wenn MAIL FROM leer ist (= bereits eine Bounce-Mail!) → null-sender, keine
 * neue Bounce generieren (RFC 5321 §6.1, „double-bounce prevention").
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
  // RFC 5321 §6.1: keine Bounce für leere MAIL FROM (= "<>" Bounce-Mail selbst)
  if (!opts.originalFrom || opts.originalFrom === '<>') {
    log.info({ originalTo: opts.originalTo }, 'DSN unterdrückt: leere MAIL FROM (double-bounce-Schutz)');
    return;
  }

  // Nur an lokale Empfänger → für externe ist der MX-Bounce zuverlässiger
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

  // Multipart/report-Format (RFC 3464)
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
      fromAddr: '',     // null-sender für Bounce (RFC 5321)
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
