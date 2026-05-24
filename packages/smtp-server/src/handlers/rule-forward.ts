import { randomUUID } from 'crypto';
import { createLogger } from '@coremail/core';
import { enqueueOutbound } from '../outbound/queue.js';

const log = createLogger('smtp:rule-forward');

const LOOP_HEADER = 'X-CoreMail-RuleForwarded';

/**
 * Prüft den Loop-Schutz-Header. Wenn die Mail bereits durch eine Rule
 * weitergeleitet wurde (egal welcher User), wird `true` zurückgegeben →
 * keine erneute Forward-Aktion.
 */
export function isRuleForwardedAlready(rawBuffer: Buffer): boolean {
  const headerEnd = rawBuffer.indexOf('\r\n\r\n');
  const slice = headerEnd > 0 ? rawBuffer.subarray(0, headerEnd) : rawBuffer.subarray(0, Math.min(rawBuffer.length, 16384));
  return slice.toString('utf8').toLowerCase().includes(LOOP_HEADER.toLowerCase() + ':');
}

/**
 * Hängt Header an den Buffer an (Trennung Header-Body via CRLFCRLF).
 * Wenn das Trennzeichen fehlt, wird der Header einfach am Ende angefügt.
 */
function addHeaders(rawBuffer: Buffer, extraHeaders: Record<string, string>): Buffer {
  const headerEnd = rawBuffer.indexOf('\r\n\r\n');
  const extra = Object.entries(extraHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  if (headerEnd < 0) {
    return Buffer.concat([rawBuffer, Buffer.from('\r\n' + extra + '\r\n')]);
  }
  return Buffer.concat([
    rawBuffer.subarray(0, headerEnd),
    Buffer.from('\r\n' + extra),
    rawBuffer.subarray(headerEnd),
  ]);
}

export interface RuleForwardOpts {
  rawBuffer:      Buffer;
  toAddress:      string;        // Ziel-Adresse (von der Regel)
  forwardingUser: { id: string; email: string };
  mode:           'forward' | 'redirect';
  originalFrom:   string;        // From: der Original-Mail (für Envelope bei redirect)
}

/**
 * Reicht eine ausgehende Forward/Redirect-Mail an die SMTP-Outbound-Queue weiter.
 *
 * - `forward`: User wird zum Absender (Resent-From/Resent-To Header),
 *   Envelope-From = User-Mail. Empfänger sieht „weitergeleitet von User".
 * - `redirect`: Original-Header bleiben unangetastet, Envelope-From = Original-Sender.
 *   Empfänger sieht die Mail so als käme sie direkt vom Original-Absender.
 *
 * In beiden Fällen wird der Loop-Schutz-Header gesetzt.
 */
export async function enqueueRuleForward(opts: RuleForwardOpts): Promise<void> {
  if (isRuleForwardedAlready(opts.rawBuffer)) {
    log.warn(
      { userId: opts.forwardingUser.id, to: opts.toAddress },
      'Loop-Schutz: Mail wurde bereits durch eine Rule weitergeleitet — überspringe',
    );
    return;
  }

  const extra: Record<string, string> = {
    [LOOP_HEADER]: opts.forwardingUser.id,
  };

  if (opts.mode === 'forward') {
    extra['Resent-From'] = `<${opts.forwardingUser.email}>`;
    extra['Resent-To']   = `<${opts.toAddress}>`;
    extra['Resent-Date'] = new Date().toUTCString();
    extra['Resent-Message-ID'] = `<${randomUUID()}@${opts.forwardingUser.email.split('@')[1] ?? 'localhost'}>`;
  }

  const augmented = addHeaders(opts.rawBuffer, extra);

  // Für `redirect`: Envelope-From bleibt = Original-Sender, damit Bounce zum
  // Ursprungs-Absender geht. Für `forward`: User übernimmt die Verantwortung.
  const envelopeFrom = opts.mode === 'redirect' ? opts.originalFrom : opts.forwardingUser.email;

  await enqueueOutbound({
    messageId:  randomUUID(),
    from:       envelopeFrom,
    to:         [opts.toAddress],
    rawMessage: augmented.toString('base64'),
    senderUserId: opts.forwardingUser.id,
  });

  log.info(
    { userId: opts.forwardingUser.id, to: opts.toAddress, mode: opts.mode },
    'Rule-Forward eingereiht',
  );
}
