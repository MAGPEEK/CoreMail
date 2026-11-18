/**
 * The data the MAPI layer reads and writes, independent of Prisma. The
 * production implementation is prisma-store.ts (message-store, raw message
 * storage, object store, BullMQ); ROP handlers only see this interface.
 */

/** The authenticated account of a MAPI session. */
export interface MapiUser {
  userId: string;
  email: string;
  displayName: string;
  domainId: string;
}

/** A mailbox the session logged on to. */
export interface MailboxRef {
  mailboxId: string;
  kind: 'own' | 'shared' | 'delegated';
  /** Primary address of the mailbox (lower case). */
  email: string;
  displayName: string;
  readOnly: boolean;
  /** Directory id used in the legacy DN (user id, or shared mailbox id). */
  directoryId: string;
  /**
   * The session user of a logon to a mailbox that is not their own (shared /
   * delegated): set by resolveLogon, the actor of the mailbox access audit.
   */
  actor?: { userId: string; email: string };
}

export interface FolderRecord {
  id: string;
  name: string;
  displayName: string;
  parentId: string | null;
  totalCount: number;
  unreadCount: number;
  createdAt: Date;
}

export interface MessageSummary {
  id: string;
  folderId: string;
  uid: number;
  flags: string[];
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  date: Date;
  createdAt: Date;
  rawSize: number;
  hasAttachments: boolean;
  modSeq: bigint;
}

export interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

/** Full content of a stored message (bodies from the raw original). */
export interface MessageContent {
  bodyText: string;
  bodyHtml: string;
  bccAddrs: string[];
  attachments: AttachmentRecord[];
}

/** An outgoing / draft message composed by the client. */
export interface ComposedMessage {
  subject: string;
  bodyText: string;
  bodyHtml: string;
  /** Requested From address (PidTagSentRepresentingEmailAddress); null = the logon mailbox. */
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  inReplyTo: string | null;
  attachments: Array<{ filename: string; mimeType: string; contentId: string | null; inline: boolean; content: Buffer }>;
}

export interface FolderTarget { mailbox: MailboxRef; folderId: string }

/** The mailbox is at its hard quota: nothing may be added (drafts included). */
export class MailboxFullError extends Error {
  constructor() {
    super('mailbox is over its storage quota');
    this.name = 'MailboxFullError';
  }
}

export type SubmitResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'no-recipients' | 'too-many-recipients' | 'too-large' | 'sender-not-allowed' | 'over-quota' | 'read-only' };

/** Size and recipient limits of a message the user submits (storage submissionLimitsForUser: global + per mailbox). */
export interface SubmissionLimits { maxMessageBytes: number; maxRecipients: number }

export interface MailStore {
  /** Resolves the mailbox named by a RopLogon Essdn (own mailbox for an empty DN). */
  resolveLogon(user: MapiUser, essdn: string): Promise<MailboxRef | null>;
  /** SMTP address of a directory object named by its legacy DN (EX recipients). */
  resolveLegacyDn(dn: string): Promise<string | null>;
  listFolders(mailboxId: string): Promise<FolderRecord[]>;
  createFolder(mailbox: MailboxRef, parent: FolderRecord | null, displayName: string): Promise<FolderRecord | 'exists' | 'invalid-name'>;
  /** Deletes a folder (recursive: with its subfolders); its mail moves to Deleted Items. */
  deleteFolder(mailbox: MailboxRef, folderId: string, recursive: boolean): Promise<'ok' | 'not-found' | 'no-trash'>;
  listMessages(folderId: string): Promise<MessageSummary[]>;
  findMessage(folderId: string, uid: number): Promise<MessageSummary | null>;
  loadContent(message: MessageSummary): Promise<MessageContent>;
  loadAttachment(attachmentId: string): Promise<Buffer>;
  setRead(mailbox: MailboxRef, message: MessageSummary, read: boolean): Promise<void>;
  /** Soft-deletes messages (tombstones, recoverable) — returns how many. */
  deleteMessages(mailbox: MailboxRef, folderId: string, uids: number[]): Promise<number>;
  moveOrCopy(source: FolderTarget, target: FolderTarget, uids: number[], copy: boolean): Promise<number>;
  /** Saves a draft (replacing `replaces` when given) and returns the stored row. */
  saveDraft(mailbox: MailboxRef, folderId: string, message: ComposedMessage, replaces: MessageSummary | null): Promise<MessageSummary>;
  /** The limits RopSubmitMessage enforces for the user (PidTagMaximumSubmitMessageSize of the store). */
  submissionLimits(user: MapiUser): Promise<SubmissionLimits>;
  /** Sends a message (limits, sender check, quota, queue) and files the Sent copy. */
  submit(user: MapiUser, mailbox: MailboxRef, message: ComposedMessage, opts: { saveCopy: boolean; draft: MessageSummary | null }): Promise<SubmitResult>;
}
