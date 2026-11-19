/**
 * Server objects (MS-OXCROPS 1.3.1) a session holds behind its handles:
 * logons, folders, tables, messages, attachments, streams and notification
 * subscriptions. Plain state; behaviour lives in the ROP handlers.
 */
import type { PropertyBag } from '../props/bag.js';
import type { Restriction } from '../props/restriction.js';
import type { NamedPropertyMap } from '../props/named.js';
import type { StoreGuids } from '../ids.js';
import type { AttachmentRecord, MailboxRef, MessageSummary } from '../store/types.js';
import type { MailboxView } from './mailbox-view.js';
import type { SyncConfig } from '../ics/config.js';
import type { IcsState, StateUpload, SyncKind } from '../ics/state.js';
import type { DownloadTransfer } from '../ics/download.js';
import type { FastTransferSource } from '../ics/transfer.js';

export interface LogonState {
  logonId: number;
  logonFlags: number;
  mailbox: MailboxRef;
  guids: StoreGuids;
  view: MailboxView;
  named: NamedPropertyMap;
  /** Submission size limit at logon (PidTagMaximumSubmitMessageSize). */
  maxSubmitBytes: number;
  /**
   * Mailbox modSeq up to which new messages were announced (NewMail); set when
   * the first notification subscription of the logon is registered.
   */
  notifiedModSeq: bigint | null;
}

export interface RecipientState {
  rowId: number;
  /** 1 To, 2 Cc, 3 Bcc. */
  type: number;
  displayName: string;
  /** SMTP address (resolved from X500 DNs). */
  email: string;
  props: PropertyBag;
}

export interface AttachmentState {
  num: number;
  props: PropertyBag;
  /** Stored attachment row (null for attachments created in this session). */
  record: AttachmentRecord | null;
  /** Content written by the client (PidTagAttachDataBinary). */
  data: Buffer | null;
  /** SaveChangesAttachment was called (new attachments only count afterwards). */
  saved: boolean;
}

export interface MessageState {
  folderCounter: bigint;
  /** MID counter (UID of a stored message, session counter for new ones). */
  counter: bigint;
  /** Stored row; null while the message only exists in this session. */
  summary: MessageSummary | null;
  props: PropertyBag;
  recipients: RecipientState[];
  attachments: AttachmentState[];
  nextAttachNum: number;
  readOnly: boolean;
  /** Content (bodies, attachments) of the stored row has been loaded into props. */
  contentLoaded: boolean;
  submitted: boolean;
  /** Folder-associated information (view settings …): kept for the session only. */
  associated: boolean;
  /** Created by RopSynchronizationImportMessageChange: what RopSaveChangesMessage writes. */
  imported: ImportTarget | null;
}

/**
 * The message an ICS upload changes (MS-OXCFXICS 3.2.5.9.4.2): a new one
 * (`clientId` = the ID it keeps, `replacedId` = a client ID that could not be
 * kept), a stored one, or none (`dropped`: the message is gone, moved away, or
 * the server version won a conflict). `pcl` = the uploaded version's
 * PidTagPredecessorChangeList; `uploadState` = the collector's ICS state that
 * records the change numbers written (3.2.5.9.4).
 */
export type ImportTarget =
  | { kind: 'new'; folderId: string; clientId: bigint | null; replacedId: bigint | null; pcl: Buffer | null; uploadState: IcsState }
  | { kind: 'existing'; summary: MessageSummary; pcl: Buffer | null; uploadState: IcsState }
  | { kind: 'dropped' };

export type StreamTarget =
  | { kind: 'message'; message: MessageState }
  | { kind: 'attachment'; message: MessageState; attachment: AttachmentState }
  | { kind: 'readonly' };

export interface StreamState {
  target: StreamTarget;
  tag: number;
  data: Buffer;
  /** Bytes in `data` that belong to the stream (data may be over-allocated). */
  size: number;
  position: number;
  writable: boolean;
  dirty: boolean;
}

export interface SortOrder { tag: number; descending: boolean }

export type TableSource =
  | { kind: 'hierarchy'; folderCounter: bigint; depth: boolean }
  | { kind: 'contents'; folderCounter: bigint; associated: boolean }
  | { kind: 'attachments'; message: MessageState };

export interface TableState {
  source: TableSource;
  columns: number[];
  sort: SortOrder[];
  restriction: Restriction | null;
  /** Cursor (index of the next row). */
  position: number;
  /** Materialized rows (null = load on next use). */
  rows: PropertyBag[] | null;
  /** Table notifications are sent (the table was not opened with NoNotifications). */
  notify: boolean;
}

/** A RopRegisterNotification subscription (delivered by NotificationWait, see emsmdb/notification-wait.ts). */
export interface NotificationSubscription {
  notificationTypes: number;
  wholeStore: boolean;
  folderId: bigint;
  messageId: bigint;
}

/** A synchronization download context (RopSynchronizationConfigure). */
export interface SyncDownload {
  config: SyncConfig;
  /** The initial ICS state (uploaded before the first GetBuffer). */
  state: IcsState;
  stateUpload: StateUpload | null;
  /** Started by the first RopFastTransferSourceGetBuffer. */
  transfer: DownloadTransfer | null;
}

/** A synchronization upload context (RopSynchronizationOpenCollector). */
export interface SyncUpload {
  kind: SyncKind;
  folderCounter: bigint;
  state: IcsState;
  stateUpload: StateUpload | null;
}

export type ServerObject =
  | { kind: 'logon'; logon: LogonState }
  | { kind: 'syncDownload'; logon: LogonState; sync: SyncDownload }
  | { kind: 'syncUpload'; logon: LogonState; sync: SyncUpload }
  | { kind: 'fastTransfer'; logon: LogonState; source: FastTransferSource }
  | { kind: 'folder'; logon: LogonState; counter: bigint }
  | { kind: 'table'; logon: LogonState; table: TableState }
  | { kind: 'message'; logon: LogonState; message: MessageState }
  | { kind: 'attachment'; logon: LogonState; message: MessageState; attachment: AttachmentState }
  | { kind: 'stream'; logon: LogonState; stream: StreamState }
  | { kind: 'notification'; logon: LogonState; subscription: NotificationSubscription };

export type ObjectKind = ServerObject['kind'];
