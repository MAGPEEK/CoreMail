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
 * ESMTP-Erweiterungen analog `SmtpSettings`-Flags. Werden in der EHLO-Antwort
 * angeboten oder unterdrückt.
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
  starttls: true, authPlain: true, authLogin: true, authCramMd5: false,
  pipelining: true, size: true, bit8mime: true, enhancedStatus: true,
  smtputf8: false, dsn: true, chunking: false,
};

export interface SmtpSessionConfig {
  hostname: string;
  /**
   * Optionaler benutzerdefinierter Banner-Text nach "220 ".
   * Wenn gesetzt, wird er statt des Standard-Banners „<hostname> ESMTP CoreMail" verwendet.
   * Konfigurierbar via Admin-Panel → SMTP-Konfiguration → SMTP-Banner.
   * Wird als Getter übergeben damit Live-Updates ohne Listener-Neustart wirken.
   */
  bannerText?: string;
  /** Max. Nachrichtengröße in Bytes (aus SmtpSettings.maxMessageSizeMb × 1024²). */
  maxSize: number;
  maxRcpt: number;
  requireAuth: boolean;
  /** ESMTP-Erweiterungen — wenn `undefined`, gelten DEFAULT_ESMTP_EXTENSIONS. */
  esmtp?: EsmtpExtensions;
  tls?: { cert: Buffer; key: Buffer };
  /**
   * Wenn true (Default), wird STARTTLS in der EHLO-Antwort beworben (sofern TLS-Config vorhanden).
   * Auf Port 25 mit self-signed Cert: false setzen damit strikte MTAs (Microsoft Exchange)
   * in Plain zustellen können statt am gescheiterten TLS-Handshake hängenzubleiben.
   */
  advertiseStarttls?: boolean;
  handlers: SmtpHandlers;
  /** clientIp wird für Brute-Force-Tracking (ip-limiter) weitergegeben. */
  verifyCredentials?: (username: string, password: string, clientIp?: string) => Promise<AuthUser | null>;
}
