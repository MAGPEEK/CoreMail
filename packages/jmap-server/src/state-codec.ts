/**
 * State string codecs (RFC 8620 §1.6.2) — pure functions without DB access.
 * See state.ts for the format.
 */
import { createHash } from 'node:crypto';

export function hashState(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export interface EmailStateParts {
  maxModSeq: bigint;
  highestModSeq: bigint;
  maxCreatedMs: number;
  count: number;
}

export function encodeEmailState(p: EmailStateParts): string {
  return `${p.maxModSeq.toString()}.${p.highestModSeq.toString()}.${p.maxCreatedMs}.${p.count}`;
}

export function decodeEmailState(s: unknown): EmailStateParts | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  return {
    maxModSeq: BigInt(m[1]!),
    highestModSeq: BigInt(m[2]!),
    maxCreatedMs: Number(m[3]!),
    count: Number(m[4]!),
  };
}

export interface MailboxStateParts { count: number; maxCreatedMs: number; hash: string }

export function encodeMailboxState(p: MailboxStateParts): string {
  return `${p.count}.${p.maxCreatedMs}.${p.hash}`;
}

export function decodeMailboxState(s: unknown): MailboxStateParts | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.([0-9a-f]{16})$/.exec(s);
  if (!m) return null;
  return { count: Number(m[1]!), maxCreatedMs: Number(m[2]!), hash: m[3]! };
}
