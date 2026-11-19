/**
 * Pure retention-expiry decision (no DB access, unit-testable).
 *
 * The age of a message is measured from its DELIVERY time (`Message.createdAt`,
 * set by the server when the message was stored), never from the `Date:`
 * header (`Message.date`). The header is controlled by the sender: a message
 * delivered today with `Date: 1999` must not be purged on the next run.
 *
 * 9.5: a message put back by the backup restore keeps its original delivery
 * time, which may lie far beyond the retention period. It gets a grace period
 * from the restore (`Message.restoredAt`): it expires at
 * max(delivery + retention period, restore + RESTORE_RETENTION_GRACE_DAYS) —
 * the policy still applies, just not on the first run after the restore.
 */

export interface RetentionTagLike {
  enabled: boolean;
  retentionDays: number;
}

export interface RetentionDecision {
  expired: boolean;
  /** Delivery time + retention period (or the end of the restore grace period); null when the tag never expires. */
  expiresAt: Date | null;
}

const DAY_MS = 86_400_000;
/** Days a restored message is safe from retention actions after its restore. */
export const RESTORE_RETENTION_GRACE_DAYS = 30;

export function retentionDecision(
  deliveredAt: Date,
  tag: RetentionTagLike | null | undefined,
  now: Date = new Date(),
  restoredAt: Date | null = null,
): RetentionDecision {
  if (!tag || !tag.enabled) return { expired: false, expiresAt: null };
  // retentionDays <= 0 means "never expire" (and guards against nonsense values).
  if (!Number.isFinite(tag.retentionDays) || tag.retentionDays <= 0) {
    return { expired: false, expiresAt: null };
  }
  const deliveredMs = deliveredAt.getTime();
  if (!Number.isFinite(deliveredMs)) return { expired: false, expiresAt: null };

  const byAge = deliveredMs + tag.retentionDays * DAY_MS;
  const restoredMs = restoredAt ? restoredAt.getTime() : NaN;
  const byRestore = Number.isFinite(restoredMs) ? restoredMs + RESTORE_RETENTION_GRACE_DAYS * DAY_MS : -Infinity;
  const expiresAt = new Date(Math.max(byAge, byRestore));
  return { expired: expiresAt.getTime() <= now.getTime(), expiresAt };
}
