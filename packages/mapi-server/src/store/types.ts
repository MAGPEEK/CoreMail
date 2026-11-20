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

/** A recipient of the address book (NSPI): an active user or Shared Mailbox. */
export interface DirectoryRecord {
  /** User id or Shared Mailbox id (the id in its legacy DN). */
  id: string;
  kind: 'user' | 'shared';
  /** Primary address, lower case. */
  email: string;
  displayName: string;
  /** Active alias addresses, lower case. */
  aliases: string[];
  /** Hidden from the address list (mail flow policy): not listed or found by name, only by DN. */
  hidden: boolean;
}

/** The address book a user sees: the recipients of the user's own domain. */
export interface DirectoryStore {
  listDirectory(user: MapiUser): Promise<DirectoryRecord[]>;
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
  /** The ID the client assigned (cached mode, MapiObject): replaces the folder counter. */
  clientId: bigint | null;
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
  /** modSeq of the row's creation (its content never changes afterwards). */
  createdModSeq: bigint;
  /** The ID the client assigned (cached mode, MapiObject): replaces the UID as message counter. */
  clientId: bigint | null;
  /** PidTagPredecessorChangeList of the version a client uploaded (conflict detection). */
  pcl: Buffer | null;
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
  | { ok: false; reason: 'no-recipients' | 'too-many-recipients' | 'too-large' | 'sender-not-allowed' | 'over-quota' | 'read-only' | 'rate-limited' };

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
  /** Sets or clears \Seen; returns the row's new modSeq (null: nothing changed). */
  setRead(mailbox: MailboxRef, message: MessageSummary, read: boolean): Promise<bigint | null>;
  /** Soft-deletes messages (tombstones, recoverable) — returns how many. */
  deleteMessages(mailbox: MailboxRef, folderId: string, uids: number[]): Promise<number>;
  moveOrCopy(source: FolderTarget, target: FolderTarget, uids: number[], copy: boolean): Promise<number>;
  /** Saves a draft (replacing `replaces` when given) and returns the stored row. */
  saveDraft(mailbox: MailboxRef, folderId: string, message: ComposedMessage, replaces: MessageSummary | null): Promise<MessageSummary>;
  /** The limits RopSubmitMessage enforces for the user (PidTagMaximumSubmitMessageSize of the store). */
  submissionLimits(user: MapiUser): Promise<SubmissionLimits>;
  /** Sends a message (limits, sender check, quota, queue) and files the Sent copy. */
  submit(user: MapiUser, mailbox: MailboxRef, message: ComposedMessage, opts: { saveCopy: boolean; draft: MessageSummary | null }): Promise<SubmitResult>;
  /** Highest modSeq written in the mailbox (the message store's counter). */
  highestModSeq(mailboxId: string): Promise<bigint>;
  /**
   * Live messages of the given folders that appeared in their mailbox after
   * `sinceModSeq` (created, copied or moved in), oldest first, at most `limit`.
   */
  messagesCreatedSince(folderIds: readonly string[], sinceModSeq: bigint, limit: number): Promise<NewMessage[]>;

  // ── Cached mode (ICS upload, docs/mapi.md) ──
  /** Stores a message the client uploaded as a regular (not draft) message; returns the row. */
  importMessage(mailbox: MailboxRef, folderId: string, message: ComposedMessage, opts: ImportOptions): Promise<MessageSummary>;
  /** Renames and / or moves a folder below `parent` (null = top level); its subfolders follow. */
  renameFolder(mailbox: MailboxRef, folderId: string, parent: FolderRecord | null, displayName: string): Promise<'ok' | 'exists' | 'invalid-name' | 'not-found'>;
  /** Reserves `count` IDs for the client (RopGetLocalReplicaIds); returns the first GLOBCNT. */
  reserveLocalIds(mailboxId: string, count: number): Promise<bigint>;
  /** Client-assigned IDs whose objects the server stored under its own ID. */
  replacedLocalIds(mailboxId: string): Promise<Set<bigint>>;
  addReplacedLocalIds(mailboxId: string, ids: readonly bigint[]): Promise<void>;
  /** The first GLOBCNT RopGetLocalReplicaIds has not handed out yet (null: the counter is unknown). */
  localIdsHandedOutBelow(mailboxId: string): Promise<bigint | null>;
  /**
   * Live messages of a folder by MAPI counter: a UID, or an ID a client
   * assigned (MapiObject; also a retired UID that a draft saved again keeps).
   */
  findMessagesByCounters(folderId: string, counters: readonly bigint[]): Promise<Map<bigint, MessageSummary>>;
  /** A live message by its row id. */
  messageByRowId(id: string): Promise<MessageSummary | null>;
  /** What a client-assigned ID of the mailbox names (null: never assigned). */
  clientIdOwner(mailboxId: string, clientId: bigint): Promise<ClientIdOwner | null>;
  /** IDs within `ranges` that the mailbox's clients ever had assigned (live or retired objects). */
  assignedClientIds(mailboxId: string, ranges: readonly IdRange[]): Promise<bigint[]>;
  /**
   * Binds a client-assigned ID and / or the PCL of an uploaded version to a
   * message or folder row. A client ID bound to another row moves to this one
   * (a draft saved again keeps its ID); callers check clientIdOwner first.
   */
  bindMapiObject(mailboxId: string, target: MapiObjectTarget, data: { clientId?: bigint; pcl?: Buffer }): Promise<void>;
  /**
   * The session user's current access to a shared / delegated mailbox it is
   * logged on to (null = revoked); no mailbox access audit entry.
   */
  foreignAccess(user: MapiUser, mailbox: MailboxRef): Promise<MailboxRef | null>;
}

export interface IdRange { low: bigint; high: bigint }

export type MapiObjectTarget = { messageId: string } | { folderId: string };

/** The object a client-assigned ID names; `retired`: that object no longer exists. */
export type ClientIdOwner = { kind: 'message'; messageId: string } | { kind: 'folder'; folderId: string } | { kind: 'retired' };

export interface ImportOptions {
  read: boolean;
  /** Date of the message (PidTagClientSubmitTime / delivery time); null = now. */
  date: Date | null;
}

/** A message that appeared in a folder (NewMail notifications). */
export interface NewMessage { folderId: string; uid: number; read: boolean; createdModSeq: bigint; clientId: bigint | null }
