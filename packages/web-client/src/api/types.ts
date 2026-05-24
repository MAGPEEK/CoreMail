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
  // v3.18.6: rspamd-Score zum Zeitpunkt der Zustellung. null = nicht gescannt.
  // 0 = explizit als Ham markiert (vom User via „Kein Spam")
  spamScore?: number | null;
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
  categories?: Category[];
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
}

export interface MessagesResponse {
  messages: MessageSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  sortOrder?: number;
  isDefault?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  dtStart: string;
  dtEnd: string;
  recurring: boolean;
  icalData?: string;
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
  vcardData?: string;
}

export interface Task {
  id: string;
  subject: string;
  body: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'DEFERRED';
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  dueDate: string | null;
  reminder: string | null;
  reminderByMail: boolean;
  completedAt: string | null;
  createdAt: string;
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
