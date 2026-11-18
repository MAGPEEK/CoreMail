/**
 * Internal CoreMail message headers (9.4 review: one complete list).
 *
 * These X-CoreMail-* fields are written by CoreMail itself and read by its own
 * logic (loop protection, rules, quarantine, drafts). A copy supplied by a
 * sender must never reach that logic: every ingress — port 25, the device
 * relay, SMTP submission and the outbound worker's local delivery of a client
 * submission (REST/MWA, JMAP, ActiveSync) — removes all of them before any
 * filter, rule or forward is evaluated. CoreMail adds its genuine values only
 * after that stripping.
 *
 * Not listed (never read by CoreMail logic, informational only):
 * `X-Coremail-Calendar-Method` on outgoing invitations/replies.
 */

/** Informational trace header added to messages released from quarantine. Never trusted. */
export const QUARANTINE_RELEASE_HEADER = 'X-CoreMail-Quarantine-Released';

/** Virus-scan verdict for mail delivered/quarantined without a clean ClamAV scan (smtp-server, 9.2). */
export const VIRUS_SCAN_HEADER = 'X-CoreMail-Virus-Scan';

/** Loop protection of inbox-rule and admin forwards (smtp-server handlers/rule-forward.ts). */
export const RULE_FORWARDED_HEADER = 'X-CoreMail-RuleForwarded';

/** Pending (not yet valid) recipients of a server draft (draft.ts). */
export const DRAFT_PENDING_HEADER = 'X-CoreMail-Draft-Pending';

/** Every internal header that must never be accepted from a sender. */
export const INTERNAL_MAIL_HEADERS: readonly string[] = Object.freeze([
  QUARANTINE_RELEASE_HEADER, VIRUS_SCAN_HEADER, RULE_FORWARDED_HEADER, DRAFT_PENDING_HEADER,
]);

/**
 * Pure: the internal headers to strip, keeping `keep` (case-insensitive) — a
 * rule forward delivered locally keeps its genuine loop header.
 */
export function internalHeadersExcept(keep: readonly string[]): string[] {
  const kept = new Set(keep.map((k) => k.toLowerCase()));
  return INTERNAL_MAIL_HEADERS.filter((h) => !kept.has(h.toLowerCase()));
}
