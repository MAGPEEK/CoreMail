/**
 * Journaling Engine — Phase 9
 *
 * Implements RFC 3462-style message journaling.
 * After each inbound delivery and outbound relay, this engine checks
 * all enabled JournalingRules and sends a journal report to the
 * configured journal sink address.
 *
 * RFC 3462 Journal Report format:
 *   Content-Type: multipart/report; report-type=delivery-status
 *     Part 1: Human-readable summary
 *     Part 2: message/delivery-status (envelope metadata)
 *     Part 3: message/rfc822 (original message)
 */

import nodemailer from 'nodemailer';
import { prisma } from '@coremail/storage/prisma';
import { createLogger } from '@coremail/core';

const log = createLogger('smtp:journaling');

const SMTP_HOSTNAME = process.env['SMTP_HOSTNAME'] ?? 'mail.localhost';
const SMTP_RELAY_HOST = process.env['SMTP_RELAY_HOST'] ?? 'localhost';
const SMTP_RELAY_PORT = parseInt(process.env['SMTP_RELAY_PORT'] ?? '25', 10);

export type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'INTERNAL';

export interface JournalMessageOptions {
  rawMessage: Buffer;
  from: string;
  to: string[];
  direction: MessageDirection;
}

/**
 * Main entry point: check all applicable journaling rules and dispatch
 * journal reports as needed.
 */
export async function journalMessage(opts: JournalMessageOptions): Promise<void> {
  try {
    const rules = await prisma.journalingRule.findMany({
      where: { enabled: true },
    });

    if (rules.length === 0) return;

    for (const rule of rules) {
      if (!ruleMatchesDirection(rule.scope, opts.direction)) continue;
      if (!ruleMatchesRecipients(rule, opts.from, opts.to)) continue;

      log.debug(
        { ruleId: rule.id, ruleName: rule.name, journalAddress: rule.journalAddress },
        'Journaling rule matched — dispatching report',
      );

      const reportMessage = rule.wrapAsReport
        ? buildJournalReport(opts, rule.journalAddress)
        : opts.rawMessage;

      await dispatchJournalReport(reportMessage, rule.journalAddress);
    }
  } catch (err) {
    // Journaling must never block delivery
    log.error({ err }, 'Journaling engine error — continuing');
  }
}

// ── Rule Matching ─────────────────────────────────────────────────────────────

function ruleMatchesDirection(
  scope: string,
  direction: MessageDirection,
): boolean {
  switch (scope) {
    case 'ALL': return true;
    case 'INBOUND': return direction === 'INBOUND';
    case 'OUTBOUND': return direction === 'OUTBOUND';
    case 'INTERNAL': return direction === 'INTERNAL';
    default: return false;
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
      // Match if from or any recipient is in the list
      const addresses = [from, ...to].map((a) => a.toLowerCase());
      return rule.recipientIds.some((id) => addresses.includes(id.toLowerCase()));
    }

    case 'DOMAIN': {
      // Match if from or any recipient belongs to one of the listed domains
      const addresses = [from, ...to].map((a) => a.toLowerCase());
      return rule.recipientIds.some((domain) =>
        addresses.some((addr) => addr.endsWith('@' + domain.toLowerCase())),
      );
    }

    default:
      return false;
  }
}

// ── RFC 3462 Journal Report Builder ──────────────────────────────────────────

function buildJournalReport(opts: JournalMessageOptions, journalAddress: string): Buffer {
  const boundary = `journal-report-${Date.now()}`;
  const now = new Date().toUTCString();
  const originalSize = opts.rawMessage.length;

  const parts: string[] = [];

  // Outer headers
  parts.push(`From: postmaster@${SMTP_HOSTNAME}`);
  parts.push(`To: ${journalAddress}`);
  parts.push(`Date: ${now}`);
  parts.push(`Subject: Journal Report — ${opts.direction} message from ${opts.from}`);
  parts.push('MIME-Version: 1.0');
  parts.push(`Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`);
  parts.push('');

  // Part 1: Human-readable summary
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset=utf-8');
  parts.push('');
  parts.push(`Journal Report`);
  parts.push(`==============`);
  parts.push(`Direction : ${opts.direction}`);
  parts.push(`From      : ${opts.from}`);
  parts.push(`To        : ${opts.to.join(', ')}`);
  parts.push(`Date      : ${now}`);
  parts.push(`Size      : ${originalSize} bytes`);
  parts.push(`Journal   : ${journalAddress}`);
  parts.push(`Server    : ${SMTP_HOSTNAME}`);
  parts.push('');

  // Part 2: message/delivery-status (envelope metadata)
  parts.push(`--${boundary}`);
  parts.push('Content-Type: message/delivery-status');
  parts.push('');
  parts.push(`Reporting-MTA: dns; ${SMTP_HOSTNAME}`);
  parts.push('');
  parts.push(`Original-Envelope-From: ${opts.from}`);
  for (const rcpt of opts.to) {
    parts.push(`Original-Envelope-To: ${rcpt}`);
  }
  parts.push(`Journal-Direction: ${opts.direction}`);
  parts.push(`Journal-Timestamp: ${new Date().toISOString()}`);
  parts.push('');

  // Part 3: original message/rfc822
  parts.push(`--${boundary}`);
  parts.push('Content-Type: message/rfc822');
  parts.push('');
  parts.push(opts.rawMessage.toString('utf8'));
  parts.push('');
  parts.push(`--${boundary}--`);

  return Buffer.from(parts.join('\r\n'), 'utf8');
}

// ── Journal Report Dispatch ───────────────────────────────────────────────────

async function dispatchJournalReport(reportBuffer: Buffer, journalAddress: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: SMTP_RELAY_HOST,
    port: SMTP_RELAY_PORT,
    secure: false,
    tls: { rejectUnauthorized: false },
  });

  await transport.sendMail({
    envelope: {
      from: `postmaster@${SMTP_HOSTNAME}`,
      to: [journalAddress],
    },
    raw: reportBuffer,
  });

  log.debug({ journalAddress, size: reportBuffer.length }, 'Journal report dispatched');
}
