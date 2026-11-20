import type { FolderMyRights } from '../lib/folderPermissions.js';

export type RetentionTagAction =
  | 'MOVE_TO_ARCHIVE'
  | 'DELETE_AND_ALLOW_RECOVERY'
  | 'PERMANENTLY_DELETE'
  | 'MARK_AS_PAST_RETENTION_LIMIT';

export interface RetentionTag {
  id: string;
  name: string;
  description: string;
  retentionDays: number;
  action: RetentionTagAction;
  isSystem: boolean;
}

export interface FolderRetentionTag {
  id: string;
  name: string;
  retentionDays: number;
  action?: RetentionTagAction;
}

export interface Folder {
  id: string;
  name: string;
  displayName?: string;
  parentId: string | null;
  totalCount: number;
  unreadCount: number;
  isFavorite?: boolean;
  sortOrder?: number;
  color?: string | null;
  isSystem?: boolean;
  retentionTagId?: string | null;
  retentionTag?: FolderRetentionTag | null;
  /** w3 (foreign mailboxes): path entry or visible without read right — shown, not selectable, no counts. */
  noSelect?: boolean;
  /** w3 (foreign mailboxes): the user's effective rights on the folder. */
  myRights?: FolderMyRights;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  isFavorite?: boolean;
  sortOrder?: number;
}

export interface MessageSummary {
  id: string;
  uid: number;
  subject: string;
  fromAddr: string;
  fromName?: string;
  toAddrs: string[];
  date: string;
  flags: string[];
  rawSize: number;
  pinnedAt?: string | null;
  snoozeUntil?: string | null;
  // v3.18.6: rspamd score at delivery time. null = not scanned.
  // 0 = explicitly marked as ham (by the user via "Not spam")
  spamScore?: number | null;
  // v3.18.7: Scheduled send — when set, the mail is in the Sent folder but not
  // yet sent. scheduledStatus shows the state: PENDING = waiting to be sent,
  // SENT = already sent, CANCELLED = sending cancelled
  scheduledAt?: string | null;
  scheduledStatus?: 'PENDING' | 'SENT' | 'CANCELLED' | null;
  attachments: { id: string; filename: string; mimeType: string; size: number; contentId?: string | null; inline?: boolean }[];
  categories?: Category[];
  /** Folder of the message (always set by list + search endpoints since v6.0) */
  folderId?: string;
  /** 9.4: follow-up flag ('none' on pre-9.4 rows — lib/followUp.ts derives it from \Flagged) */
  flagStatus?: FollowUpStatus;
  flagStartAt?: string | null;
  flagDueAt?: string | null;
  flagReminderAt?: string | null;
  flagCompletedAt?: string | null;
}

export type FollowUpStatus = 'none' | 'flagged' | 'complete';

/** 9.4: GET /mail/follow-up — flagged mails for "Gekennzeichnete Elemente und Aufgaben". */
export interface FlaggedMail {
  id: string;
  folderId: string;
  folderName: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  date: string;
  flagStatus: FollowUpStatus;
  flagStartAt: string | null;
  flagDueAt: string | null;
  flagReminderAt: string | null;
  flagCompletedAt: string | null;
}

export type BulkAction =
  | 'read' | 'unread'
  | 'flag' | 'unflag'
  | 'pin'  | 'unpin'
  | 'move' | 'delete' | 'archive'
  | 'spam' | 'notSpam';

export type MessageFilter = 'all' | 'unread' | 'flagged' | 'attachments';

export interface Message extends MessageSummary {
  ccAddrs: string[];
  bodyText: string;
  bodyHtml: string;
  folderId: string;
  /** RFC 5322 Message-ID header (with angle brackets), null for some imported mails */
  messageId?: string | null;
  /** In-Reply-To header of this message */
  inReplyTo?: string | null;
  /** 9.4: read receipt requested by this address (Disposition-Notification-To), null = none */
  dispositionNotificationTo?: string | null;
  /** 9.4: importance of the mail ('high' | 'low'), null / absent = normal */
  importance?: string | null;
  /** 9.4: Sensitivity header ('personal' | 'private' | 'confidential'), null / absent = normal */
  sensitivity?: string | null;
  /** 9.4: external images by the webmail policy — 'load' | 'ask' | 'block' (absent = ask) */
  externalImages?: string;
}

export interface MessagesResponse {
  messages: MessageSummary[];
  total: number;
  limit: number;
  offset: number;
  /** Search only: parsed operators (from:, is:unread, …) for the chip row */
  chips?: SearchChip[];
}

export interface SearchChip {
  key: string;
  value: string;
  negate: boolean;
  /** false = operator with an invalid value, ignored by the server */
  valid: boolean;
  /** Token as typed (used to remove the operator from the query) */
  raw: string;
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  sortOrder?: number;
  isDefault?: boolean;
  // v3.18.14 Calendar Sharing
  shared?: boolean;
  ownerId?: string;
  ownerDisplayName?: string | null;
  ownerEmail?: string | null;
  permission?: 'OWNER' | 'READ' | 'WRITE';
  // v3.18.16: shareId only when shared=true — frontend for PATCH/reorder/self-remove
  shareId?: string;
}

export interface CalendarShare {
  id: string;
  calendarId: string;
  granteeId: string;
  granteeEmail: string;
  granteeDisplayName: string;
  permission: 'READ' | 'WRITE';
  comment?: string;
  createdAt: string;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  dtStart: string;
  dtEnd: string;
  recurring: boolean;
  icalData?: string;
  // v3.18.15 Event Visibility (RFC 5545 CLASS)
  classification?: 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL';
  // v3.18.25 / v3.18.27
  description?: string;
  location?: string;
  organizer?: string | null;
  /** All-day events: dtStart/dtEnd are UTC midnights, dtEnd exclusive — use the date part only. */
  allDay?: boolean;
  rrule?: string | null;
  /** Set on expanded instances of a recurring series (original start, ISO). */
  recurrenceId?: string | null;
  /** Unique per instance: "<id>:<recurrenceId>" (series) or the event id. */
  instanceId?: string;
  uid?: string;
  sequence?: number;
  attendees?: EventAttendee[];
  // Permission info (from GET /events/:id)
  canWrite?: boolean;
  readOnly?: boolean;
  /** 9.4: "Anzeigen als" */
  showAs?: ShowAs;
  /** 9.4: reminder of the owner (list: `reminder`, detail: the two fields) */
  reminder?: { minutes: number; byMail: boolean } | null;
  reminderMinutes?: number | null;
  reminderByMail?: boolean;
}

export type ShowAs = 'FREE' | 'TENTATIVE' | 'BUSY' | 'OOF';

export interface EventAttendee {
  email: string;
  cn?: string;
  partstat?: 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';
  role?: 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT' | 'CHAIR' | 'NON-PARTICIPANT';
  rsvp?: boolean;
}

export interface Contact {
  id: string;
  displayName: string;
  email: string;
  email2: string;
  company: string;
  phone: string;
  mobile: string;
  department: string;
  jobTitle: string;
  notes: string;
  photoUrl?: string | null;
  categories?: string[];
  vcardData?: string;
}

export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'WAITING' | 'DEFERRED';

export interface Task {
  id: string;
  subject: string;
  body: string;
  status: TaskStatus;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  dueDate: string | null;
  reminder: string | null;
  reminderByMail: boolean;
  completedAt: string | null;
  createdAt: string;
  // 9.4: full task form
  startDate?: string | null;
  percentComplete?: number;
  isPrivate?: boolean;
  rrule?: string | null;
  totalWorkMinutes?: number | null;
  actualWorkMinutes?: number | null;
  mileage?: string;
  billingInfo?: string;
  companies?: string;
  bodyHtml?: string;
}

export interface Note {
  id: string;
  title: string;
  body?: string;
  color: string;
  category: string;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: string;
  quotaBytes: number;
  usedBytes: number;
}
