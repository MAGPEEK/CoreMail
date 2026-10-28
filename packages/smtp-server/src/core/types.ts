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

/**
 * ESMTP extensions mirroring the `SmtpSettings` flags. Advertised or suppressed
 * in the EHLO response.
 */
export interface EsmtpExtensions {
  starttls:       boolean;
  authPlain:      boolean;
  authLogin:      boolean;
  authCramMd5:    boolean;
  pipelining:     boolean;
  size:           boolean;
  bit8mime:       boolean;
  enhancedStatus: boolean;
  smtputf8:       boolean;
  dsn:            boolean;
  chunking:       boolean;
}

export const DEFAULT_ESMTP_EXTENSIONS: EsmtpExtensions = {
  starttls: true, authPlain: true, authLogin: true,
  pipelining: true, size: true, bit8mime: true, enhancedStatus: true,
  // Deliberately false — these extensions are NOT implemented in the server:
  //   CRAM-MD5 (RFC 4954) — handleAuth only recognizes PLAIN + LOGIN
  //   SMTPUTF8 (RFC 6531) — UTF-8 addresses are not handled specially
  //   DSN (RFC 3461)      — no NOTIFY/ORCPT/ENVID parsing, no multipart/report
  //   CHUNKING (RFC 3030) — BDAT command is not recognized by the parser
  authCramMd5: false, smtputf8: false, dsn: false, chunking: false,
};

export interface SmtpSessionConfig {
  hostname: string;
  /**
   * Optional custom banner text after "220 ".
   * If set, it is used instead of the default banner "<hostname> ESMTP CoreMail".
   * Configurable via admin panel → SMTP configuration → SMTP banner.
   * Passed as a getter so that live updates take effect without restarting listeners.
   */
  bannerText?: string;
  /** Max. message size in bytes (from SmtpSettings.maxMessageSizeMb × 1024²). */
  maxSize: number;
  maxRcpt: number;
  requireAuth: boolean;
  /** ESMTP extensions — if `undefined`, DEFAULT_ESMTP_EXTENSIONS apply. */
  esmtp?: EsmtpExtensions;
  tls?: { cert: Buffer; key: Buffer };
  /**
   * If true (default), STARTTLS is advertised in the EHLO response (if a TLS config exists).
   * On port 25 with a self-signed cert: set to false so that strict MTAs (Microsoft Exchange)
   * can deliver in plain instead of getting stuck on a failed TLS handshake.
   */
  advertiseStarttls?: boolean;
  handlers: SmtpHandlers;
  /** clientIp is passed on for brute-force tracking (ip-limiter). */
  verifyCredentials?: (username: string, password: string, clientIp?: string) => Promise<AuthUser | null>;
}
