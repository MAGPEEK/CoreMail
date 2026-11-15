/**
 * SMTP Core Types — RFC 5321 State Machine
 */

export type SmtpState = 'INIT' | 'READY' | 'AUTH_WAIT' | 'MAIL' | 'RCPT' | 'DATA' | 'QUIT';
export type AuthMechanism = 'PLAIN' | 'LOGIN';

export interface AuthUser {
  id: string;
  email: string;
  /** v7.1.0: credential used (live-session termination after credential changes). */
  credential?: 'password' | 'app_password' | 'external';
  /** v7.1.0: the app password used, when credential is app_password. */
  appPasswordId?: string;
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
  /**
   * Return non-null string to reject RCPT TO with that message.
   * `ip` (client address) is optional for backwards compatibility; when the
   * session passes it, port 25 runs greylisting here instead of after DATA.
   */
  onRcptTo(to: string, from: string, authUser: AuthUser | null, ip?: string): Promise<string | null>;
  /**
   * Called after DATA terminator — throw to signal temporary failure.
   * `meta` (session trace data for the `Received:` header) is optional for
   * backwards compatibility; SmtpSession always passes it.
   */
  onMessage(raw: Buffer, from: string, to: string[], authUser: AuthUser | null, ip: string, meta?: MessageMeta): Promise<void>;
}

/** Session data a handler needs for the trace header (RFC 5321 §4.4). */
export interface MessageMeta {
  /** Argument of EHLO/HELO as sent by the client. */
  helo: string;
  /** RFC 3848 "with" keyword: SMTP, ESMTP, ESMTPS, ESMTPA, ESMTPSA. */
  protocol: 'SMTP' | 'ESMTP' | 'ESMTPS' | 'ESMTPA' | 'ESMTPSA';
  /** Our own host name (220 greeting / EHLO). */
  hostname: string;
  /** Session id (trace header `id` clause, logs). */
  sessionId: string;
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

/** Bare `RCPT TO:<Postmaster>` (RFC 5321 §4.1.1.3) is passed to the handlers as this value. */
export const BARE_POSTMASTER = 'postmaster';

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
  /**
   * clientIp is passed on for brute-force tracking (shared mail-auth lockout).
   * Returns the user, null (invalid credentials) or an SmtpAuthFailure for
   * lockouts / temporary errors.
   */
  verifyCredentials?: (username: string, password: string, clientIp?: string) => Promise<AuthUser | null | SmtpAuthFailure>;
  /**
   * Failed AUTH attempts per session before the server answers 421 and
   * closes the connection (default 3).
   */
  maxAuthFailures?: number;
  /**
   * Tarpit (inbound port 25): after `TARPIT_THRESHOLD` permanent errors in an
   * unauthenticated session (unknown recipients, protocol errors), every
   * further reply is delayed by an increasing amount (1 s, 2 s, … up to
   * `tarpitMaxDelayMs`). 0 / undefined = off.
   */
  tarpitMaxDelayMs?: number;
}

/** Non-credential AUTH outcome: lockout (454) or temporary failure (454). */
export interface SmtpAuthFailure {
  failure: 'locked' | 'temporary';
  retryAfterSec?: number;
}
