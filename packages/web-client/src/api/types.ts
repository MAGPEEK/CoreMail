export interface Folder {
  id: string;
  name: string;
  displayName?: string;
  parentId: string | null;
  totalCount: number;
  unreadCount: number;
}

export interface MessageSummary {
  id: string;
  uid: number;
  subject: string;
  fromAddr: string;
  toAddrs: string[];
  date: string;
  flags: string[];
  rawSize: number;
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
}

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
  company: string;
  phone?: string;
  vcardData?: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'DEFERRED';
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  dueDate: string | null;
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
