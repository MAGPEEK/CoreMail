/**
 * SMTP Submission Server — Ports 465 (SMTPS) und 587 (STARTTLS)
 *
 * Unterschied zum Inbound-Server (Port 25):
 *  - AUTH ist Pflicht (authRequired: true)
 *  - onAuth prüft Passwort gegen User.passwordHash (bcrypt + pepper) ODER AppPassword
 *  - onMailFrom erzwingt, dass FROM-Adresse mit dem authentifizierten User übereinstimmt
 *  - Kein Security-Filter-Roundtrip für Verbindungsprüfung (der User ist bereits authentifiziert)
 *  - Ausgehende Mail wird über die Outbound-Queue zugestellt (lokale Empfänger direkt, externe per Relay)
 */

import tls from 'node:tls';
import fs  from 'node:fs';
import {
  SMTPServer,
  type SMTPServerSession,
  type SMTPServerDataStream,
  type SMTPServerAuthentication,
} from 'smtp-server';
import { createLogger, verifyPassword } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { storeInboundMessage } from '../handlers/message.js';
import { enqueueOutbound } from '../outbound/queue.js';

const log = createLogger('smtp:submission');

const SMTP_HOSTNAME = process.env['SMTP_HOSTNAME'] ?? 'mail.localhost';
const TLS_CERT      = process.env['TLS_CERT_PATH'];
const TLS_KEY       = process.env['TLS_KEY_PATH'];

// ── Session-Metadaten ────────────────────────────────────────────────────────

interface SubmissionSession {
  senderIp:        string;
  authenticatedId: string;   // User.id
  authenticatedEmail: string; // User.email (normalisiert)
  mailFrom:        string;
  rcptTo:          string[];
}

const sessionMeta = new Map<string, SubmissionSession>();

// ── Server-Factory ────────────────────────────────────────────────────────────

export function createSubmissionServer(implicitTls = false): SMTPServer {
  const tlsOptions: tls.TlsOptions | undefined =
    implicitTls && TLS_CERT && TLS_KEY
      ? {
          cert:       fs.readFileSync(TLS_CERT),
          key:        fs.readFileSync(TLS_KEY),
          minVersion: 'TLSv1.2',
        }
      : undefined;

  const server = new SMTPServer({
    name:   SMTP_HOSTNAME,
    banner: `${SMTP_HOSTNAME} CoreMail ESMTP`,

    // TLS
    secure:  implicitTls,              // true → Port 465 (SMTPS), false → STARTTLS auf 587
    ...(tlsOptions ? { key: tlsOptions.key, cert: tlsOptions.cert } : {}),

    // authOptional ist NICHT gesetzt → Auth ist Pflicht (smtp-server-Default wenn onAuth vorhanden)
    allowInsecureAuth: true,          // auch ohne TLS (z. B. lokale Tests); in Prod per Reverse-Proxy gesichert

    logger: false,
    size:   52428800, // 50 MB

    // ── AUTHENTICATE ─────────────────────────────────────────────────────────
    async onAuth(
      auth: SMTPServerAuthentication,
      _session: SMTPServerSession,
      callback,
    ) {
      const username = (auth.username ?? '').toLowerCase().trim();
      const password = auth.password ?? '';

      if (!username || !password) {
        return callback(new Error('535 5.7.8 Authentication credentials invalid'));
      }

      try {
        const user = await prisma.user.findFirst({
          where: { email: username, active: true },
          select: { id: true, email: true, passwordHash: true },
        });

        if (!user) {
          log.warn({ username }, 'SMTP submission auth failed: user not found');
          return callback(new Error('535 5.7.8 Authentication credentials invalid'));
        }

        // 1. Reguläres Passwort (bcrypt + pepper)
        let authenticated = false;
        if (user.passwordHash) {
          authenticated = await verifyPassword(password, user.passwordHash);
        }

        // 2. App-Passwort (für Clients ohne MFA-Unterstützung)
        if (!authenticated) {
          const appPasswords = await prisma.appPassword.findMany({
            where: { userId: user.id },
          });
          for (const ap of appPasswords) {
            if (await verifyPassword(password, ap.hash)) {
              authenticated = true;
              await prisma.appPassword.update({
                where: { id: ap.id },
                data:  { lastUsedAt: new Date() },
              });
              break;
            }
          }
        }

        if (!authenticated) {
          log.warn({ email: username }, 'SMTP submission auth failed: wrong password');
          return callback(new Error('535 5.7.8 Authentication credentials invalid'));
        }

        log.info({ email: user.email }, 'SMTP submission auth success');
        callback(null, { user: { id: user.id, email: user.email } });
      } catch (err) {
        log.error({ err }, 'SMTP submission onAuth error');
        callback(new Error('451 4.3.0 Temporary authentication failure'));
      }
    },

    // ── CONNECT ───────────────────────────────────────────────────────────────
    onConnect(session, callback) {
      // sessionMeta wird erst nach erfolgreicher AUTH angelegt (onMailFrom)
      log.debug({ ip: session.remoteAddress }, 'Submission connect');
      callback();
    },

    // ── MAIL FROM ─────────────────────────────────────────────────────────────
    onMailFrom(address, session, callback) {
      const authedUser = session.user as { id: string; email: string } | undefined;
      if (!authedUser) {
        return callback(new Error('530 5.7.0 Authentication required'));
      }

      const fromAddr = address.address.toLowerCase();

      // Anti-Spoofing: FROM muss mit authentifiziertem User übereinstimmen
      // (Exception: Nutzer mit shared-Mailbox-Berechtigung — prüfen wir asynchron)
      checkSenderPermission(authedUser.id, fromAddr)
        .then((allowed) => {
          if (!allowed) {
            log.warn({ authed: authedUser.email, from: fromAddr }, 'SMTP submission: sender not allowed');
            return callback(new Error('550 5.7.1 Sender address not allowed for authenticated user'));
          }
          sessionMeta.set(session.id, {
            senderIp:           session.remoteAddress,
            authenticatedId:    authedUser.id,
            authenticatedEmail: authedUser.email,
            mailFrom:           fromAddr,
            rcptTo:             [],
          });
          callback();
        })
        .catch((err) => {
          log.error({ err }, 'checkSenderPermission error');
          callback(new Error('451 4.3.0 Temporary failure'));
        });
    },

    // ── RCPT TO ───────────────────────────────────────────────────────────────
    onRcptTo(address, session, callback) {
      const meta = sessionMeta.get(session.id);
      if (meta) meta.rcptTo.push(address.address.toLowerCase());
      // Submission akzeptiert alle Empfänger (Relay-Check erfolgt in der Queue)
      callback();
    },

    // ── DATA ──────────────────────────────────────────────────────────────────
    onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback) {
      const meta = sessionMeta.get(session.id);
      if (!meta) {
        stream.resume();
        return callback(new Error('503 5.5.1 Bad sequence of commands'));
      }

      const chunks: Buffer[] = [];
      stream.on('data',  (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', (err: Error) => {
        log.error({ err }, 'Submission stream error');
        callback(err);
      });
      stream.on('end', () => {
        const rawMessage = Buffer.concat(chunks);
        log.debug({ from: meta.mailFrom, rcpt: meta.rcptTo, size: rawMessage.length }, 'Submission message received');

        processSubmission(rawMessage, meta)
          .then(() => callback())
          .catch((err) => {
            log.error({ err }, 'Submission processing error');
            callback(new Error('451 4.3.0 Temporary failure, please retry'));
          });
      });
    },

    onClose(session) {
      sessionMeta.delete(session.id);
    },
  });

  return server;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

/**
 * Prüft ob der authentifizierte User (userId) berechtigt ist, als fromAddr zu senden.
 * Erlaubt:
 *  - eigene E-Mail-Adresse
 *  - Shared Mailboxes für die der User Sende-Berechtigung hat
 */
async function checkSenderPermission(userId: string, fromAddr: string): Promise<boolean> {
  // Eigene Adresse
  const user = await prisma.user.findFirst({
    where: { id: userId, email: fromAddr, active: true },
    select: { id: true },
  });
  if (user) return true;

  // Shared-Mailbox-Berechtigung
  const sharedPerm = await prisma.sharedMailboxPerm.findFirst({
    where: {
      userId,
      permission: { in: ['FULL_ACCESS', 'SEND_AS'] },
      sharedMailbox: { email: fromAddr, active: true },
    },
  });
  return !!sharedPerm;
}

/**
 * Verarbeitet eine vom Submission-Server empfangene Mail:
 *  - Lokale Empfänger → direkt in Mailbox speichern
 *  - Externe Empfänger → Outbound-Queue
 */
async function processSubmission(rawMessage: Buffer, meta: SubmissionSession): Promise<void> {
  const localRcpts:    string[] = [];
  const externalRcpts: string[] = [];

  for (const rcpt of meta.rcptTo) {
    const [, domain] = rcpt.split('@');
    if (!domain) continue;

    const localDomain = await prisma.domain.findFirst({
      where: { name: domain.toLowerCase(), active: true },
    });

    if (localDomain) {
      localRcpts.push(rcpt);
    } else {
      externalRcpts.push(rcpt);
    }
  }

  // Lokale Zustellung
  for (const rcpt of localRcpts) {
    await storeInboundMessage(rawMessage, {
      fromAddr: meta.mailFrom,
      rcptTo:   rcpt,
      toJunk:   false,
    });
  }

  // Externe Zustellung via Outbound-Queue
  if (externalRcpts.length > 0) {
    await enqueueOutbound({
      messageId:    crypto.randomUUID(),
      from:         meta.mailFrom,
      to:           externalRcpts,
      rawMessage:   rawMessage.toString('base64'),
      senderUserId: meta.authenticatedId,
    });
  }

  log.info(
    { from: meta.mailFrom, local: localRcpts.length, external: externalRcpts.length },
    'Submission processed',
  );
}
