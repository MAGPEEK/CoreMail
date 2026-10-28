/**
 * RFC-5322-Rohdaten: laden (MinIO) oder aus DB-Feldern rekonstruieren,
 * Header parsen (mailparser) und neue Nachrichten (Drafts, Email/set create)
 * mit nodemailer aufbauen.
 */
import nodemailer from 'nodemailer';
import { simpleParser, type ParsedMail } from 'mailparser';
import { downloadBuffer } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import type { EmailAddress, EmailHeader } from '../types.js';

const log = createLogger('jmap:raw');

export interface DbMessageLike {
  id: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  bccAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  date: Date;
  bodyText: string;
  bodyHtml: string;
  storagePath: string | null;
  attachments: Array<{ id: string; filename: string; mimeType: string; storagePath: string; contentId: string | null; inline: boolean; size: number }>;
}

export function bodyPartBuffer(msg: { bodyText: string; bodyHtml: string }, kind: 'text' | 'html'): Buffer {
  return Buffer.from(kind === 'html' ? msg.bodyHtml : msg.bodyText, 'utf8');
}

/** Rohnachricht laden; ohne storagePath wird sie aus den DB-Feldern gebaut. */
export async function loadRawMessage(msg: DbMessageLike): Promise<Buffer> {
  if (msg.storagePath) {
    try {
      return await downloadBuffer(msg.storagePath);
    } catch (err) {
      log.warn({ err, id: msg.id }, 'Rohnachricht nicht in MinIO — rekonstruiere aus DB');
    }
  }
  const attachments = await Promise.all(msg.attachments.map(async (a) => ({
    filename: a.filename,
    contentType: a.mimeType,
    content: await downloadBuffer(a.storagePath).catch(() => Buffer.alloc(0)),
    ...(a.contentId ? { cid: a.contentId.replace(/^<|>$/g, '') } : {}),
    ...(a.inline ? { contentDisposition: 'inline' as const } : {}),
  })));
  return buildRfc822({
    from: { name: msg.fromName || null, email: msg.fromAddr },
    to: msg.toAddrs.map(parseAddress),
    cc: msg.ccAddrs.map(parseAddress),
    bcc: [],
    replyTo: msg.replyTo ? [parseAddress(msg.replyTo)] : [],
    subject: msg.subject,
    date: msg.date,
    messageId: msg.messageId,
    inReplyTo: msg.inReplyTo ? [msg.inReplyTo] : [],
    references: [],
    text: msg.bodyText,
    html: msg.bodyHtml,
    attachments,
    extraHeaders: [],
  });
}

export interface BuildOptions {
  from: EmailAddress | null;
  sender?: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  date: Date;
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  text: string;
  html: string;
  attachments: Array<{ filename: string; contentType: string; content: Buffer; cid?: string; contentDisposition?: 'attachment' | 'inline' }>;
  extraHeaders: EmailHeader[];
}

function fmt(a: EmailAddress): nodemailer.SendMailOptions['from'] {
  return a.name ? { name: a.name, address: a.email } : a.email;
}
function fmtList(list: EmailAddress[]): Array<string | { name: string; address: string }> {
  return list.map((a) => (a.name ? { name: a.name, address: a.email } : a.email));
}
function angle(id: string): string {
  const t = id.trim();
  return t.startsWith('<') ? t : `<${t}>`;
}

export async function buildRfc822(o: BuildOptions): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'crlf', buffer: true });
  const headers: Record<string, string> = {};
  for (const h of o.extraHeaders) headers[h.name] = h.value;
  const info = await transport.sendMail({
    ...(o.from ? { from: fmt(o.from) } : {}),
    ...(o.sender ? { sender: fmt(o.sender) } : {}),
    to: fmtList(o.to),
    cc: fmtList(o.cc),
    bcc: fmtList(o.bcc),
    ...(o.replyTo.length ? { replyTo: fmtList(o.replyTo) } : {}),
    subject: o.subject,
    date: o.date,
    ...(o.messageId ? { messageId: angle(o.messageId) } : {}),
    ...(o.inReplyTo.length ? { inReplyTo: angle(o.inReplyTo[0]!) } : {}),
    ...(o.references.length ? { references: o.references.map(angle).join(' ') } : {}),
    ...(o.text ? { text: o.text } : {}),
    ...(o.html ? { html: o.html } : {}),
    attachments: o.attachments,
    headers,
  });
  const message = (info as unknown as { message: Buffer | string }).message;
  return Buffer.isBuffer(message) ? message : Buffer.from(String(message));
}

// ── Header-Parsing ───────────────────────────────────────────────────────────

export interface ParsedHeaders {
  lines: EmailHeader[];
  parsed: ParsedMail;
}

const headerCache = new WeakMap<Buffer, Promise<ParsedHeaders>>();

export function parseHeaders(raw: Buffer): Promise<ParsedHeaders> {
  let p = headerCache.get(raw);
  if (!p) {
    p = (async () => {
      const parsed = await simpleParser(raw, {
        skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true,
      });
      const lines: EmailHeader[] = parsed.headerLines.map((h) => {
        const idx = h.line.indexOf(':');
        return idx === -1
          ? { name: h.line, value: '' }
          : { name: h.line.slice(0, idx), value: h.line.slice(idx + 1).replace(/\r?\n/g, '\r\n') };
      });
      return { lines, parsed };
    })();
    headerCache.set(raw, p);
  }
  return p;
}

// ── Adress-Hilfen ────────────────────────────────────────────────────────────

export function parseAddress(s: string): EmailAddress {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1]!.trim() || null, email: m[2]!.trim() };
  return { name: null, email: s.trim() };
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.email}>` : a.email;
}

export function stripAngle(id: string): string {
  return id.trim().replace(/^<|>$/g, '');
}

export function splitMessageIds(v: string | string[] | null | undefined): string[] {
  if (!v) return [];
  const str = Array.isArray(v) ? v.join(' ') : v;
  return str.split(/\s+/).map(stripAngle).filter(Boolean);
}
