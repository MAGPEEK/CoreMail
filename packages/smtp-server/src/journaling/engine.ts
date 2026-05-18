/**
 * Journaling Engine — Phase 9 / Exchange-2019-konform.
 *
 * Pipeline (analog Exchange Transport Agent):
 *   1. journalMessage() wird im SMTP-Pfad nach jeder Inbound-Zustellung
 *      und vor jedem Outbound-Relay aufgerufen (siehe handlers/message.ts
 *      und outbound/queue.ts).
 *   2. Aktive Journalregeln (DB) werden auf Direction- und Recipient-
 *      Filter geprüft.
 *   3. Bei Match: RFC-3462-Report wird erzeugt (multipart/report):
 *        Teil 1 — Human-readable Summary mit Envelope-Metadaten +
 *                 BCC-Auflösung (envelope-only Empfänger sind BCC).
 *        Teil 2 — message/delivery-status mit Original-Envelope-From/-To
 *                 + Journal-Direction + Timestamp + Reporting-MTA.
 *        Teil 3 — Original-Mail als `.eml`-Datei (Content-Disposition:
 *                 attachment; filename="original.eml").
 *   4. Zustellung per SMTP an den Sink. Bei Fehler:
 *        a) Retry mit Backoff (Settings.maxRetries × initialDelay × 2^n)
 *        b) Bei finalem Fehlschlag → Versuch über alternativeJournalAddress
 *        c) Auch das gescheitert → JournalingFailure-Eintrag (PENDING/
 *           ABANDONED). Bei `holdOnFailure=true` wird ein Error zurück-
 *           geworfen, der den Mailfluss stoppt (Submission-Queue-Hold).
 *   5. Pending Failures werden alle 60 s vom Retry-Loop bearbeitet.
 *
 * Wichtig: Die Engine soll Mailflow nur stoppen, wenn der Admin
 * `holdOnFailure=true` explizit setzt. Defaults blockieren NICHT.
 */

import nodemailer from 'nodemailer';
import { prisma } from '@coremail/storage/prisma';
import { uploadBuffer, downloadBuffer } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('smtp:journaling');

const SMTP_HOSTNAME  = process.env['SMTP_HOSTNAME']  ?? 'mail.localhost';
const RELAY_HOST     = process.env['SMTP_RELAY_HOST'] ?? 'localhost';
const RELAY_PORT     = parseInt(process.env['SMTP_RELAY_PORT'] ?? '25', 10);

export type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'INTERNAL';

export interface JournalMessageOptions {
  rawMessage: Buffer;
  /** Envelope-Sender (MAIL FROM). */
  from: string;
  /** Envelope-Empfänger (RCPT TO) — inklusive BCC und expandierten Listen-Mitgliedern. */
  to: string[];
  direction: MessageDirection;
}

class JournalingHoldError extends Error {
  constructor(public readonly reportSize: number) {
    super(`Journaling sink unreachable — mailflow held (holdOnFailure=true). Report ${reportSize} B queued.`);
    this.name = 'JournalingHoldError';
  }
}

// ── Einstellungs-Cache ───────────────────────────────────────────────────────
// Wird alle 60s neu geladen — kein DB-Hit pro Mail.

interface CachedSettings {
  alternativeJournalAddress: string | null;
  holdOnFailure:             boolean;
  maxRetries:                number;
  initialRetryDelaySec:      number;
  loadedAt:                  number;
}

let settingsCache: CachedSettings | null = null;
const SETTINGS_TTL_MS = 60_000;

async function getSettings(): Promise<CachedSettings> {
  if (settingsCache && Date.now() - settingsCache.loadedAt < SETTINGS_TTL_MS) {
    return settingsCache;
  }
  const row = await prisma.journalingSettings.findUnique({ where: { id: 'singleton' } });
  settingsCache = {
    alternativeJournalAddress: row?.alternativeJournalAddress ?? null,
    holdOnFailure:             row?.holdOnFailure ?? false,
    maxRetries:                row?.maxRetries ?? 3,
    initialRetryDelaySec:      row?.initialRetryDelaySec ?? 30,
    loadedAt:                  Date.now(),
  };
  return settingsCache;
}

// ── Public Entry ─────────────────────────────────────────────────────────────

export async function journalMessage(opts: JournalMessageOptions): Promise<void> {
  try {
    const rules = await prisma.journalingRule.findMany({ where: { enabled: true } });
    if (rules.length === 0) return;

    const settings = await getSettings();

    for (const rule of rules) {
      if (!ruleMatchesDirection(rule.scope, opts.direction)) continue;
      if (!ruleMatchesRecipients(rule, opts.from, opts.to)) continue;

      const reportBuffer = rule.wrapAsReport
        ? buildJournalReport(opts, rule.journalAddress)
        : opts.rawMessage;

      log.debug({ ruleId: rule.id, target: rule.journalAddress }, 'Journal rule matched');

      try {
        await dispatchJournalReport(reportBuffer, rule.journalAddress);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ ruleId: rule.id, err: errMsg }, 'Primary journal sink failed — trying alternative / queueing failure');

        if (settings.alternativeJournalAddress) {
          try {
            await dispatchJournalReport(reportBuffer, settings.alternativeJournalAddress);
            log.info({ ruleId: rule.id, alt: settings.alternativeJournalAddress }, 'Journal delivered to alternative sink');
            continue;
          } catch (altErr) {
            log.warn({ ruleId: rule.id, err: String(altErr) }, 'Alternative journal sink also failed');
          }
        }

        // In die Failure-Tabelle für späteren Retry stellen
        await persistFailure({
          rule, opts, reportBuffer, errMsg, settings,
        });

        if (settings.holdOnFailure) {
          throw new JournalingHoldError(reportBuffer.length);
        }
      }
    }
  } catch (err) {
    if (err instanceof JournalingHoldError) throw err; // Hochreichen, blockiert die SMTP-Pipeline
    log.error({ err }, 'Journaling engine error — continuing without hold');
  }
}

// ── Rule Matching ────────────────────────────────────────────────────────────

function ruleMatchesDirection(scope: string, direction: MessageDirection): boolean {
  switch (scope) {
    case 'ALL':      return true;
    case 'INBOUND':  return direction === 'INBOUND';
    case 'OUTBOUND': return direction === 'OUTBOUND';
    case 'INTERNAL': return direction === 'INTERNAL';
    default:         return false;
  }
}

function ruleMatchesRecipients(
  rule: { recipientType: string; recipientIds: string[] },
  from: string,
  to: string[],
): boolean {
  switch (rule.recipientType) {
    case 'ALL_MAILBOXES':
      return true;
    case 'SPECIFIC_USERS': {
      const addrs = [from, ...to].map((a) => a.toLowerCase());
      return rule.recipientIds.some((id) => addrs.includes(id.toLowerCase()));
    }
    case 'DOMAIN': {
      const addrs = [from, ...to].map((a) => a.toLowerCase());
      return rule.recipientIds.some((domain) =>
        addrs.some((addr) => addr.endsWith('@' + domain.toLowerCase())),
      );
    }
    default:
      return false;
  }
}

// ── RFC-3462 Journal Report ──────────────────────────────────────────────────

function buildJournalReport(opts: JournalMessageOptions, journalAddress: string): Buffer {
  const boundary = `journal-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toUTCString();
  const originalSize = opts.rawMessage.length;

  // BCC-Detection: Envelope-Empfänger, die NICHT in den To/Cc-Headern stehen,
  // sind BCC-Adressen. Headers parsen (top of raw).
  const headers = opts.rawMessage.subarray(0, Math.min(opts.rawMessage.length, 8192)).toString('utf8');
  const headerAddrs = extractHeaderAddresses(headers);
  const envelopeBcc = opts.to.filter((a) => !headerAddrs.has(a.toLowerCase()));
  const envelopeToCc = opts.to.filter((a) => headerAddrs.has(a.toLowerCase()));

  const parts: string[] = [];

  // Outer headers
  parts.push(`From: postmaster@${SMTP_HOSTNAME}`);
  parts.push(`To: ${journalAddress}`);
  parts.push(`Date: ${now}`);
  parts.push(`Subject: Journal Report — ${opts.direction} from ${opts.from}`);
  parts.push('MIME-Version: 1.0');
  parts.push(`Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`);
  parts.push('');

  // ── Teil 1: human-readable summary ──
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset=utf-8');
  parts.push('');
  parts.push(`Journal Report (CoreMail / RFC 3462)`);
  parts.push(`====================================`);
  parts.push(`Direction       : ${opts.direction}`);
  parts.push(`Sender          : ${opts.from}`);
  parts.push(`To/Cc Recipients: ${envelopeToCc.join(', ') || '(none)'}`);
  parts.push(`BCC Recipients  : ${envelopeBcc.join(', ') || '(none)'}`);
  parts.push(`All Envelope-To : ${opts.to.join(', ')}`);
  parts.push(`Date            : ${now}`);
  parts.push(`Original Size   : ${originalSize} bytes`);
  parts.push(`Journal Address : ${journalAddress}`);
  parts.push(`Reporting MTA   : ${SMTP_HOSTNAME}`);
  parts.push('');

  // ── Teil 2: message/delivery-status (RFC 3464) ──
  parts.push(`--${boundary}`);
  parts.push('Content-Type: message/delivery-status');
  parts.push('');
  parts.push(`Reporting-MTA: dns; ${SMTP_HOSTNAME}`);
  parts.push(`Arrival-Date: ${now}`);
  parts.push('');
  parts.push(`Original-Envelope-From: ${opts.from}`);
  for (const rcpt of opts.to) {
    const isBcc = envelopeBcc.includes(rcpt);
    parts.push(`Original-Envelope-To: ${rcpt}${isBcc ? ' (BCC)' : ''}`);
  }
  parts.push(`Journal-Direction: ${opts.direction}`);
  parts.push(`Journal-Timestamp: ${new Date().toISOString()}`);
  parts.push('');

  // ── Teil 3: Original-Mail als .eml-Attachment ──
  parts.push(`--${boundary}`);
  parts.push('Content-Type: message/rfc822');
  parts.push('Content-Disposition: attachment; filename="original.eml"');
  parts.push('');
  parts.push(opts.rawMessage.toString('utf8'));
  parts.push('');
  parts.push(`--${boundary}--`);

  return Buffer.from(parts.join('\r\n'), 'utf8');
}

/** Extrahiert E-Mail-Adressen aus To/Cc-Headern (sehr toleranter Parser). */
function extractHeaderAddresses(headers: string): Set<string> {
  const out = new Set<string>();
  // Headers können "gefoldet" sein (\r\n + whitespace = continuation)
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const lines = unfolded.split(/\r?\n/);
  for (const line of lines) {
    if (!/^(To|Cc):/i.test(line)) continue;
    const rest = line.slice(line.indexOf(':') + 1);
    // Alle <foo@bar> oder bare foo@bar finden
    const matches = rest.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    for (const m of matches) out.add(m.toLowerCase());
  }
  return out;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatchJournalReport(reportBuffer: Buffer, journalAddress: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: RELAY_HOST,
    port: RELAY_PORT,
    secure: false,
    tls: { rejectUnauthorized: false },
  });

  await transport.sendMail({
    envelope: { from: `postmaster@${SMTP_HOSTNAME}`, to: [journalAddress] },
    raw: reportBuffer,
  });

  log.debug({ journalAddress, size: reportBuffer.length }, 'Journal report dispatched');
}

// ── Failure-Persistierung & Retry-Worker ─────────────────────────────────────

async function persistFailure(args: {
  rule:         { id: string; journalAddress: string };
  opts:         JournalMessageOptions;
  reportBuffer: Buffer;
  errMsg:       string;
  settings:     CachedSettings;
}): Promise<void> {
  let storagePath: string | null = null;
  try {
    // Original-Mail (nicht Report!) für späteren Retry persistieren
    const key = `journal-failures/${args.rule.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.eml`;
    await uploadBuffer(key, args.opts.rawMessage, 'message/rfc822');
    storagePath = key;
  } catch (uploadErr) {
    log.error({ err: uploadErr }, 'Could not persist failed journal source to MinIO');
  }

  const nextAttemptAt = new Date(Date.now() + args.settings.initialRetryDelaySec * 1000);
  await prisma.journalingFailure.create({
    data: {
      ruleId:           args.rule.id,
      envelopeFrom:     args.opts.from,
      envelopeTo:       args.opts.to,
      direction:        args.opts.direction,
      rawSizeBytes:     args.opts.rawMessage.length,
      ...(storagePath ? { rawStoragePath: storagePath } : {}),
      targetAddress:    args.rule.journalAddress,
      lastTriedAddress: args.rule.journalAddress,
      status:           'PENDING',
      attempts:         1,
      lastAttemptAt:    new Date(),
      nextAttemptAt,
      errorMessage:     args.errMsg.slice(0, 2000),
    },
  });
}

/**
 * Retry-Loop — wird vom SMTP-Server-Bootstrap einmal gestartet, läuft alle 60s.
 * Holt alle PENDING/RETRYING Failures, deren `nextAttemptAt` erreicht ist, und
 * versucht erneut zu zustellen (primär oder alternativ).
 */
let retryLoopStarted = false;

export function startJournalingRetryLoop(): void {
  if (retryLoopStarted) return;
  retryLoopStarted = true;
  log.info('Journal retry loop started (interval 60s)');

  setInterval(() => { void processFailureBatch(); }, 60_000);
  // Direkt einmal initial laufen lassen — füllt eventuelle Backlog-Reste ab.
  setTimeout(() => { void processFailureBatch(); }, 5_000);
}

async function processFailureBatch(): Promise<void> {
  try {
    const settings = await getSettings();
    const due = await prisma.journalingFailure.findMany({
      where: {
        status: { in: ['PENDING', 'RETRYING', 'ALTERNATIVE'] },
        nextAttemptAt: { lte: new Date() },
      },
      include: { rule: true },
      take: 50,
    });
    if (due.length === 0) return;
    log.info({ count: due.length }, 'Journal failure retry batch');

    for (const f of due) {
      await retrySingleFailure(f, settings);
    }
  } catch (err) {
    log.error({ err }, 'Journal retry batch failed');
  }
}

type FailureWithRule = Awaited<ReturnType<typeof prisma.journalingFailure.findMany<{ include: { rule: true } }>>>[number];

async function retrySingleFailure(f: FailureWithRule, settings: CachedSettings): Promise<void> {
  // Original-Mail aus MinIO holen, Report neu bauen
  if (!f.rawStoragePath) {
    await markAbandoned(f.id, 'No raw message stored — cannot rebuild report');
    return;
  }
  const rawMessage = await downloadBuffer(f.rawStoragePath).catch((err) => {
    log.warn({ id: f.id, err }, 'MinIO download failed during retry');
    return null;
  });
  if (!rawMessage) {
    await markAbandoned(f.id, 'MinIO download failed');
    return;
  }

  const direction = f.direction as MessageDirection;
  const report = f.rule.wrapAsReport
    ? buildJournalReport({ rawMessage, from: f.envelopeFrom, to: f.envelopeTo, direction }, f.targetAddress)
    : rawMessage;

  // Versuch 1: primäre Ziel-Adresse
  let lastError = '';
  try {
    await dispatchJournalReport(report, f.targetAddress);
    await markResolved(f.id, f.targetAddress);
    return;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  // Versuch 2: Alternative-Adresse (nur einmal, wenn vorhanden und nicht bereits versucht)
  const alreadyTriedAlt = f.lastTriedAddress === settings.alternativeJournalAddress;
  if (settings.alternativeJournalAddress && !alreadyTriedAlt) {
    try {
      const altReport = f.rule.wrapAsReport
        ? buildJournalReport({ rawMessage, from: f.envelopeFrom, to: f.envelopeTo, direction }, settings.alternativeJournalAddress)
        : rawMessage;
      await dispatchJournalReport(altReport, settings.alternativeJournalAddress);
      await markResolved(f.id, settings.alternativeJournalAddress);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // Nächster Retry-Versuch?
  const newAttempts = f.attempts + 1;
  if (newAttempts >= settings.maxRetries) {
    await markAbandoned(f.id, lastError);
    return;
  }

  // Exponentielles Backoff: initial × 2^(attempts-1)
  const delaySec = settings.initialRetryDelaySec * Math.pow(2, newAttempts - 1);
  await prisma.journalingFailure.update({
    where: { id: f.id },
    data: {
      status: settings.alternativeJournalAddress && !alreadyTriedAlt ? 'ALTERNATIVE' : 'RETRYING',
      attempts: newAttempts,
      lastAttemptAt: new Date(),
      nextAttemptAt: new Date(Date.now() + delaySec * 1000),
      errorMessage: lastError.slice(0, 2000),
    },
  });
}

async function markResolved(id: string, viaAddress: string): Promise<void> {
  await prisma.journalingFailure.update({
    where: { id },
    data: { status: 'RESOLVED', resolvedAt: new Date(), lastTriedAddress: viaAddress, errorMessage: null },
  });
  log.info({ id, viaAddress }, 'Journal failure resolved');
}

async function markAbandoned(id: string, error: string): Promise<void> {
  await prisma.journalingFailure.update({
    where: { id },
    data: { status: 'ABANDONED', errorMessage: error.slice(0, 2000) },
  });
  log.warn({ id, error: error.slice(0, 200) }, 'Journal failure abandoned after max retries');
}

/** Vom Cache invalidieren — wird vom Admin-Endpoint genutzt nach Settings-Update. */
export function invalidateJournalingSettingsCache(): void {
  settingsCache = null;
}
