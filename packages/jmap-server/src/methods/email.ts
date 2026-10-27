/**
 * Email/* (RFC 8621 §4): get, changes, query, queryChanges, set, copy, import, parse.
 */
import { prisma, parseRawMessage } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_MAIL } from '../capabilities.js';
import { MethodError, cannotCalculateChanges, requestTooLarge, setError, type SetError } from '../errors.js';
import { decodeEmailState, emailState, emailStateParts, encodeEmailState } from '../state.js';
import { flagsToKeywords, isValidKeyword, keywordsToFlags } from '../mail/keywords.js';
import { ensureThreadIds } from '../mail/thread.js';
import { buildRfc822, loadRawMessage, type BuildOptions } from '../mail/raw.js';
import {
  invalidEmailProperties, parseMapOptions, toJmapEmail, utcDate, type MappableMessage,
} from '../mail/email-mapper.js';
import { applyEmailChange, destroyEmail, storeEmailFromRaw } from '../mail/write.js';
import { resolveBlob } from '../blobs.js';
import { LIMITS } from '../settings.js';
import { applyPatch, assertState, paginate, parseGetArgs, parseSetArgs, parseDate } from './common.js';
import { changedMessageIds } from './email-changes.js';
import { parseSort, queryEmailIds } from './email-query.js';
import type { AccountContext, EmailAddress, EmailHeader, JsonObject } from '../types.js';

const MSG_INCLUDE = { attachments: true } as const;

async function loadMessages(account: AccountContext, ids: string[]): Promise<MappableMessage[]> {
  return prisma.message.findMany({
    where: { id: { in: ids }, folder: { mailboxId: account.mailboxId }, deletedAt: null },
    include: MSG_INCLUDE,
  });
}

// ── Email/get ────────────────────────────────────────────────────────────────

registerMethod('Email/get', CAP_MAIL, async (args, ctx) => {
  const { account, ids } = parseGetArgs(args, ctx);
  if (!ids) throw requestTooLarge();
  const opts = parseMapOptions(args);
  const bad = invalidEmailProperties(opts.properties);
  if (bad.length) throw new MethodError('invalidArguments', `Unknown properties: ${bad.join(', ')}`);
  const msgs = await loadMessages(account, ids);
  const threads = await ensureThreadIds(msgs, account.mailboxId);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const list: JsonObject[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) { notFound.push(id); continue; }
    list.push(await toJmapEmail(m, threads.get(id) ?? id, opts));
  }
  return { accountId: account.accountId, state: await emailState(account.mailboxId), list, notFound };
});

// ── Email/changes ────────────────────────────────────────────────────────────

registerMethod('Email/changes', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const old = decodeEmailState(args['sinceState']);
  if (!old) throw cannotCalculateChanges();
  const parts = await emailStateParts(account.mailboxId);
  const max = typeof args['maxChanges'] === 'number' && args['maxChanges'] > 0 ? Math.trunc(args['maxChanges']) : Infinity;
  const ch = await changedMessageIds(account, old, parts);
  if (ch.created.length + ch.updated.length > max) throw new MethodError('cannotCalculateChanges', 'too many changes');
  return {
    accountId: account.accountId,
    oldState: encodeEmailState(old),
    newState: encodeEmailState(parts),
    hasMoreChanges: false,
    created: ch.created,
    updated: ch.updated,
    destroyed: [],
  };
});

// ── Email/query ──────────────────────────────────────────────────────────────

registerMethod('Email/query', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const sort = parseSort(args['sort']);
  const ids = await queryEmailIds(account, args['filter'], sort, args['collapseThreads'] === true);
  const page = paginate(ids, args);
  return {
    accountId: account.accountId,
    queryState: await emailState(account.mailboxId),
    canCalculateChanges: false,
    position: page.position,
    ids: page.ids,
    ...(args['calculateTotal'] === true ? { total: page.total } : {}),
    ...(page.limit !== null ? { limit: page.limit } : {}),
  };
});

registerMethod('Email/queryChanges', CAP_MAIL, async () => { throw cannotCalculateChanges(); });

// ── Email/set ────────────────────────────────────────────────────────────────

interface CreateParsed {
  folderId: string;
  flags: string[];
  receivedAt: Date | undefined;
  raw: Buffer;
}

function addrList(v: unknown, prop: string): EmailAddress[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw setError('invalidProperties', `${prop} must be EmailAddress[]`, [prop]);
  return (v as JsonObject[]).map((a) => {
    if (!a || typeof a['email'] !== 'string') throw setError('invalidProperties', `${prop}: email missing`, [prop]);
    return { name: typeof a['name'] === 'string' ? a['name'] : null, email: a['email'] };
  });
}

function strList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

async function parseCreate(obj: JsonObject, account: AccountContext, ctx: { resolveId(id: string): string }): Promise<CreateParsed> {
  // mailboxIds — CoreMail: genau ein Ordner
  const mbIds = obj['mailboxIds'];
  if (!mbIds || typeof mbIds !== 'object' || Array.isArray(mbIds)) throw setError('invalidProperties', 'mailboxIds required', ['mailboxIds']);
  const folderIds = Object.entries(mbIds as JsonObject).filter(([, v]) => v === true).map(([k]) => ctx.resolveId(k));
  if (folderIds.length !== 1) throw setError('tooManyMailboxes', 'CoreMail stores each email in exactly one mailbox', ['mailboxIds']);
  const folder = await prisma.folder.findFirst({ where: { id: folderIds[0]!, mailboxId: account.mailboxId }, select: { id: true } });
  if (!folder) throw setError('invalidProperties', 'mailbox not found', ['mailboxIds']);

  const kw = (obj['keywords'] ?? {}) as JsonObject;
  if (typeof kw !== 'object' || Array.isArray(kw)) throw setError('invalidProperties', 'keywords must be an object', ['keywords']);
  for (const k of Object.keys(kw)) if (!isValidKeyword(k)) throw setError('invalidProperties', `invalid keyword ${k}`, ['keywords']);
  const flags = keywordsToFlags(kw);

  const receivedAt = parseDate(obj['receivedAt']) ?? undefined;

  // Body: entweder bodyStructure oder textBody/htmlBody + bodyValues
  const bodyValues = (obj['bodyValues'] ?? {}) as Record<string, JsonObject>;
  const valueOf = (partId: unknown): string => {
    const bv = bodyValues[String(partId)];
    if (!bv || typeof bv['value'] !== 'string') throw setError('invalidProperties', `bodyValues[${String(partId)}] missing`, ['bodyValues']);
    return bv['value'];
  };
  let text = ''; let html = '';
  const attachments: BuildOptions['attachments'] = [];
  let attachBytes = 0;

  const addAttachment = async (p: JsonObject): Promise<void> => {
    if (typeof p['blobId'] !== 'string') throw setError('invalidProperties', 'attachment blobId required', ['attachments']);
    const blob = await resolveBlob(account, p['blobId']);
    if (!blob) throw setError('blobNotFound', `blob ${p['blobId']} not found`, ['attachments']);
    attachBytes += blob.buffer.length;
    if (attachBytes > LIMITS.maxSizeAttachmentsPerEmail) throw setError('tooLarge', 'attachments exceed maxSizeAttachmentsPerEmail');
    attachments.push({
      filename: typeof p['name'] === 'string' ? p['name'] : (blob.name ?? 'attachment'),
      contentType: typeof p['type'] === 'string' ? p['type'] : blob.type,
      content: blob.buffer,
      ...(typeof p['cid'] === 'string' ? { cid: p['cid'] } : {}),
      ...(p['disposition'] === 'inline' ? { contentDisposition: 'inline' as const } : {}),
    });
  };

  const walk = async (part: JsonObject): Promise<void> => {
    const type = String(part['type'] ?? 'text/plain').toLowerCase();
    if (type.startsWith('multipart/')) {
      for (const sp of (Array.isArray(part['subParts']) ? part['subParts'] : []) as JsonObject[]) await walk(sp);
      return;
    }
    if (part['partId'] !== undefined && part['partId'] !== null && part['disposition'] !== 'attachment') {
      if (type === 'text/html') html = valueOf(part['partId']); else text = valueOf(part['partId']);
      return;
    }
    await addAttachment(part);
  };

  if (obj['bodyStructure'] && typeof obj['bodyStructure'] === 'object') {
    if (obj['textBody'] !== undefined || obj['htmlBody'] !== undefined || obj['attachments'] !== undefined) {
      throw setError('invalidProperties', 'bodyStructure cannot be combined with textBody/htmlBody/attachments', ['bodyStructure']);
    }
    await walk(obj['bodyStructure'] as JsonObject);
  } else {
    const tb = Array.isArray(obj['textBody']) ? (obj['textBody'] as JsonObject[]) : [];
    const hb = Array.isArray(obj['htmlBody']) ? (obj['htmlBody'] as JsonObject[]) : [];
    if (tb.length > 1 || hb.length > 1) throw setError('invalidProperties', 'only one textBody/htmlBody part supported', ['textBody']);
    if (tb[0]) text = valueOf(tb[0]['partId']);
    if (hb[0]) html = valueOf(hb[0]['partId']);
    for (const a of (Array.isArray(obj['attachments']) ? obj['attachments'] : []) as JsonObject[]) await addAttachment(a);
  }

  // Header
  const extraHeaders: EmailHeader[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('header:')) continue;
    const m = /^header:([^:]+)(?::as(Raw|Text))?$/.exec(k);
    if (!m) throw setError('invalidProperties', `unsupported header form ${k}`, [k]);
    const name = m[1]!;
    if (/^(from|to|cc|bcc|subject|date|message-id|in-reply-to|references|reply-to|sender|content-type|content-transfer-encoding|mime-version)$/i.test(name)) {
      throw setError('invalidProperties', `use the dedicated property instead of ${k}`, [k]);
    }
    extraHeaders.push({ name, value: String(v ?? '').trim() });
  }
  if (Array.isArray(obj['headers'])) {
    for (const h of obj['headers'] as JsonObject[]) {
      if (typeof h['name'] === 'string' && typeof h['value'] === 'string') extraHeaders.push({ name: h['name'], value: h['value'].trim() });
    }
  }

  const from = addrList(obj['from'], 'from');
  const sender = addrList(obj['sender'], 'sender');
  const raw = await buildRfc822({
    from: from[0] ?? { name: account.name, email: account.email },
    sender: sender[0] ?? null,
    to: addrList(obj['to'], 'to'),
    cc: addrList(obj['cc'], 'cc'),
    bcc: addrList(obj['bcc'], 'bcc'),
    replyTo: addrList(obj['replyTo'], 'replyTo'),
    subject: typeof obj['subject'] === 'string' ? obj['subject'] : '',
    date: parseDate(obj['sentAt']) ?? new Date(),
    messageId: strList(obj['messageId'])[0] ?? null,
    inReplyTo: strList(obj['inReplyTo']),
    references: strList(obj['references']),
    text,
    html,
    attachments,
    extraHeaders,
  });
  return { folderId: folder.id, flags, receivedAt, raw };
}

export interface EmailSetResult {
  created: JsonObject; notCreated: JsonObject;
  updated: JsonObject; notUpdated: JsonObject;
  destroyed: string[]; notDestroyed: JsonObject;
}

/** Kern von Email/set — wird auch von EmailSubmission/set (onSuccess…) genutzt. */
export async function runEmailSet(
  account: AccountContext,
  ctx: { resolveId(id: string): string; createdIds: Map<string, string> },
  create: Record<string, JsonObject>,
  update: Record<string, JsonObject>,
  destroy: string[],
): Promise<EmailSetResult> {
  const r: EmailSetResult = { created: {}, notCreated: {}, updated: {}, notUpdated: {}, destroyed: [], notDestroyed: {} };

  for (const [cid, obj] of Object.entries(create)) {
    try {
      const c = await parseCreate(obj, account, ctx);
      const stored = await storeEmailFromRaw(account, c.folderId, c.raw, c.flags, c.receivedAt);
      ctx.createdIds.set(cid, stored.id);
      r.created[cid] = { id: stored.id, blobId: `m-${stored.id}`, threadId: stored.threadId, size: stored.size };
    } catch (e) {
      r.notCreated[cid] = isSetError(e) ? e : setError('serverFail', e instanceof Error ? e.message : undefined);
    }
  }

  for (const [id, patch] of Object.entries(update)) {
    const msg = await prisma.message.findFirst({
      where: { id, folder: { mailboxId: account.mailboxId }, deletedAt: null },
      select: { id: true, folderId: true, flags: true },
    });
    if (!msg) { r.notUpdated[id] = setError('notFound'); continue; }
    const bad = Object.keys(patch).map((k) => k.split('/')[0]!).filter((k) => k !== 'keywords' && k !== 'mailboxIds');
    if (bad.length) { r.notUpdated[id] = setError('invalidProperties', 'only keywords and mailboxIds are mutable', [...new Set(bad)]); continue; }
    let next: JsonObject;
    try {
      next = applyPatch({ keywords: flagsToKeywords(msg.flags), mailboxIds: { [msg.folderId]: true } }, patch);
    } catch (e) { r.notUpdated[id] = setError('invalidPatch', e instanceof Error ? e.message : undefined); continue; }
    const kw = next['keywords'] as JsonObject;
    const invalidKw = Object.keys(kw).filter((k) => !isValidKeyword(k));
    if (invalidKw.length) { r.notUpdated[id] = setError('invalidProperties', `invalid keyword ${invalidKw[0]}`, ['keywords']); continue; }
    const folderIds = Object.entries(next['mailboxIds'] as JsonObject).filter(([, v]) => v === true).map(([k]) => ctx.resolveId(k));
    if (folderIds.length !== 1) { r.notUpdated[id] = setError('tooManyMailboxes', 'exactly one mailbox required', ['mailboxIds']); continue; }
    if (folderIds[0] !== msg.folderId) {
      const f = await prisma.folder.findFirst({ where: { id: folderIds[0]!, mailboxId: account.mailboxId }, select: { id: true } });
      if (!f) { r.notUpdated[id] = setError('invalidProperties', 'mailbox not found', ['mailboxIds']); continue; }
    }
    const newFlags = keywordsToFlags(kw);
    // nicht-JMAP-Flags (z.B. \Recent) beibehalten
    for (const f of msg.flags) if (f.startsWith('\\') && !['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Forwarded'].includes(f)) newFlags.push(f);
    await applyEmailChange(account, msg, { flags: [...new Set(newFlags)], folderId: folderIds[0]! });
    r.updated[id] = null;
  }

  for (const id of destroy) {
    const msg = await prisma.message.findFirst({
      where: { id, folder: { mailboxId: account.mailboxId } },
      select: { id: true, folderId: true, flags: true },
    });
    if (!msg) { r.notDestroyed[id] = setError('notFound'); continue; }
    await destroyEmail(account, msg);
    r.destroyed.push(id);
  }
  return r;
}

function isSetError(e: unknown): e is SetError {
  return !!e && typeof e === 'object' && !(e instanceof Error) && typeof (e as SetError).type === 'string';
}

export function setResponse(accountId: string, oldState: string, newState: string, r: EmailSetResult): JsonObject {
  const nz = (o: JsonObject): JsonObject | null => (Object.keys(o).length ? o : null);
  return {
    accountId, oldState, newState,
    created: nz(r.created), updated: nz(r.updated), destroyed: r.destroyed.length ? r.destroyed : null,
    notCreated: nz(r.notCreated), notUpdated: nz(r.notUpdated), notDestroyed: nz(r.notDestroyed),
  };
}

registerMethod('Email/set', CAP_MAIL, async (args, ctx) => {
  const { account, ifInState, create, update, destroy } = parseSetArgs(args, ctx);
  const oldState = await emailState(account.mailboxId);
  assertState(ifInState, oldState);
  const r = await runEmailSet(account, ctx, create, update, destroy);
  return setResponse(account.accountId, oldState, await emailState(account.mailboxId), r);
});

// ── Email/import ─────────────────────────────────────────────────────────────

registerMethod('Email/import', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  if (account.readOnly) throw new MethodError('accountReadOnly');
  const oldState = await emailState(account.mailboxId);
  assertState(typeof args['ifInState'] === 'string' ? args['ifInState'] : null, oldState);
  const emails = (args['emails'] ?? {}) as Record<string, JsonObject>;
  if (typeof emails !== 'object' || Array.isArray(emails)) throw new MethodError('invalidArguments', 'emails must be an object');
  if (Object.keys(emails).length > LIMITS.maxObjectsInSet) throw requestTooLarge();
  const created: JsonObject = {}; const notCreated: JsonObject = {};
  for (const [cid, obj] of Object.entries(emails)) {
    try {
      if (typeof obj['blobId'] !== 'string') throw setError('invalidProperties', 'blobId required', ['blobId']);
      const blob = await resolveBlob(account, obj['blobId']);
      if (!blob) throw setError('blobNotFound');
      const mb = obj['mailboxIds'];
      if (!mb || typeof mb !== 'object') throw setError('invalidProperties', 'mailboxIds required', ['mailboxIds']);
      const folderIds = Object.entries(mb as JsonObject).filter(([, v]) => v === true).map(([k]) => ctx.resolveId(k));
      if (folderIds.length !== 1) throw setError('tooManyMailboxes', undefined, ['mailboxIds']);
      const folder = await prisma.folder.findFirst({ where: { id: folderIds[0]!, mailboxId: account.mailboxId }, select: { id: true } });
      if (!folder) throw setError('invalidProperties', 'mailbox not found', ['mailboxIds']);
      const kw = (obj['keywords'] ?? {}) as JsonObject;
      for (const k of Object.keys(kw)) if (!isValidKeyword(k)) throw setError('invalidProperties', `invalid keyword ${k}`, ['keywords']);
      try { await parseRawMessage(blob.buffer); } catch { throw setError('invalidEmail'); }
      const stored = await storeEmailFromRaw(account, folder.id, blob.buffer, keywordsToFlags(kw), parseDate(obj['receivedAt']) ?? undefined);
      ctx.createdIds.set(cid, stored.id);
      created[cid] = { id: stored.id, blobId: `m-${stored.id}`, threadId: stored.threadId, size: stored.size };
    } catch (e) {
      notCreated[cid] = isSetError(e) ? e : setError('serverFail', e instanceof Error ? e.message : undefined);
    }
  }
  return {
    accountId: account.accountId, oldState, newState: await emailState(account.mailboxId),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
  };
});

// ── Email/copy ───────────────────────────────────────────────────────────────

registerMethod('Email/copy', CAP_MAIL, async (args, ctx) => {
  const from = ctx.account(args['fromAccountId']);
  const to = ctx.account(args['accountId']);
  if (from.accountId === to.accountId) throw new MethodError('invalidArguments', 'fromAccountId must differ from accountId');
  if (to.readOnly) throw new MethodError('accountReadOnly');
  const fromOld = await emailState(from.mailboxId);
  const toOld = await emailState(to.mailboxId);
  assertState(typeof args['ifFromInState'] === 'string' ? args['ifFromInState'] : null, fromOld);
  assertState(typeof args['ifInState'] === 'string' ? args['ifInState'] : null, toOld);
  const create = (args['create'] ?? {}) as Record<string, JsonObject>;
  const created: JsonObject = {}; const notCreated: JsonObject = {};
  const copiedSourceIds: string[] = [];
  for (const [cid, obj] of Object.entries(create)) {
    try {
      const srcId = typeof obj['id'] === 'string' ? ctx.resolveId(obj['id']) : '';
      const [src] = await loadMessages(from, [srcId]);
      if (!src) throw setError('notFound');
      const mb = obj['mailboxIds'];
      if (!mb || typeof mb !== 'object') throw setError('invalidProperties', 'mailboxIds required', ['mailboxIds']);
      const folderIds = Object.entries(mb as JsonObject).filter(([, v]) => v === true).map(([k]) => ctx.resolveId(k));
      if (folderIds.length !== 1) throw setError('tooManyMailboxes', undefined, ['mailboxIds']);
      const folder = await prisma.folder.findFirst({ where: { id: folderIds[0]!, mailboxId: to.mailboxId }, select: { id: true } });
      if (!folder) throw setError('invalidProperties', 'mailbox not found', ['mailboxIds']);
      const kw = obj['keywords'] && typeof obj['keywords'] === 'object' ? keywordsToFlags(obj['keywords'] as JsonObject) : src.flags;
      const raw = await loadRawMessage(src);
      const stored = await storeEmailFromRaw(to, folder.id, raw, kw, parseDate(obj['receivedAt']) ?? src.createdAt);
      ctx.createdIds.set(cid, stored.id);
      created[cid] = { id: stored.id, blobId: `m-${stored.id}`, threadId: stored.threadId, size: stored.size };
      copiedSourceIds.push(src.id);
    } catch (e) {
      notCreated[cid] = isSetError(e) ? e : setError('serverFail', e instanceof Error ? e.message : undefined);
    }
  }
  const responses: Array<{ name: string; args: JsonObject }> = [{
    name: 'Email/copy',
    args: {
      fromAccountId: from.accountId, accountId: to.accountId, oldState: toOld, newState: await emailState(to.mailboxId),
      created: Object.keys(created).length ? created : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
    },
  }];
  if (args['onSuccessDestroyOriginal'] === true && copiedSourceIds.length && !from.readOnly) {
    const destroyOld = await emailState(from.mailboxId);
    if (typeof args['destroyFromIfInState'] === 'string' && args['destroyFromIfInState'] !== destroyOld) {
      responses.push({ name: 'error', args: { type: 'stateMismatch' } });
    } else {
      const r = await runEmailSet(from, ctx, {}, {}, copiedSourceIds);
      responses.push({ name: 'Email/set', args: setResponse(from.accountId, destroyOld, await emailState(from.mailboxId), r) });
    }
  }
  return responses;
});

// ── Email/parse ──────────────────────────────────────────────────────────────

registerMethod('Email/parse', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const blobIds = args['blobIds'];
  if (!Array.isArray(blobIds) || !blobIds.every((b) => typeof b === 'string')) throw new MethodError('invalidArguments', 'blobIds must be Id[]');
  if (blobIds.length > LIMITS.maxObjectsInGet) throw requestTooLarge();
  const opts = parseMapOptions(args);
  const parsed: JsonObject = {}; const notParsable: string[] = []; const notFound: string[] = [];
  for (const blobId of blobIds as string[]) {
    const blob = await resolveBlob(account, blobId);
    if (!blob) { notFound.push(blobId); continue; }
    try {
      const p = await parseRawMessage(blob.buffer);
      const pseudo: MappableMessage = {
        id: blobId, folderId: '', flags: [], createdAt: new Date(), rawSize: blob.buffer.length, threadId: null,
        subject: p.subject, fromAddr: p.fromAddr, fromName: p.fromName, toAddrs: p.toAddrs, ccAddrs: p.ccAddrs, bccAddrs: p.bccAddrs,
        replyTo: p.replyTo, messageId: p.messageId, inReplyTo: p.inReplyTo, date: p.date, bodyText: p.bodyText, bodyHtml: p.bodyHtml,
        storagePath: null,
        attachments: p.attachments.map((a, i) => ({
          id: `${blobId}-${i}`, filename: a.filename, mimeType: a.mimeType, storagePath: '', contentId: a.contentId, inline: a.inline, size: a.size,
        })),
      };
      const email = await toJmapEmail(pseudo, blobId, {
        ...opts,
        properties: (opts.properties ?? ['messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments'])
          .filter((x) => !['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'receivedAt'].includes(x)),
      });
      delete email['id'];
      // Part-Blobs geparster Nachrichten: pp<hex(blobId)>-(text|html|att<n>) → blobs.ts parst den Quell-Blob erneut
      const hex = Buffer.from(blobId, 'utf8').toString('hex');
      const rewrite = (part: JsonObject): void => {
        const b = String(part['blobId'] ?? '');
        if (b.endsWith('-text')) part['blobId'] = `pp${hex}-text`;
        else if (b.endsWith('-html')) part['blobId'] = `pp${hex}-html`;
        else { const m = /-(\d+)$/.exec(b); if (m) part['blobId'] = `pp${hex}-att${m[1]}`; }
        if (Array.isArray(part['subParts'])) for (const sp of part['subParts'] as JsonObject[]) rewrite(sp);
      };
      for (const key of ['textBody', 'htmlBody', 'attachments', 'bodyStructure'] as const) {
        const v = email[key];
        if (Array.isArray(v)) for (const part of v as JsonObject[]) rewrite(part);
        else if (v && typeof v === 'object') rewrite(v as JsonObject);
      }
      parsed[blobId] = { ...email, size: blob.buffer.length, receivedAt: utcDate(new Date()) };
    } catch {
      notParsable.push(blobId);
    }
  }
  return {
    accountId: account.accountId,
    parsed: Object.keys(parsed).length ? parsed : null,
    notParsable: notParsable.length ? notParsable : null,
    notFound: notFound.length ? notFound : null,
  };
});
