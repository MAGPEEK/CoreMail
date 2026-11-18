/**
 * The one nodemailer option set for building a MIME message in memory (9.4
 * review). Every generated message — outbound jobs, the sender's own Sent copy,
 * invitations, auto-replies, JMAP Email/set — must use CRLF line ends
 * (RFC 5322 / RFC 5321).
 *
 * nodemailer's stream transport converts line ends to the `newline` option and
 * defaults to bare LF; only `'windows'` (or `'win'`, `'dos'`, `'\r\n'`)
 * selects CRLF — `'crlf'` is no valid value and silently produced bare LF.
 * MailComposer#build() alone keeps bare LF of the text content, so builders use
 * the transport (buildCrlfMime) instead.
 */
import nodemailer, { type SendMailOptions } from 'nodemailer';

export const CRLF_STREAM_TRANSPORT = Object.freeze({ streamTransport: true as const, newline: 'windows' as const });

/** Builds an RFC 5322 message with CRLF line ends only. */
export async function buildCrlfMime(options: SendMailOptions): Promise<Buffer> {
  const info = await nodemailer.createTransport({ ...CRLF_STREAM_TRANSPORT, buffer: true }).sendMail(options);
  return info.message as Buffer;
}

/** Pure: true when every line of `raw` ends in CRLF (no bare LF, no bare CR). */
export function hasOnlyCrlfLineEnds(raw: Buffer | string): boolean {
  const s = typeof raw === 'string' ? raw : raw.toString('latin1');
  return !/(^|[^\r])\n/.test(s) && !/\r(?!\n)/.test(s);
}
