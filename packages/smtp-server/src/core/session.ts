/**
 * SmtpSession — RFC 5321 State Machine
 *
 * Full implementation including:
 *   - EHLO / HELO
 *   - AUTH PLAIN / LOGIN (RFC 4954)
 *   - STARTTLS (RFC 3207)
 *   - MAIL FROM / RCPT TO / DATA with dot-stuffing
 *   - BDAT (RFC 3030 CHUNKING + BINARYMIME): exact octet counts, no dot-stuffing
 *   - DSN parameters (RFC 3461), SMTPUTF8 (RFC 6531)
 *   - RSET / NOOP / VRFY / EXPN / HELP / QUIT
 *   - RFC 5321 §4.5.3.2 timeouts
 *   - RFC 5321 §4.5.3.1 max line length
 *   - State enforcement and sequence checks
 */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { createLogger, tlsServerOptions, PROTOCOL_ACCESS_CHANGE, type AuthInvalidationEvent } from '@coremail/core';
import { logTlsSocketError } from '@coremail/core/tls-errors';
import type { SmtpState, AuthMechanism, AuthUser, Transaction, SmtpSessionConfig, MessageMeta, EsmtpExtensions, MessageConnection } from './types.js';
import { DEFAULT_ESMTP_EXTENSIONS } from './types.js';
import type { TraceStage } from '@coremail/storage';

/** 10.2: RCPT-stage trace notes kept per transaction (one per recipient, capped). */
const MAX_TX_NOTES = 20;

/** Facts the server factory knows before the session starts (10.2 message trace). */
export interface SessionInit {
  connectedAt?: Date;
  /** Connect-stage check verdicts (connection filter). */
  connectNotes?: readonly TraceStage[];
}

/** Pure: the connection facts of a message for the trace (TLS details only on an encrypted socket). */
export function connectionFacts(o: {
  socket: { localPort?: number | undefined; getProtocol?: () => string | null; getCipher?: () => { name?: string } | null };
  tls: boolean;
  authUser?: string | undefined;
  connectedAt?: Date | undefined;
  notes: readonly TraceStage[];
}): MessageConnection {
  let tlsVersion: string | undefined;
  let tlsCipher: string | undefined;
  if (o.tls) {
    try { tlsVersion = o.socket.getProtocol?.() ?? undefined; } catch { /* closed socket */ }
    try { tlsCipher = o.socket.getCipher?.()?.name ?? undefined; } catch { /* closed socket */ }
    tlsVersion ??= 'TLS';
  }
  return {
    ...(typeof o.socket.localPort === 'number' ? { port: o.socket.localPort } : {}),
    ...(tlsVersion ? { tlsVersion } : {}),
    ...(tlsCipher ? { tlsCipher } : {}),
    ...(o.authUser ? { authUser: o.authUser } : {}),
    ...(o.connectedAt ? { connectedAt: o.connectedAt.toISOString() } : {}),
    ...(o.notes.length ? { notes: [...o.notes] } : {}),
  };
}
import { smtpLiveSessions } from './live-sessions.js';
import {
  parseMailFrom, parseRcptTo, decodeBase64Strict, decodeUtf8Command, oneLine, isValidDomain,
} from './envelope.js';
import { hasDsnRequest } from './dsn-params.js';

const log = createLogger('smtp:session');

/** 9.4: AUTH with correct credentials while submission is switched off for the account. */
export const SUBMISSION_DISABLED_REPLY = '535 5.7.1 Mail submission is disabled for this account';
const SUBMISSION_DISABLED_NOTICE = 'Mail submission has been disabled for this account';
const CREDENTIALS_CHANGED_NOTICE = 'Credentials changed, please authenticate again';

// RFC 5321 §4.5.3.2 timeouts (milliseconds)
/** Default idle timeout for the greeting reply / next command (config.commandTimeoutMs overrides). */
const T_COMMAND  = 5 * 60_000;
/** Data block timeout: restarted for every received chunk (§4.5.3.2.6). */
const T_DATA     = 10 * 60_000;
/** STARTTLS: the client must complete the TLS handshake within this time. */
const T_TLS_HANDSHAKE = 60_000;

// RFC 5321 §4.5.3.1 — max command line length (octets)
const MAX_LINE = 1000;

// Hard cap for an unterminated line in the input buffer. Lines above MAX_LINE
// are answered with 500 once their CRLF arrives; a peer that never sends CRLF
// would otherwise grow the buffer without limit (memory exhaustion / RangeError).
const MAX_UNTERMINATED_COMMAND = 64 * 1024;

/**
 * Flow control: at most this many commands wait in the command queue; beyond
 * that the socket is paused and the input buffer is not parsed further until
 * the queue drains (a pipelining client cannot pile up handlers and replies
 * behind a tarpit delay).
 */
export const MAX_QUEUED_COMMANDS = 100;

/** While flow-paused the socket is not read; the unparsed buffer is still capped. */
const MAX_PAUSED_BUFFER = 16 * MAX_UNTERMINATED_COMMAND;

/**
 * Builds the reply line for a rejection string returned by a handler.
 *  - "452 4.2.2 …" / "550 5.7.1 …"  → passed through unchanged (own reply code)
 *  - "4.3.0 …"                       → transient: "<transientCode> 4.3.0 …"
 *  - "5.1.1 …" or free text          → permanent: "<permanentCode> …"
 * The reply-code class follows the enhanced status code class
 * (RFC 3463 §2, RFC 2034 §4); 4yz must stay transient (RFC 5321 §4.2.1).
 */
export function formatRejectReply(reject: string, permanentCode = 550, transientCode = 451): string {
  // One reply line only: an embedded CR/LF would break the reply framing (§4.2).
  const text = oneLine(reject);
  if (/^[45]\d\d(?: |-|$)/.test(text)) return text.replace(/^(\d{3})-/, '$1 ');
  if (/^4\.\d{1,3}\.\d{1,3}\b/.test(text)) return `${transientCode} ${text}`;
  return `${permanentCode} ${text}`;
}

/**
 * RFC 5321 §4.2 / §4.3.1 — greeting = "220 " (Domain / address-literal) [SP textstring].
 * A configured banner replaces the text; when it does not start with a domain
 * of its own, the server host name is put in front so the greeting always
 * identifies the host.
 */
export function greetingText(hostname: string, bannerText?: string): string {
  const banner = oneLine(bannerText ?? '');
  if (!banner) return `${hostname} ESMTP CoreMail`;
  const first = banner.split(' ')[0] ?? '';
  return first.includes('.') && isValidDomain(first) ? banner : `${hostname} ${banner}`;
}

function sameIdentity(authzid: string, ...identities: string[]): boolean {
  const wanted = authzid.trim().toLowerCase();
  return identities.some((id) => id.trim().toLowerCase() === wanted);
}

/** Permanent errors in a session before the tarpit starts. */
export const TARPIT_THRESHOLD = 3;

/**
 * Pure: tarpit delay before the next reply — 0 below the threshold, then
 * 1 s, 2 s, … per further error, capped at `maxMs`.
 */
export function tarpitDelayMs(errors: number, maxMs: number | undefined): number {
  if (!maxMs || maxMs <= 0 || errors < TARPIT_THRESHOLD) return 0;
  return Math.min(maxMs, (errors - TARPIT_THRESHOLD + 1) * 1000);
}

/** Max tarpit delay for port 25 from `SMTP_TARPIT_MAX_DELAY_MS` (default 5000, 0 = off, cap 30 s). */
export function inboundTarpitMaxDelayMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env['SMTP_TARPIT_MAX_DELAY_MS'] ?? '').trim();
  if (raw === '') return 5000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 30_000) : 5000;
}

/**
 * Replies counted by the tarpit: 5yz, except the 554 closing reply. A
 * multi-line reply counts once — only its last line ("5yz " / bare "5yz"),
 * never the "5yz-" continuation lines.
 */
export function isTarpitError(line: string): boolean {
  return /^5\d\d(?: |$)/.test(line) && !/^554(?: |$)/.test(line);
}

/** True when a handler error carries an SMTP reply ("550 …" or an enhanced code "5.7.1 …"). */
function isReplyError(message: string): boolean {
  return /^[45]\d\d(?: |-|$)/.test(message) || /^[45]\.\d{1,3}\.\d{1,3}\b/.test(message);
}

/** RFC 3030 §2: `BDAT SP chunk-size [SP end-marker]`, chunk-size = 1*DIGIT, end-marker = "LAST". */
export function parseBdatArgs(args: string): { size: number; last: boolean } | null {
  const m = /^(\d{1,15})(?: +(LAST))? *$/i.exec(args);
  if (!m) return null;
  const size = Number(m[1]);
  return Number.isSafeInteger(size) ? { size, last: m[2] !== undefined } : null;
}

/** RFC 5321 §4.1.1.8 HELP — 214 reply lines (with enhanced codes, RFC 2034). */
export const HELP_LINES = [
  '214-2.0.0 CoreMail ESMTP server. Commands:',
  '214-2.0.0   EHLO HELO STARTTLS AUTH MAIL RCPT DATA BDAT RSET NOOP VRFY HELP QUIT',
  '214-2.0.0 Extensions: PIPELINING SIZE 8BITMIME BINARYMIME CHUNKING DSN SMTPUTF8 ENHANCEDSTATUSCODES',
  '214 2.0.0 See https://www.rfc-editor.org/rfc/rfc5321 for the protocol',
];

/** A BDAT chunk being read from the socket (exact octet count, RFC 3030 §2). */
interface BdatChunk {
  size: number;
  last: boolean;
  remaining: number;
  /** Chunk octets (latin1 string slices) — empty when the chunk is discarded. */
  parts: string[];
  /**
   * Read and dropped without buffering: `size` = over the size limit,
   * `sequence` = no transaction with an accepted (or still queued) recipient.
   */
  discard: false | 'size' | 'sequence';
  /** Read-side transaction generation (MAIL/RSET/EHLO/HELO/STARTTLS bump it). */
  gen: number;
}

/**
 * Auth context stored during multi-step AUTH exchange.
 */
interface AuthCtx {
  mechanism: AuthMechanism;
  step: number;
  username?: string;
}

export class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private readonly config: SmtpSessionConfig;
  private readonly id: string;

  private state: SmtpState = 'INIT';
  /** EHLO/HELO argument (trace header). */
  private greeting: string = '';
  /** The client greeted with EHLO (ESMTP) rather than HELO. */
  private esmtpSession = false;
  private authUser: AuthUser | null = null;
  private authCtx: AuthCtx | null = null;
  private transaction: Transaction | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lineBuffer: string = '';
  private tlsUpgraded: boolean = false;
  private ip: string = '';

  // DATA mode: are we inside the message body accumulation?
  private inData: boolean = false;

  // DATA mode: the size limit was exceeded — keep consuming (and discarding)
  // body lines until the terminator, then answer with a single 552
  // (RFC 5321 §4.1.1.4, §4.5.3.1.10). Never switch back to command mode early.
  private dataOverflow: boolean = false;

  // Set once the connection is being torn down (oversized line).
  private closing: boolean = false;

  /** A delayed 220 greeting has not been sent yet (config.greetingDelayMs). */
  private greetingPending: boolean = false;
  /** Timer of the delayed greeting — cleared when the socket closes. */
  private greetingTimer: NodeJS.Timeout | null = null;

  /**
   * BDAT chunk currently being read. Chunk octets are taken from the input
   * synchronously (they follow the command line immediately, also when
   * pipelined); the chunk is then handed to the command queue.
   */
  private bdat: BdatChunk | null = null;

  /**
   * Octets announced by BDAT since the last MAIL/RSET/EHLO/HELO/LAST, counted
   * at read time — chunks beyond the size limit are dropped while reading
   * instead of being buffered (memory bound before the queue sees them).
   */
  private bdatAnnounced = 0;

  /**
   * Read-side view of the transaction (what the queue WILL see once it has
   * run the commands read so far): bumped by MAIL/RSET/EHLO/HELO/STARTTLS.
   */
  private readGen = 0;
  /** An RCPT was read after the last MAIL (it may still be queued). */
  private readRcptInTx = false;
  /** RCPT commands read but not yet processed by the queue. */
  private queuedRcpt = 0;
  /** Commands waiting in (or running in) the command queue. */
  private queuedCommands = 0;
  /** BDAT chunks waiting in (or running in) the command queue. */
  private queuedBdat = 0;
  /** The socket was paused by flow control. */
  private flowPaused = false;
  /** BDAT octets held in memory (being read or queued) — and the session peak. */
  private bdatBuffered = 0;
  private peakBdatBuffered = 0;
  private peakQueued = 0;

  /**
   * Command queue — serializes async command processing to prevent PIPELINING
   * race conditions (RFC 2920). Without this, pipelined MAIL FROM + RCPT TO
   * arrive together: handleMailFrom() awaits onMailFrom() DB call, but RCPT TO
   * is dispatched immediately while state is still 'READY' → 503.
   *
   * All commands are enqueued here and run strictly in order.
   */
  private cmdQueue: Promise<void> = Promise.resolve();

  /**
   * Bumped by STARTTLS. Commands that were received (and queued) before the
   * TLS handshake carry an older epoch and are discarded — pipelined plaintext
   * after STARTTLS must never run inside the TLS session (CVE-2011-0411 class).
   */
  private epoch = 0;

  /** Failed AUTH attempts in this session (421 + disconnect at the limit). */
  private authFailures = 0;

  /** Permanent (5yz) replies sent in this session — tarpit counter. */
  private permanentErrors = 0;

  /**
   * v7.1.0: the credentials of the authenticated user changed. Queued commands
   * no longer run; a message body that is being received is read to its end and
   * then rejected (the session closes with 421 instead of accepting it).
   */
  private terminating = false;
  private terminateAfterData = false;
  /** Text of the closing 421 (9.4: differs when submission was switched off). */
  private terminationNotice = CREDENTIALS_CHANGED_NOTICE;
  private unregisterLive: (() => void) | null = null;

  /** 10.2: connection facts for the message trace. */
  private readonly connectedAt: Date;
  private readonly connectNotes: readonly TraceStage[];

  constructor(socket: net.Socket | tls.TLSSocket, config: SmtpSessionConfig, init: SessionInit = {}) {
    this.socket = socket;
    this.config = config;
    this.id = crypto.randomUUID().slice(0, 8).toUpperCase();
    this.connectedAt = init.connectedAt ?? new Date();
    this.connectNotes = init.connectNotes ?? [];
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    this.ip = this.socket.remoteAddress ?? '0.0.0.0';
    // Implicit TLS (port 465): the connection is encrypted from the start.
    this.tlsUpgraded = (this.socket as tls.TLSSocket).encrypted === true;
    log.debug({ id: this.id, ip: this.ip }, 'SMTP session start');

    this.socket.setEncoding('binary'); // handle raw bytes via string; we buffer lines ourselves
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (err) => {
      log.debug({ id: this.id, ip: this.ip, err }, 'Socket error');
    });
    this.socket.on('close', () => {
      this.clearTimer();
      if (this.greetingTimer) { clearTimeout(this.greetingTimer); this.greetingTimer = null; }
      this.greetingPending = false;
      this.unregisterLive?.();
      this.unregisterLive = null;
      log.debug({ id: this.id }, 'Socket closed');
    });

    this.resetTimer(this.commandTimeout());
    const delayMs = this.config.greetingDelayMs ?? 0;
    if (delayMs > 0) {
      // Greeting delay (inbound): hold the 220; a client that talks first is
      // not RFC 5321 compliant (pre-greeting traffic) and is refused in onData.
      this.greetingPending = true;
      this.greetingTimer = setTimeout(() => {
        this.greetingTimer = null;
        if (!this.greetingPending || this.closing) return;
        this.greetingPending = false;
        this.send(`220 ${greetingText(this.config.hostname, this.config.bannerText)}`);
      }, delayMs);
      this.greetingTimer.unref?.();
      return;
    }
    this.send(`220 ${greetingText(this.config.hostname, this.config.bannerText)}`);
  }

  /** Idle timeout for the greeting reply / next command (SmtpSettings.connectionTimeoutSec). */
  private commandTimeout(): number {
    const ms = this.config.commandTimeoutMs;
    return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : T_COMMAND;
  }

  // ─── Timer ──────────────────────────────────────────────────────────────────

  private resetTimer(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.send(`421 4.4.2 ${this.config.hostname} Timeout - closing connection`);
      this.socket.destroy();
      log.info({ id: this.id, ip: this.ip }, 'SMTP session timed out');
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ─── Command Queue ───────────────────────────────────────────────────────────

  /**
   * Enqueues an SMTP command handler to run strictly after the previous one
   * completes. This is the fix for PIPELINING race conditions: without a queue,
   * async handlers (onMailFrom, onRcptTo) suspend mid-execution and the next
   * pipelined command sees stale state.
   */
  private enqueueCommand(fn: () => Promise<void> | void, opts: { noTarpit?: boolean; kind?: 'bdat' | 'rcpt' } = {}): void {
    const epoch = this.epoch;
    this.queuedCommands++;
    this.peakQueued = Math.max(this.peakQueued, this.queuedCommands);
    if (opts.kind === 'bdat') this.queuedBdat++;
    if (opts.kind === 'rcpt') this.queuedRcpt++;
    const done = (): void => {
      this.queuedCommands--;
      if (opts.kind === 'bdat') this.queuedBdat--;
      if (opts.kind === 'rcpt') this.queuedRcpt--;
      this.updateFlow();
    };
    this.cmdQueue = this.cmdQueue.then(async () => {
      // Skip if session already terminated
      if (this.state === 'QUIT' || this.terminating) return;
      // Received before a STARTTLS that has since been executed → discard.
      if (epoch !== this.epoch) return;
      // Tarpit: a client that keeps producing errors (dictionary attack,
      // broken spam bot) waits before each further reply. QUIT and RSET are
      // never delayed — a client that gives up or resets must not be held.
      const delay = this.authUser || opts.noTarpit ? 0 : tarpitDelayMs(this.permanentErrors, this.config.tarpitMaxDelayMs);
      if (delay > 0) {
        await new Promise<void>((r) => setTimeout(r, delay));
        if ((this.state as SmtpState) === 'QUIT' || this.terminating || this.socket.destroyed) return;
      }
      await (fn() ?? Promise.resolve());
    }).catch(() => {
      // Errors are handled inside each handler — they send their own error
      // responses and never propagate to the queue chain.
    }).finally(done);
  }

  /** Flow-control counters (tests / diagnostics). */
  flowStats(): { queued: number; peakQueued: number; bdatBuffered: number; peakBdatBuffered: number } {
    return {
      queued: this.queuedCommands, peakQueued: this.peakQueued,
      bdatBuffered: this.bdatBuffered, peakBdatBuffered: this.peakBdatBuffered,
    };
  }

  /** Too much queued work: stop reading until the queue drains. */
  private flowBlocked(): boolean {
    return this.queuedCommands >= MAX_QUEUED_COMMANDS || this.queuedBdat > 1;
  }

  /** Pauses / resumes the socket after the queue changed. */
  private updateFlow(): void {
    if (this.closing || this.state === 'QUIT') return;
    if (this.flowBlocked()) {
      if (!this.flowPaused) {
        this.flowPaused = true;
        this.socket.pause();
      }
      return;
    }
    if (!this.flowPaused) return;
    this.flowPaused = false;
    // Parse what is already buffered first, then read from the socket again.
    this.processInput();
    if (!this.flowPaused && !this.socket.destroyed) this.socket.resume();
  }

  // ─── Send ────────────────────────────────────────────────────────────────────

  private send(line: string): void {
    if (isTarpitError(line)) this.permanentErrors++;
    if (this.socket.writable) {
      this.socket.write(`${line}\r\n`);
    }
  }

  // ─── Data handler ────────────────────────────────────────────────────────────

  private onData(chunk: string): void {
    if (this.closing) return;
    if (this.greetingPending) {
      // Pre-greeting traffic (client talked before the delayed 220).
      this.greetingPending = false;
      this.closing = true;
      this.clearTimer();
      this.send('554 5.5.0 SMTP protocol violation: client sent data before the greeting');
      this.socket.end();
      log.info({ id: this.id, ip: this.ip }, 'SMTP: pre-greeting traffic — connection closed');
      return;
    }
    // RFC 5321 §4.5.3.2.6: the data block timeout runs per received chunk, not
    // for the whole message — a slow but progressing upload must not time out.
    if (this.inData || this.bdat) this.resetTimer(T_DATA);
    this.lineBuffer += chunk;
    this.processInput();
  }

  /** Parses the input buffer (also called when flow control releases it). */
  private processInput(): void {
    let blocked = false;
    while (!this.closing) {
      if (this.bdat) {
        // Exact octet count — no line parsing, no dot-stuffing (RFC 3030 §2).
        if (!this.consumeBdatChunk()) break;
        continue;
      }
      // Command boundary: with too much queued work, stop parsing and stop
      // reading (the rest stays buffered until the queue drains).
      if (!this.inData && this.flowBlocked()) {
        blocked = true;
        if (!this.flowPaused) {
          this.flowPaused = true;
          this.socket.pause();
        }
        break;
      }
      const crlf = this.lineBuffer.indexOf('\r\n');
      if (crlf === -1) break;

      const line = this.lineBuffer.slice(0, crlf);
      this.lineBuffer = this.lineBuffer.slice(crlf + 2);

      if (this.inData) {
        this.handleDataLine(line);
      } else {
        this.handleCommandLine(line);
      }
    }

    // Hard cap on the unterminated remainder: 64 KiB in command mode, the
    // maximum message size in data mode (a single body line can never be
    // larger than the whole message).
    // While flow-paused the buffer holds complete, not yet parsed commands;
    // the socket is not read, so only a generous safety cap applies.
    const limit = this.inData
      ? Math.max(this.config.maxSize, MAX_UNTERMINATED_COMMAND)
      : blocked ? MAX_PAUSED_BUFFER : MAX_UNTERMINATED_COMMAND;
    if (!this.closing && this.lineBuffer.length > limit) {
      this.closeForOversizedLine();
    }
  }

  /**
   * Moves up to the remaining chunk octets from the input buffer into the
   * current BDAT chunk. Returns false while more octets are needed (or the
   * session closed); true when the chunk is complete and queued.
   */
  private consumeBdatChunk(): boolean {
    const chunk = this.bdat!;
    const take = Math.min(chunk.remaining, this.lineBuffer.length);
    if (take > 0) {
      if (!chunk.discard) {
        chunk.parts.push(this.lineBuffer.slice(0, take));
        this.bdatBuffered += take;
        this.peakBdatBuffered = Math.max(this.peakBdatBuffered, this.bdatBuffered);
      }
      this.lineBuffer = this.lineBuffer.slice(take);
      chunk.remaining -= take;
    }
    if (chunk.remaining > 0) return false;
    this.bdat = null;
    if (this.terminateAfterData) {
      // v7.1.0: credentials changed during the transfer — not accepted.
      this.closeForCredentialChange();
      return false;
    }
    const data = chunk.discard ? null : Buffer.from(chunk.parts.join(''), 'latin1');
    this.enqueueCommand(async () => {
      try { await this.handleBdatChunk(chunk, data); } finally {
        if (!chunk.discard) this.bdatBuffered -= chunk.size;
      }
    }, { kind: 'bdat' });
    this.resetTimer(this.commandTimeout());
    return true;
  }

  /** Synchronous part of BDAT: parse the size and start reading the chunk octets. */
  private startBdat(args: string): void {
    const esmtp = this.extensions();
    if (!esmtp.chunking) {
      this.enqueueCommand(() => { this.send('500 5.5.1 Command not recognized: BDAT'); });
      return;
    }
    const parsed = parseBdatArgs(args);
    if (!parsed) {
      // Without a valid size the chunk boundary is unknown: nothing is
      // consumed, the client must reset (RFC 3030 §2: 501).
      this.enqueueCommand(() => { this.send('501 5.5.4 Syntax: BDAT <chunk-size> [LAST]'); });
      return;
    }
    // Octets are only buffered for a transaction that has (or, pipelined, is
    // about to get) an accepted recipient. Anything else — no MAIL, a rejected
    // RCPT, chunks after LAST — is read and dropped: no memory before MAIL/RCPT.
    let discard: BdatChunk['discard'] = false;
    if (!this.readRcptInTx || (this.queuedRcpt === 0 && (this.transaction?.rcptTo.length ?? 0) === 0)) {
      discard = 'sequence';
    } else {
      this.bdatAnnounced += parsed.size;
      if (this.bdatAnnounced > this.config.maxSize) discard = 'size';
    }
    this.bdat = { size: parsed.size, last: parsed.last, remaining: parsed.size, parts: [], discard, gen: this.readGen };
    // After LAST the transaction is over: further chunks are a bad sequence.
    if (parsed.last) this.readRcptInTx = false;
    this.resetTimer(T_DATA);
  }

  /** Queued part of BDAT: sequence checks, size limit, then 250 or delivery on LAST. */
  private async handleBdatChunk(chunk: BdatChunk, data: Buffer | null): Promise<void> {
    const tx = this.transaction;
    this.resetTimer(this.commandTimeout());
    // RFC 3030 §2: BDAT needs an open transaction with a recipient; after
    // BDAT LAST (or a failed chunk) it is a bad sequence until RSET/MAIL.
    if (!tx || (this.state !== 'RCPT' && this.state !== 'BDAT') || chunk.discard === 'sequence') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }
    tx.size += chunk.size;
    if (chunk.discard || data === null || tx.size > this.config.maxSize) {
      // The chunk was read completely; the transaction is aborted (RFC 1870 §6 / RFC 3030 §4.2).
      this.transaction = null;
      this.state = 'READY';
      this.send('552 5.3.4 Message exceeds size limit');
      return;
    }
    tx.data.push(data);
    if (!chunk.last) {
      this.state = 'BDAT';
      this.send(`250 2.0.0 ${chunk.size} octets received`);
      return;
    }
    // LAST accepted: the read-time size count starts over — unless a newer
    // transaction was already read meanwhile (it reset the count itself).
    if (chunk.gen === this.readGen) this.bdatAnnounced = 0;
    await this.finishData(true);
  }

  /** Effective ESMTP extension flags. */
  private extensions(): EsmtpExtensions {
    return this.config.esmtp ?? DEFAULT_ESMTP_EXTENSIONS;
  }

  private closeForOversizedLine(): void {
    this.closing = true;
    this.lineBuffer = '';
    this.bdat = null;
    this.transaction = null;
    this.inData = false;
    this.dataOverflow = false;
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`500 5.5.6 Line too long - closing connection`);
    this.socket.end();
    log.warn({ id: this.id, ip: this.ip }, 'SMTP line exceeds hard limit — connection closed');
  }

  // ─── DATA accumulation ───────────────────────────────────────────────────────

  private handleDataLine(line: string): void {
    // Dot-stuffing terminator: single dot on its own line
    if (line === '.') {
      this.inData = false;
      if (this.terminateAfterData) {
        // v7.1.0: credentials changed during the transfer — not accepted.
        this.closeForCredentialChange();
        return;
      }
      if (this.dataOverflow) {
        // Oversized message fully consumed — exactly one reply, then back to
        // command mode with the transaction discarded.
        this.dataOverflow = false;
        this.enqueueCommand(() => {
          this.transaction = null;
          this.state = 'READY';
          this.resetTimer(this.commandTimeout());
          this.send('552 5.3.4 Message exceeds size limit');
        });
        return;
      }
      // Enqueue finishData so that any pipelined commands after the "."
      // (e.g. QUIT or a new MAIL FROM) wait for delivery to complete first.
      this.enqueueCommand(() => this.finishData());
      return;
    }

    // Discard mode: keep the timer alive but do not buffer anything.
    if (this.dataOverflow) {
      this.resetTimer(T_DATA);
      return;
    }

    // Transparency (RFC 5321 §4.5.2): the first character of a line that starts
    // with a period is deleted — not only for "..".
    const actual = line.startsWith('.') ? line.slice(1) : line;
    const raw = Buffer.from(actual + '\r\n', 'binary');

    if (this.transaction) {
      this.transaction.size += raw.length;

      if (this.transaction.size > this.config.maxSize) {
        // Do NOT leave DATA mode here: the rest of the body would otherwise
        // be parsed as SMTP commands (command injection). Drop what was
        // buffered and discard further lines until "." arrives.
        this.dataOverflow = true;
        this.transaction.data = [];
        this.resetTimer(T_DATA);
        return;
      }

      this.transaction.data.push(raw);
    }
  }

  /**
   * Hands the complete message (DATA terminator or BDAT LAST) to the message
   * handler — the same path for both transfer modes (filter, delivery, tarpit).
   */
  private async finishData(chunking = false): Promise<void> {
    const tx = this.transaction;
    if (!tx) {
      this.send('451 4.3.0 Internal error');
      this.resetTimer(this.commandTimeout());
      return;
    }

    const raw = Buffer.concat(tx.data);
    const from = tx.from;
    const to = [...tx.rcptTo];
    const authUser = this.authUser;
    const ip = this.ip;
    const meta = this.messageMeta(tx, chunking);

    // Reset transaction state before calling handler (handler may take time)
    this.transaction = null;
    this.state = 'READY';
    this.resetTimer(this.commandTimeout());

    try {
      await this.config.handlers.onMessage(raw, from, to, authUser, ip, meta);
      // A delivered message (DATA or BDAT) proves a legitimate sender: the
      // tarpit starts over (a cached MTA connection is not punished for the
      // unknown recipients of earlier messages).
      this.permanentErrors = 0;
      this.send('250 2.0.0 OK');
      log.info({ id: this.id, from, rcpt: to, size: raw.length }, 'Message accepted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // A message that starts with its own 4yz/5yz reply code is a deliberate
      // reply (a reply line carries exactly one code, RFC 5321 §4.2); a bare
      // enhanced code keeps its class. Anything else is an internal error:
      // a fixed 451 text, never the raw message (multi-line, internals).
      this.send(isReplyError(msg) ? formatRejectReply(msg, 554, 451) : '451 4.3.0 Temporary local problem, try again later');
      log.error({ id: this.id, err }, 'onMessage handler error');
    }
  }

  /** Trace data for the Received: header (RFC 5321 §4.4, RFC 3848). */
  private messageMeta(tx: Transaction, chunking: boolean): MessageMeta {
    // RFC 6531 §3.7.3: SMTPUTF8 transactions use the UTF8SMTP* "with" keywords.
    const base = tx.smtputf8 ? 'UTF8SMTP' : 'ESMTP';
    const protocol: MessageMeta['protocol'] = !this.esmtpSession
      ? 'SMTP'
      : `${base}${this.tlsUpgraded ? 'S' : ''}${this.authUser ? 'A' : ''}` as MessageMeta['protocol'];
    return {
      helo: this.greeting, protocol, hostname: this.config.hostname, sessionId: this.id,
      envelope: {
        smtputf8: tx.smtputf8,
        body: tx.body,
        chunking,
        ...(hasDsnRequest(tx.dsn) ? { dsn: tx.dsn } : {}),
      },
      connection: connectionFacts({
        socket: this.socket as tls.TLSSocket,
        tls: this.tlsUpgraded,
        authUser: this.authUser?.email,
        connectedAt: this.connectedAt,
        notes: [...this.connectNotes, ...(tx.notes ?? [])],
      }),
    };
  }

  // ─── Command dispatch ────────────────────────────────────────────────────────

  private handleCommandLine(line: string): void {
    // RFC 5321 §4.5.3.1 — max line length
    if (line.length > MAX_LINE) {
      this.send('500 5.5.6 Line too long');
      this.resetTimer(this.commandTimeout());
      return;
    }

    // AUTH_WAIT: multi-step AUTH exchange — enqueue like all other commands
    // so that concurrent pipelined commands don't race against auth state.
    if (this.state === 'AUTH_WAIT') {
      this.resetTimer(this.commandTimeout());
      this.enqueueCommand(() => this.handleAuthStep(line));
      return;
    }

    // Split command and arguments
    const spaceIdx = line.indexOf(' ');
    const cmd  = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toUpperCase().trim();
    const args = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();

    this.resetTimer(this.commandTimeout());

    // A new transaction (or its reset) restarts the BDAT read-time size count.
    if (cmd === 'MAIL' || cmd === 'RSET' || cmd === 'EHLO' || cmd === 'HELO') {
      this.bdatAnnounced = 0;
      this.readGen++;
      this.readRcptInTx = false;
    }
    if (cmd === 'RCPT') this.readRcptInTx = true;

    // ALL commands go through the queue — this serializes async handlers
    // (onMailFrom, onRcptTo) so that pipelined commands always see the correct
    // state set by the previous command. Without this, RCPT TO arrives while
    // MAIL FROM's onMailFrom() is still awaiting, sees state='READY' → 503.
    // BDAT is the exception for its octets only: they follow the command line
    // directly and are read now (startBdat); the chunk is then queued.
    switch (cmd) {
      case 'EHLO':    this.enqueueCommand(() => this.handleEhlo(args)); break;
      case 'HELO':    this.enqueueCommand(() => this.handleHelo(args)); break;
      case 'AUTH':    this.enqueueCommand(() => this.handleAuth(args)); break;
      case 'STARTTLS':this.enqueueCommand(() => this.handleStarttls(args)); break;
      case 'MAIL':    this.enqueueCommand(() => this.handleMailFrom(args)); break;
      case 'RCPT':    this.enqueueCommand(() => this.handleRcptTo(args), { kind: 'rcpt' }); break;
      case 'DATA':    this.enqueueCommand(() => this.handleDataCommand()); break;
      case 'BDAT':    this.startBdat(args); break;
      case 'HELP':    this.enqueueCommand(() => { for (const l of HELP_LINES) this.send(l); }); break;
      case 'RSET':    this.enqueueCommand(() => this.handleRset(), { noTarpit: true }); break;
      case 'NOOP':    this.enqueueCommand(() => { this.send('250 2.0.0 OK'); }); break;
      // RFC 5321 §3.5.3 / §7.3: VRFY is part of the minimum implementation; a
      // server that does not verify addresses answers 252, never 502.
      case 'VRFY':    this.enqueueCommand(() => {
        this.send(args ? '252 2.5.0 Cannot VRFY user, but will accept message and attempt delivery' : '501 5.5.4 Syntax: VRFY <address>');
      }); break;
      case 'EXPN':    this.enqueueCommand(() => { this.send('502 5.5.1 EXPN not supported'); }); break;
      case 'QUIT':    this.enqueueCommand(() => this.handleQuit(), { noTarpit: true }); break;
      default:
        this.enqueueCommand(() => { this.send(`500 5.5.1 Command not recognized: ${cmd}`); });
    }
  }

  // ─── EHLO ────────────────────────────────────────────────────────────────────

  private handleEhlo(clientName: string): void {
    // RFC 5321 §4.1.1.1: ehlo = "EHLO" SP ( Domain / address-literal ) — mandatory.
    if (!clientName) {
      this.send('501 5.5.4 Syntax: EHLO <domain>');
      return;
    }
    this.greeting = clientName;
    this.esmtpSession = true;
    this.transaction = null;

    const esmtp = this.extensions();
    const lines: string[] = [`${this.config.hostname}`];

    // Order as Exchange 2019 (port 25): SIZE, PIPELINING, DSN, ENHANCEDSTATUSCODES,
    // STARTTLS, 8BITMIME, BINARYMIME, CHUNKING, SMTPUTF8 (+ AUTH after TLS).
    if (esmtp.size)           lines.push(`SIZE ${this.config.maxSize}`);
    if (esmtp.pipelining)     lines.push('PIPELINING');
    if (esmtp.dsn)            lines.push('DSN');
    if (esmtp.enhancedStatus) lines.push('ENHANCEDSTATUSCODES');

    // STARTTLS only if TLS configured AND extension enabled AND not yet upgraded
    // AND advertiseStarttls != false. On port 25 with a self-signed cert the server suppresses
    // this so that strict MTAs (Microsoft Exchange) do not get stuck in the TLS handshake.
    const advertise = this.config.advertiseStarttls !== false;
    if (esmtp.starttls && this.config.tls && !this.tlsUpgraded && advertise) {
      lines.push('STARTTLS');
    }
    if (esmtp.bit8mime)       lines.push('8BITMIME');
    // BINARYMIME is only usable with BDAT (RFC 3030 §3) — advertised together.
    if (esmtp.chunking)       lines.push('BINARYMIME', 'CHUNKING');
    if (esmtp.smtputf8)       lines.push('SMTPUTF8');

    // AUTH only if verifyCredentials is configured AND at least one mech enabled
    // AND the connection is encrypted (implicit TLS or after STARTTLS) — v7:
    // credentials are never accepted in plaintext (RFC 4954 §4, RFC 8314).
    // CRAM-MD5 is not advertised — handleAuth only recognizes PLAIN + LOGIN, CRAM-MD5
    // would be rejected with 504 Unrecognized.
    if (this.config.verifyCredentials && this.tlsUpgraded) {
      const mechs: string[] = [];
      if (esmtp.authPlain)   mechs.push('PLAIN');
      if (esmtp.authLogin)   mechs.push('LOGIN');
      if (mechs.length > 0) lines.push(`AUTH ${mechs.join(' ')}`);
    }

    // Build multi-line response
    for (let i = 0; i < lines.length - 1; i++) {
      this.send(`250-${lines[i]}`);
    }
    this.send(`250 ${lines[lines.length - 1]}`);

    this.state = 'READY';
  }

  // ─── HELO ────────────────────────────────────────────────────────────────────

  private handleHelo(clientName: string): void {
    if (!clientName) {
      this.send('501 5.5.4 Syntax: HELO <domain>');
      return;
    }
    this.greeting = clientName;
    this.esmtpSession = false;
    this.transaction = null;
    this.send(`250 ${this.config.hostname}`);
    this.state = 'READY';
  }

  // ─── AUTH ────────────────────────────────────────────────────────────────────

  private handleAuth(args: string): Promise<void> {
    if (this.state !== 'READY') {
      this.send('503 5.5.1 Bad sequence of commands');
      return Promise.resolve();
    }

    if (!this.config.verifyCredentials) {
      this.send('502 5.5.1 AUTH not supported');
      return Promise.resolve();
    }

    if (this.authUser) {
      this.send('503 5.7.0 Already authenticated');
      return Promise.resolve();
    }

    // v7: no credentials over an unencrypted connection (RFC 4954 §6 — 538).
    if (!this.tlsUpgraded) {
      this.send('538 5.7.11 Encryption required for requested authentication mechanism (use STARTTLS)');
      return Promise.resolve();
    }

    const parts = args.split(' ');
    const mechanism = (parts[0] ?? '').toUpperCase() as AuthMechanism;
    const initialResponse = parts[1] ?? '';

    if (mechanism === 'PLAIN') {
      return this.handleAuthPlain(initialResponse);
    } else if (mechanism === 'LOGIN') {
      return this.handleAuthLoginStart(initialResponse);
    } else {
      this.send('504 5.5.4 Unrecognized authentication type');
      return Promise.resolve();
    }
  }

  private async handleAuthPlain(initialResponse: string): Promise<void> {
    if (!initialResponse) {
      // Two-step: send empty challenge, wait for client response
      this.authCtx = { mechanism: 'PLAIN', step: 1 };
      this.state = 'AUTH_WAIT';
      this.send('334 ');
      return;
    }

    // Inline: decode immediately
    await this.verifyPlainCredentials(initialResponse);
  }

  private async handleAuthLoginStart(initialResponse = ''): Promise<void> {
    if (initialResponse && initialResponse !== '=') {
      // "AUTH LOGIN <base64 username>" — widespread client behaviour: continue
      // directly with the password prompt.
      const username = decodeBase64Strict(initialResponse);
      if (!username) {
        this.send('501 5.5.2 Cannot decode response');
        return;
      }
      this.authCtx = {
        mechanism: 'LOGIN',
        step: 2,
        username: username.toString('utf8'),
      };
      this.state = 'AUTH_WAIT';
      this.send('334 UGFzc3dvcmQ6');
      return;
    }
    this.authCtx = { mechanism: 'LOGIN', step: 1 };
    this.state = 'AUTH_WAIT';
    // "Username:"
    this.send('334 VXNlcm5hbWU6');
  }

  private async handleAuthStep(line: string): Promise<void> {
    // AUTH cancel
    if (line === '*') {
      this.authCtx = null;
      this.state = 'READY';
      this.send('501 5.7.0 Authentication cancelled');
      return;
    }

    const ctx = this.authCtx;
    if (!ctx) {
      this.state = 'READY';
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    if (ctx.mechanism === 'PLAIN') {
      this.authCtx = null;
      this.state = 'READY';
      await this.verifyPlainCredentials(line);
    } else if (ctx.mechanism === 'LOGIN') {
      // RFC 4954 §4: a response that is not valid base64 → 501, exchange ends.
      const decoded = decodeBase64Strict(line);
      if (!decoded) {
        this.authCtx = null;
        this.state = 'READY';
        this.send('501 5.5.2 Cannot decode response');
        return;
      }
      if (ctx.step === 1) {
        ctx.username = decoded.toString('utf8');
        ctx.step = 2;
        // "Password:"
        this.send('334 UGFzc3dvcmQ6');
      } else {
        const username = ctx.username ?? '';
        this.authCtx = null;
        this.state = 'READY';
        await this.verifyCredentials(username, decoded.toString('utf8'));
      }
    }
  }

  private async verifyPlainCredentials(b64: string): Promise<void> {
    const decoded = decodeBase64Strict(b64);
    if (!decoded) {
      this.send('501 5.5.2 Cannot decode response');
      return;
    }
    // RFC 4616 §2: message = [authzid] UTF8NUL authcid UTF8NUL passwd — exactly
    // three fields; anything else is a malformed message and fails.
    const parts = decoded.toString('utf8').split('\0');
    if (parts.length !== 3) {
      this.send('535 5.7.8 Authentication credentials invalid');
      return;
    }
    const [authzid = '', username = '', password = ''] = parts;
    await this.verifyCredentials(username, password, authzid);
  }

  /**
   * @param authzid PLAIN authorization identity. CoreMail has no proxy
   *   authorization: a non-empty authzid must name the authenticated user
   *   (RFC 4616 §2 — otherwise the authentication fails).
   */
  private async verifyCredentials(username: string, password: string, authzid = ''): Promise<void> {
    if (!this.config.verifyCredentials) {
      this.send('535 5.7.8 Authentication credentials invalid');
      return;
    }

    const authStartedAt = Date.now();
    try {
      const result = await this.config.verifyCredentials(username.toLowerCase().trim(), password, this.ip);
      if (result && 'failure' in result && result.failure === 'protocol_disabled') {
        // 9.4: correct credentials, submission switched off for the account.
        this.send(SUBMISSION_DISABLED_REPLY);
        log.warn({ id: this.id, ip: this.ip, username }, 'SMTP auth refused — submission disabled for this account');
      } else if (result && 'failure' in result) {
        // Lockout or temporary failure (database down …) — RFC 4954 §6: 454 4.7.0.
        this.send(result.failure === 'locked'
          ? '454 4.7.0 Too many failed authentication attempts, try again later'
          : '454 4.7.0 Temporary authentication failure');
        log.warn({ id: this.id, ip: this.ip, username, failure: result.failure }, 'SMTP auth not possible');
        if (result.failure === 'locked') this.countAuthFailure();
      } else if (result && authzid && !sameIdentity(authzid, username, result.email)) {
        this.send('535 5.7.8 Authentication credentials invalid');
        log.warn({ id: this.id, ip: this.ip, username, authzid }, 'SMTP auth: authorization identity not allowed');
        this.countAuthFailure();
      } else if (result) {
        this.authUser = result;
        this.registerLive(result, authStartedAt);
        this.send('235 2.7.0 Authentication successful');
        log.info({ id: this.id, ip: this.ip, email: result.email }, 'SMTP auth success');
        return;
      } else {
        this.send('535 5.7.8 Authentication credentials invalid');
        log.warn({ id: this.id, ip: this.ip, username }, 'SMTP auth failed');
        this.countAuthFailure();
      }
    } catch (err) {
      log.error({ id: this.id, err }, 'verifyCredentials error');
      this.send('454 4.7.0 Temporary authentication failure');
    }
  }

  /** v7.1.0: the session ends when the credentials it authenticated with become invalid. */
  private registerLive(user: AuthUser, authStartedAt: number): void {
    this.unregisterLive?.();
    this.unregisterLive = smtpLiveSessions.register({
      userId: user.id,
      credential: user.credential ?? 'unknown',
      protocol: 'smtp',
      ...(user.appPasswordId ? { appPasswordId: user.appPasswordId } : {}),
      terminate: (event) => this.terminateForCredentialChange(event),
    }, authStartedAt);
  }

  /**
   * Credential change (9.4: or submission switched off): the command in
   * progress (e.g. delivery of a complete message) finishes, queued commands
   * are dropped, then 421 4.7.0 and close. During a DATA transfer the body is
   * consumed to its terminator first and the message is rejected — the
   * connection never closes mid-body.
   */
  private terminateForCredentialChange(event: AuthInvalidationEvent): void {
    this.unregisterLive = null;
    if (this.state === 'QUIT' || this.closing || this.terminating) return;
    this.terminating = true;
    if (event.reason === PROTOCOL_ACCESS_CHANGE) this.terminationNotice = SUBMISSION_DISABLED_NOTICE;
    this.cmdQueue = this.cmdQueue.then(() => {
      if (this.state === 'QUIT' || this.closing) return;
      if (this.inData || this.bdat) { this.terminateAfterData = true; return; }
      this.closeForCredentialChange();
    });
  }

  private closeForCredentialChange(): void {
    this.closing = true;
    this.terminateAfterData = false;
    this.lineBuffer = '';
    this.transaction = null;
    this.inData = false;
    this.bdat = null;
    this.dataOverflow = false;
    this.authUser = null;
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`421 4.7.0 ${this.config.hostname} ${this.terminationNotice} - closing connection`);
    this.socket.end();
    log.info({ id: this.id, ip: this.ip, notice: this.terminationNotice }, 'SMTP session closed after a credential change');
  }

  /** Closes the AUTH loop: after N failed attempts → 421 and disconnect. */
  private countAuthFailure(): void {
    this.authFailures += 1;
    const max = this.config.maxAuthFailures ?? 3;
    if (this.authFailures < max) return;
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`421 4.7.0 ${this.config.hostname} Too many authentication failures - closing connection`);
    this.socket.end();
    log.warn({ id: this.id, ip: this.ip, failures: this.authFailures }, 'SMTP: AUTH failure limit reached — connection closed');
  }

  // ─── STARTTLS ────────────────────────────────────────────────────────────────

  private async handleStarttls(args = ''): Promise<void> {
    if (!this.config.tls || this.config.advertiseStarttls === false) {
      this.send('502 5.5.1 STARTTLS not supported');
      return;
    }

    // RFC 3207 §4: STARTTLS takes no parameters → 501.
    if (args) {
      this.send('501 5.5.4 Syntax error (no parameters allowed)');
      return;
    }

    if (this.tlsUpgraded) {
      this.send('503 5.5.1 TLS already active');
      return;
    }

    if (this.state !== 'READY') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    // Discard everything the client pipelined after STARTTLS (CVE-2011-0411
    // class): queued commands of the old epoch are skipped, the unparsed
    // remainder of the plaintext buffer is dropped.
    this.epoch += 1;
    this.lineBuffer = '';
    // A BDAT chunk pipelined after STARTTLS must not swallow TLS records.
    this.bdat = null;
    this.bdatAnnounced = 0;
    this.readGen++;
    this.readRcptInTx = false;

    this.send('220 2.0.0 Ready to start TLS');

    // Remove existing data listener before upgrading
    this.socket.removeAllListeners('data');
    // The TLS layer must be able to read the handshake.
    if (this.flowPaused) {
      this.flowPaused = false;
      this.socket.resume();
    }

    const plainSocket = this.socket;
    const tlsSocket = new tls.TLSSocket(plainSocket, {
      isServer: true,
      // TLS 1.2+ unless this listener allows old clients (TLS 1.0/1.1).
      ...tlsServerOptions(this.config.tls, this.config.allowLegacyTls === true),
    });

    // A client that never completes the handshake must not hold the
    // connection forever (no SMTP reply is possible inside the handshake).
    this.clearTimer();
    this.timer = setTimeout(() => {
      log.info({ id: this.id, ip: this.ip }, 'STARTTLS handshake timed out');
      tlsSocket.destroy();
      plainSocket.destroy();
    }, T_TLS_HANDSHAKE);

    tlsSocket.once('secure', () => {
      // After TLS handshake: reset state per RFC 3207
      this.socket = tlsSocket;
      this.tlsUpgraded = true;
      this.state = 'INIT';
      this.greeting = '';
      this.esmtpSession = false;
      this.transaction = null;
      this.lineBuffer = '';
      this.bdat = null;
      this.authUser = null;
      this.authCtx = null;

      tlsSocket.setEncoding('binary');
      tlsSocket.on('data', (chunk: string) => this.onData(chunk));
      tlsSocket.on('error', (err) => {
        log.debug({ id: this.id, ip: this.ip, err }, 'TLS socket error');
      });

      this.resetTimer(this.commandTimeout());
      log.debug({ id: this.id }, 'STARTTLS upgrade complete');
    });

    tlsSocket.once('error', (err) => {
      logTlsSocketError(log, err, { service: 'SMTP STARTTLS', id: this.id, ip: this.ip });
      this.socket.destroy();
    });
  }

  // ─── MAIL FROM ───────────────────────────────────────────────────────────────

  private async handleMailFrom(args: string): Promise<void> {
    if (this.state !== 'READY') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    // RFC 4954: requireAuth
    if (this.config.requireAuth && !this.authUser) {
      this.send('530 5.7.0 Authentication required');
      return;
    }

    // RFC 5321 §4.1.1.2: "MAIL FROM:" keyword, path, then only parameters of
    // advertised extensions (SIZE, BODY, AUTH, SMTPUTF8, RET, ENVID) —
    // anything else is 555 (§4.1.1.11). UTF-8 is decoded strictly (RFC 6531).
    const esmtp = this.extensions();
    const decoded = decodeUtf8Command(args);
    if (decoded === null) {
      this.send('501 5.5.4 Invalid UTF-8 in command');
      return;
    }
    const parsed = parseMailFrom(decoded, { smtputf8: esmtp.smtputf8, dsn: esmtp.dsn, chunking: esmtp.chunking });
    if (!parsed.ok) {
      this.send(parsed.reply);
      return;
    }
    const addr = parsed.address;

    // RFC 1870 §6.1: a declared SIZE above the limit is refused up front.
    const declaredSize = Number(parsed.params.get('SIZE') ?? '0');
    if (declaredSize > this.config.maxSize) {
      this.send('552 5.3.4 Message exceeds maximum size');
      return;
    }

    try {
      const reject = await this.config.handlers.onMailFrom(addr, this.ip, this.authUser);
      if (reject !== null) {
        this.send(formatRejectReply(reject, 550, 451));
        return;
      }
    } catch (err) {
      log.error({ id: this.id, err }, 'onMailFrom error');
      this.send('451 4.3.0 Temporary failure');
      return;
    }

    this.transaction = {
      from: addr, rcptTo: [], data: [], size: 0,
      smtputf8: parsed.smtputf8,
      body: parsed.body,
      dsn: {
        ...(parsed.ret ? { ret: parsed.ret } : {}),
        ...(parsed.envid !== undefined ? { envid: parsed.envid } : {}),
      },
    };
    this.state = 'MAIL';
    this.send(`250 2.1.0 OK`);
  }

  // ─── RCPT TO ─────────────────────────────────────────────────────────────────

  private async handleRcptTo(args: string): Promise<void> {
    if (this.state !== 'MAIL' && this.state !== 'RCPT') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    const tx = this.transaction;
    if (!tx) {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    if (tx.rcptTo.length >= this.config.maxRcpt) {
      this.send(`452 4.5.3 Too many recipients (max ${this.config.maxRcpt})`);
      return;
    }

    // RFC 5321 §4.1.1.3: "RCPT TO:" keyword, a valid mailbox or <Postmaster>;
    // RCPT parameters: NOTIFY and ORCPT when DSN is advertised, else 555.
    // UTF-8 addresses only in an SMTPUTF8 transaction (553 5.6.7).
    const esmtp = this.extensions();
    const decoded = decodeUtf8Command(args);
    if (decoded === null) {
      this.send('501 5.5.4 Invalid UTF-8 in command');
      return;
    }
    const parsed = parseRcptTo(decoded, { dsn: esmtp.dsn, utf8Transaction: tx.smtputf8 });
    if (!parsed.ok) {
      this.send(parsed.reply);
      return;
    }
    const addr = parsed.address;

    try {
      const reject = await this.config.handlers.onRcptTo(addr, tx.from, this.authUser, this.ip, (n) => {
        const notes = (tx.notes ??= []);
        if (notes.length < MAX_TX_NOTES) notes.push(n);
      });
      if (reject !== null) {
        this.send(formatRejectReply(reject, 550, 451));
        return;
      }
    } catch (err) {
      log.error({ id: this.id, err }, 'onRcptTo error');
      this.send('451 4.3.0 Temporary failure');
      return;
    }

    tx.rcptTo.push(addr);
    if (parsed.dsn) (tx.dsn.rcpts ??= {})[addr.toLowerCase()] = parsed.dsn;
    this.state = 'RCPT';
    this.send(`250 2.1.5 OK`);
  }

  // ─── DATA ────────────────────────────────────────────────────────────────────

  private handleDataCommand(): void {
    // RFC 3030 §2: DATA and BDAT must not be mixed in one transaction.
    if (this.state === 'BDAT') {
      this.send('503 5.5.1 DATA not allowed after BDAT in the same transaction');
      return;
    }
    if (this.state !== 'RCPT') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }
    // RFC 3030 §3: a BODY=BINARYMIME message can only be sent with BDAT.
    if (this.transaction?.body === 'BINARYMIME') {
      this.send('503 5.5.1 BODY=BINARYMIME requires BDAT');
      return;
    }

    this.state = 'DATA';
    this.inData = true;
    this.resetTimer(T_DATA);
    this.send('354 End data with <CR><LF>.<CR><LF>');
  }

  // ─── RSET ────────────────────────────────────────────────────────────────────

  private handleRset(): void {
    this.transaction = null;
    this.inData = false;
    this.bdatAnnounced = 0;
    this.dataOverflow = false;
    // Do not reset authUser per RFC 5321
    if (this.state !== 'INIT') {
      this.state = 'READY';
    }
    this.send('250 2.0.0 OK');
  }

  // ─── QUIT ────────────────────────────────────────────────────────────────────

  private handleQuit(): void {
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`221 2.0.0 ${this.config.hostname} closing connection - goodbye`);
    this.socket.end();
    log.debug({ id: this.id, ip: this.ip }, 'SMTP session quit');
  }
}
