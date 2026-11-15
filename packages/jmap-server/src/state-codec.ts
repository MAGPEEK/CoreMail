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
  /**
   * Rows with createdModSeq ≤ createdBase existed at this state. Equals
   * highestModSeq except in the intermediate state of a paged /changes
   * response (hasMoreChanges), which keeps the base of the original state.
   */
  createdBase: bigint;
}

export function encodeEmailState(p: EmailStateParts): string {
  const base = `${p.maxModSeq.toString()}.${p.highestModSeq.toString()}.${p.maxCreatedMs}.${p.count}`;
  return p.createdBase === p.highestModSeq ? base : `${base}.${p.createdBase.toString()}`;
}

export function decodeEmailState(s: unknown): EmailStateParts | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const highestModSeq = BigInt(m[2]!);
  return {
    maxModSeq: BigInt(m[1]!),
    highestModSeq,
    maxCreatedMs: Number(m[3]!),
    count: Number(m[4]!),
    createdBase: m[5] !== undefined ? BigInt(m[5]) : highestModSeq,
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
