/**
 * SearchSnippet/get (RFC 8621 §5) — Treffer-Hervorhebung mit <mark>.
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_MAIL } from '../capabilities.js';
import { MethodError, requestTooLarge } from '../errors.js';
import { LIMITS } from '../settings.js';
import { previewOf } from '../mail/email-mapper.js';
import type { JsonObject } from '../types.js';

function collectTerms(filter: unknown, out: string[]): void {
  if (!filter || typeof filter !== 'object') return;
  const f = filter as JsonObject;
  if (Array.isArray(f['conditions'])) { for (const c of f['conditions']) collectTerms(c, out); return; }
  for (const k of ['text', 'subject', 'body', 'from', 'to', 'cc', 'bcc']) {
    if (typeof f[k] === 'string' && (f[k] as string).trim()) out.push((f[k] as string).trim());
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

function highlight(text: string, terms: string[]): string | null {
  if (!terms.length) return null;
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  if (!re.test(text)) return null;
  re.lastIndex = 0;
  return esc(text).replace(new RegExp(re.source, 'gi'), (m) => `<mark>${m}</mark>`);
}

registerMethod('SearchSnippet/get', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const emailIds = args['emailIds'];
  if (!Array.isArray(emailIds) || !emailIds.every((e) => typeof e === 'string')) throw new MethodError('invalidArguments', 'emailIds must be Id[]');
  if (emailIds.length > LIMITS.maxObjectsInGet) throw requestTooLarge();
  const terms: string[] = [];
  collectTerms(args['filter'], terms);
  const msgs = await prisma.message.findMany({
    where: { id: { in: emailIds as string[] }, folder: { mailboxId: account.mailboxId } },
    select: { id: true, subject: true, bodyText: true, bodyHtml: true },
  });
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const list: JsonObject[] = []; const notFound: string[] = [];
  for (const id of emailIds as string[]) {
    const m = byId.get(id);
    if (!m) { notFound.push(id); continue; }
    const text = m.bodyText || m.bodyHtml.replace(/<[^>]+>/g, ' ');
    let preview: string | null = null;
    if (terms.length) {
      const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
      const idx = text.search(re);
      if (idx >= 0) {
        const start = Math.max(0, idx - 100);
        preview = highlight(text.slice(start, start + 256).replace(/\s+/g, ' '), terms);
      }
    }
    list.push({ emailId: id, subject: highlight(m.subject, terms), preview: preview ?? (terms.length ? null : esc(previewOf(m))) });
  }
  return { accountId: account.accountId, list, notFound: notFound.length ? notFound : null };
});
