/**
 * JMAP — shared types (RFC 8620 §3).
 */
import type { UserRole } from '@coremail/core';

export type Id = string;
export type JsonObject = Record<string, unknown>;

/** [name, arguments, methodCallId] */
export type Invocation = [string, JsonObject, string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<string, string>;
}

export interface JmapResponse {
  methodResponses: Invocation[];
  createdIds?: Record<string, string>;
  sessionState: string;
}

export interface JmapUser {
  userId: string;
  email: string;
  displayName: string;
  domainId: string;
  role: UserRole | string;
}

/**
 * A JMAP account corresponds to a CoreMail mailbox (Mailbox row):
 *  - primary account: accountId = userId
 *  - shared mailbox:  accountId = `shared-<sharedMailboxId>`
 *  - delegated mailbox of another user: accountId = that user's userId
 */
export interface AccountContext {
  accountId: string;
  mailboxId: string;
  ownerUserId: string | null;
  sharedMailboxId: string | null;
  name: string;
  email: string;
  readOnly: boolean;
  isPersonal: boolean;
  maySend: boolean;
}

export interface MethodContext {
  user: JmapUser;
  accounts: Map<string, AccountContext>;
  createdIds: Map<string, string>;
  /** Responses of this request so far (for result references). */
  responses: Invocation[];
  using: Set<string>;
  /** Resolves `#creationId` to a real id (RFC 8620 §5.3). */
  resolveId(id: string): string;
  /** Throws accountNotFound if the account is not visible. */
  account(accountId: unknown): AccountContext;
}

export type HandlerResult = JsonObject | Array<{ name: string; args: JsonObject }>;
export type MethodHandler = (args: JsonObject, ctx: MethodContext, callId: string) => Promise<HandlerResult>;

export interface MethodDefinition {
  capability: string;
  handler: MethodHandler;
}

// ── Mail objects (RFC 8621) ──────────────────────────────────────────────────

export interface EmailAddress { name: string | null; email: string }
export interface EmailHeader { name: string; value: string }

export interface EmailBodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  headers: EmailHeader[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts: EmailBodyPart[] | null;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<string, Record<string, string>>;
  pushState?: string;
}
