export type AuthSource = 'local' | 'ldap' | 'oidc';

export interface AuthResult {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  source: AuthSource;
  mfaRequired: boolean;
}

export interface MfaChallenge {
  userId: string;
  method: 'totp' | 'webauthn' | 'email_otp' | 'backup_code';
  challengeToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface MfaVerifyRequest {
  challengeToken: string;
  code?: string;
  backupCode?: string;
  webauthnResponse?: unknown;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AppPasswordCreateRequest {
  name: string;
}

export interface OidcCallbackQuery {
  code: string;
  state: string;
}
