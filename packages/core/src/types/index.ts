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
  /**
   * Issue time in milliseconds (8.0.0). `iat` has whole-second precision, which
   * cannot tell a token minted earlier in the same second as a "revoke all"
   * from one minted after it; revocation marks compare this claim instead.
   */
  iatMs?: number;
  exp?: number;
}

export type MailFlag = '\\Seen' | '\\Flagged' | '\\Answered' | '\\Deleted' | '\\Draft';

export interface MailAddress {
  name?: string;
  address: string;
}
