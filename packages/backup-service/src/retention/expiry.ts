/**
 * Pure retention-expiry decision (no DB access, unit-testable).
 *
 * The age of a message is measured from its DELIVERY time (`Message.createdAt`,
 * set by the server when the message was stored), never from the `Date:`
 * header (`Message.date`). The header is controlled by the sender: a message
 * delivered today with `Date: 1999` must not be purged on the next run.
 */

export interface RetentionTagLike {
  enabled: boolean;
  retentionDays: number;
}

export interface RetentionDecision {
  expired: boolean;
  /** Delivery time + retention period; null when the tag never expires. */
  expiresAt: Date | null;
}

const DAY_MS = 86_400_000;

export function retentionDecision(
  deliveredAt: Date,
  tag: RetentionTagLike | null | undefined,
  now: Date = new Date(),
): RetentionDecision {
  if (!tag || !tag.enabled) return { expired: false, expiresAt: null };
  // retentionDays <= 0 means "never expire" (and guards against nonsense values).
  if (!Number.isFinite(tag.retentionDays) || tag.retentionDays <= 0) {
    return { expired: false, expiresAt: null };
  }
  const deliveredMs = deliveredAt.getTime();
  if (!Number.isFinite(deliveredMs)) return { expired: false, expiresAt: null };

  const expiresAt = new Date(deliveredMs + tag.retentionDays * DAY_MS);
  return { expired: expiresAt.getTime() <= now.getTime(), expiresAt };
}
