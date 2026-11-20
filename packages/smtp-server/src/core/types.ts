/**
 * SMTP Core Types — RFC 5321 State Machine
 */
import type { TraceStage } from '@coremail/storage';
import type { BodyType } from './envelope.js';
import type { EnvelopeDsn } from './dsn-params.js';

/** 10.2: receives a check verdict (connection filter, greylisting) for the message trace. */
export type TraceNoteSink = (stage: TraceStage) => void;

/** `BDAT`: at least one non-LAST BDAT chunk of the transaction was received (RFC 3030). */
export type SmtpState = 'INIT' | 'READY' | 'AUTH_WAIT' | 'MAIL' | 'RCPT' | 'DATA' | 'BDAT' | 'QUIT';
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
  /** MAIL … SMTPUTF8 (RFC 6531). */
  smtputf8: boolean;
  /** MAIL … BODY= (RFC 6152 / RFC 3030). */
  body: BodyType;
  /** RET / ENVID / per-recipient NOTIFY + ORCPT (RFC 3461). */
  dsn: EnvelopeDsn;
  /** 10.2: RCPT-stage check verdicts of this transaction (message trace, capped). */
  notes?: TraceStage[];
}

/** Envelope extension data of one transaction, handed to `onMessage` via `MessageMeta`. */
export interface MessageEnvelope {
  smtputf8: boolean;
  body: BodyType;
  /** Present when the client used any DSN parameter. */
  dsn?: EnvelopeDsn;
  /** The content was transferred with BDAT (RFC 3030). */
  chunking: boolean;
}

export interface SmtpHandlers {
  /** Return false to reject the connection with 421 */
  onConnect(ip: string, note?: TraceNoteSink): Promise<boolean>;
  /** Return non-null string to reject MAIL FROM with that message */
  onMailFrom(from: string, ip: string, authUser: AuthUser | null): Promise<string | null>;
  /**
   * Return non-null string to reject RCPT TO with that message.
   * `ip` (client address) is optional for backwards compatibility; when the
   * session passes it, port 25 runs greylisting here instead of after DATA.
   */
  onRcptTo(to: string, from: string, authUser: AuthUser | null, ip?: string, note?: TraceNoteSink): Promise<string | null>;
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
  /**
   * RFC 3848 "with" keyword: SMTP, ESMTP, ESMTPS, ESMTPA, ESMTPSA; RFC 6531
   * §3.7.3 UTF8SMTP, UTF8SMTPS, UTF8SMTPA, UTF8SMTPSA for SMTPUTF8 transactions.
   */
  protocol: 'SMTP' | 'ESMTP' | 'ESMTPS' | 'ESMTPA' | 'ESMTPSA' | 'UTF8SMTP' | 'UTF8SMTPS' | 'UTF8SMTPA' | 'UTF8SMTPSA';
  /** Our own host name (220 greeting / EHLO). */
  hostname: string;
  /** Session id (trace header `id` clause, logs). */
  sessionId: string;
  /** SMTPUTF8 / BODY / DSN parameters and the transfer mode (optional for other callers). */
  envelope?: MessageEnvelope;
  /** 10.2: connection facts for the message trace (optional for other callers). */
  connection?: MessageConnection;
}

/** Connection facts of the SMTP session a message arrived on (10.2 message trace). */
export interface MessageConnection {
  /** Local port of the listener (25, 465, 587, …). */
  port?: number;
  /** Negotiated TLS protocol and cipher; absent = no TLS. */
  tlsVersion?: string;
  tlsCipher?: string;
  /** SMTP AUTH user of the session. */
  authUser?: string;
  /** ISO time the connection was accepted. */
  connectedAt?: string;
  /** Connect- and RCPT-stage check verdicts (connection filter, greylisting). */
  notes?: TraceStage[];
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
  // v8.1: SMTPUTF8 (RFC 6531), DSN (RFC 3461) and CHUNKING + BINARYMIME
  // (RFC 3030) are implemented.
  smtputf8: true, dsn: true, chunking: true,
  // CRAM-MD5 (RFC 4954) stays off — handleAuth only recognizes PLAIN + LOGIN.
  authCramMd5: false,
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
   * Accept TLS 1.0/1.1 (vetted legacy cipher list) for implicit TLS and
   * STARTTLS on this listener (ServiceListener.allowLegacyTls). Default TLS 1.2+.
   */
  allowLegacyTls?: boolean;
  /**
   * If true (default), STARTTLS is advertised in the EHLO response (if a TLS config exists).
   * On port 25 with a self-signed cert: set to false so that strict MTAs
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
  /**
   * Idle timeout while waiting for the greeting reply / the next command
   * (SmtpSettings.connectionTimeoutSec × 1000). Default 5 min (RFC 5321
   * §4.5.3.2). The DATA block timeout is not affected.
   */
  commandTimeoutMs?: number;
  /**
   * Delay before the 220 greeting (SmtpSettings.greetingDelaySec × 1000,
   * inbound port 25 only). A client that talks before the greeting is
   * answered with 554 and disconnected (pre-greeting traffic). 0 = off.
   */
  greetingDelayMs?: number;
  /**
   * Maximum concurrent connections per client IP (SmtpSettings.maxConnectionsPerIp).
   * Read by the server factory for inbound listeners (port 25) only; submission
   * keeps SMTP_MAX_CONNS_PER_IP (default 10). See ip-limiter connectionCaps().
   */
  maxConnectionsPerIp?: number;
  /**
   * Maximum concurrent inbound (port 25) connections from public IPs
   * (SmtpSettings.maxConnections). Submission listeners and private/loopback
   * clients are exempt. Read by the server factory; 0/undefined = no limit.
   */
  maxConnections?: number;
}

/**
 * Non-credential AUTH outcome: lockout (454), temporary failure (454) or
 * (9.4) correct credentials but submission switched off for the account (535 5.7.1).
 */
export interface SmtpAuthFailure {
  failure: 'locked' | 'temporary' | 'protocol_disabled';
  retryAfterSec?: number;
}
