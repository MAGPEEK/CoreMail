/**
 * SMTP Core Types — RFC 5321 State Machine
 */

export type SmtpState = 'INIT' | 'READY' | 'AUTH_WAIT' | 'MAIL' | 'RCPT' | 'DATA' | 'QUIT';
export type AuthMechanism = 'PLAIN' | 'LOGIN';

export interface AuthUser {
  id: string;
  email: string;
}

export interface Transaction {
  from: string;
  rcptTo: string[];
  data: Buffer[];
  size: number;
}

export interface SmtpHandlers {
  /** Return false to reject the connection with 421 */
  onConnect(ip: string): Promise<boolean>;
  /** Return non-null string to reject MAIL FROM with that message */
  onMailFrom(from: string, ip: string, authUser: AuthUser | null): Promise<string | null>;
  /** Return non-null string to reject RCPT TO with that message */
  onRcptTo(to: string, from: string, authUser: AuthUser | null): Promise<string | null>;
  /** Called after DATA terminator — throw to signal temporary failure */
  onMessage(raw: Buffer, from: string, to: string[], authUser: AuthUser | null, ip: string): Promise<void>;
}

export interface SmtpSessionConfig {
  hostname: string;
  maxSize: number;
  maxRcpt: number;
  requireAuth: boolean;
  tls?: { cert: Buffer; key: Buffer };
  handlers: SmtpHandlers;
  verifyCredentials?: (username: string, password: string) => Promise<AuthUser | null>;
}
