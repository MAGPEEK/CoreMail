export type UserRole =
  | 'USER'
  | 'HELP_DESK'
  | 'RECIPIENT_MANAGEMENT'
  | 'COMPLIANCE_MANAGEMENT'
  | 'HYGIENE_MANAGEMENT'
  | 'SERVER_MANAGEMENT'
  | 'VIEW_ONLY_ORG'
  | 'ORGANIZATION_MANAGEMENT';

export type SharedMailboxPermType = 'FULL_ACCESS' | 'SEND_AS' | 'SEND_ON_BEHALF' | 'READ_ONLY';

export type MfaMethod = 'TOTP' | 'WEBAUTHN' | 'EMAIL_OTP' | 'BACKUP_CODE';

export interface JwtPayload {
  sub: string;       // userId
  email: string;
  role: UserRole;
  domainId: string;
  sessionId: string;
  mfaVerified: boolean;
  iat?: number;
  exp?: number;
}

export interface AppPasswordPayload {
  userId: string;
  name: string;
  hash: string;
}

export type MailFlag = '\\Seen' | '\\Flagged' | '\\Answered' | '\\Deleted' | '\\Draft';

export interface MailAddress {
  name?: string;
  address: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ServiceHealth {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  details?: Record<string, unknown>;
}
