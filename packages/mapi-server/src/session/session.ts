/**
 * In-memory state of one MAPI session context (MS-OXCMAPIHTTP 3.2.1): the
 * authenticated user, the request sequence cookie, the open server objects and
 * logons. The cookie values themselves are never stored — only their hashes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ServerObjectTable } from '../rop/handles.js';
import { DRAFT_COUNTER_BASE } from '../ids.js';
import type { LogonState } from '../objects/state.js';
import type { MapiUser } from '../store/types.js';

export type MapiCredential = 'password' | 'app_password' | 'external';

export interface SessionAuth {
  user: MapiUser;
  credential: MapiCredential;
  appPasswordId?: string;
  /** Opaque digest of the credentials the session was created with. */
  authKey: string;
}

export function newCookieValue(): string {
  return randomBytes(32).toString('base64url');
}

export function cookieDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class MapiSession {
  readonly id: string;
  readonly auth: SessionAuth;
  readonly objects = new ServerObjectTable();
  readonly logons = new Map<number, LogonState>();
  readonly createdAt: number;
  /** Digest of the sequence cookie the next request must present. */
  sequenceDigest: string;
  busy = false;
  lastUsed: number;
  closed = false;
  private draftCounter = DRAFT_COUNTER_BASE;

  constructor(id: string, auth: SessionAuth, sequence: string, now: number) {
    this.id = id;
    this.auth = auth;
    this.sequenceDigest = cookieDigest(sequence);
    this.createdAt = now;
    this.lastUsed = now;
  }

  get user(): MapiUser { return this.auth.user; }

  /** Message ID counter for a message that has not been saved yet. */
  nextDraftCounter(): bigint {
    this.draftCounter += 1n;
    return this.draftCounter;
  }

  /** Checks the presented sequence cookie and rotates it; returns the new value or null. */
  advanceSequence(presented: string | undefined): string | null {
    if (!presented || cookieDigest(presented) !== this.sequenceDigest) return null;
    const next = newCookieValue();
    this.sequenceDigest = cookieDigest(next);
    return next;
  }
}
