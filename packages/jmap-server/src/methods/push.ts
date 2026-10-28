/**
 * PushSubscription/* (RFC 8620 §7.2) — not bound to an account.
 * Verification: the server POSTs a PushVerification to the URL, the client confirms
 * the verificationCode via /set update. Only then are StateChanges sent.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { registerMethod } from '../dispatcher.js';
import { CAP_CORE } from '../capabilities.js';
import { MethodError, requestTooLarge, setError } from '../errors.js';
import { LIMITS } from '../settings.js';
import { sendPushMessage } from '../push/webpush.js';
import { parseDate, pick, utc } from './common.js';
import type { JsonObject } from '../types.js';

const log = createLogger('jmap:push');
const MAX_EXPIRY_MS = 7 * 24 * 3600 * 1000;
const KNOWN_TYPES = new Set(['Mailbox', 'Thread', 'Email', 'EmailDelivery', 'Identity', 'EmailSubmission', 'VacationResponse', 'Quota', 'Principal', 'ShareNotification']);

type Row = { id: string; deviceClientId: string; url: string; keysP256dh: string | null; keysAuth: string | null; expires: Date | null; types: string[]; verified: boolean };

function toJson(r: Row): JsonObject {
  return {
    id: r.id,
    deviceClientId: r.deviceClientId,
    url: r.url,
    keys: r.keysP256dh && r.keysAuth ? { p256dh: r.keysP256dh, auth: r.keysAuth } : null,
    expires: r.expires ? utc(r.expires) : null,
    types: r.types.length ? r.types : null,
  };
}

function clampExpiry(d: Date | null): Date {
  const max = new Date(Date.now() + MAX_EXPIRY_MS);
  return !d || d.getTime() > max.getTime() ? max : d;
}

registerMethod('PushSubscription/get', CAP_CORE, async (args, ctx) => {
  if (args['accountId'] !== undefined) throw new MethodError('invalidArguments', 'PushSubscription/get takes no accountId');
  const ids = Array.isArray(args['ids']) ? (args['ids'] as string[]).map((i) => ctx.resolveId(i)) : null;
  if (ids && ids.length > LIMITS.maxObjectsInGet) throw requestTooLarge();
  const properties = Array.isArray(args['properties']) ? (args['properties'] as string[]).filter((p) => p !== 'keys' && p !== 'verificationCode') : null;
  const rows = await prisma.jmapPushSubscription.findMany({ where: { userId: ctx.user.userId, ...(ids ? { id: { in: ids } } : {}) } });
  const have = new Set(rows.map((r) => r.id));
  return {
    list: rows.map((r) => pick(toJson(r), properties ?? ['id', 'deviceClientId', 'url', 'expires', 'types'])),
    notFound: ids ? ids.filter((i) => !have.has(i)) : [],
  };
});

registerMethod('PushSubscription/set', CAP_CORE, async (args, ctx) => {
  if (args['accountId'] !== undefined) throw new MethodError('invalidArguments', 'PushSubscription/set takes no accountId');
  const create = (args['create'] ?? {}) as Record<string, JsonObject>;
  const update = (args['update'] ?? {}) as Record<string, JsonObject>;
  const destroy = Array.isArray(args['destroy']) ? (args['destroy'] as string[]).map((d) => ctx.resolveId(d)) : [];
  if (Object.keys(create).length + Object.keys(update).length + destroy.length > LIMITS.maxObjectsInSet) throw requestTooLarge();
  const created: JsonObject = {}; const notCreated: JsonObject = {};
  const updated: JsonObject = {}; const notUpdated: JsonObject = {};
  const destroyed: string[] = []; const notDestroyed: JsonObject = {};

  for (const [cid, obj] of Object.entries(create)) {
    const url = typeof obj['url'] === 'string' ? obj['url'] : '';
    const deviceClientId = typeof obj['deviceClientId'] === 'string' ? obj['deviceClientId'] : '';
    const bad: string[] = [];
    if (!deviceClientId || deviceClientId.length > 255) bad.push('deviceClientId');
    if (!/^https:\/\//.test(url) && !(process.env['NODE_ENV'] !== 'production' && /^http:\/\//.test(url))) bad.push('url');
    const keys = obj['keys'] as JsonObject | null | undefined;
    if (keys && (typeof keys['p256dh'] !== 'string' || typeof keys['auth'] !== 'string')) bad.push('keys');
    const types = Array.isArray(obj['types']) ? (obj['types'] as string[]) : [];
    if (types.some((t) => !KNOWN_TYPES.has(t))) bad.push('types');
    if (obj['verificationCode'] !== undefined && obj['verificationCode'] !== null) bad.push('verificationCode');
    if (bad.length) { notCreated[cid] = setError('invalidProperties', undefined, bad); continue; }
    const dup = await prisma.jmapPushSubscription.findFirst({ where: { userId: ctx.user.userId, deviceClientId }, select: { id: true } });
    if (dup) { notCreated[cid] = setError('invalidProperties', 'deviceClientId already registered', ['deviceClientId']); continue; }
    const expires = clampExpiry(parseDate(obj['expires']));
    const verificationCode = randomBytes(24).toString('base64url');
    const row = await prisma.jmapPushSubscription.create({
      data: {
        userId: ctx.user.userId, deviceClientId, url,
        keysP256dh: keys ? String(keys['p256dh']) : null, keysAuth: keys ? String(keys['auth']) : null,
        verificationCode, expires, types,
      },
    });
    ctx.createdIds.set(cid, row.id);
    created[cid] = { id: row.id, expires: utc(expires) };
    // Deliver PushVerification asynchronously (RFC 8620 §7.2.2)
    void sendPushMessage(row, { '@type': 'PushVerification', pushSubscriptionId: row.id, verificationCode })
      .catch((err: unknown) => log.warn({ err, id: row.id }, 'PushVerification could not be delivered'));
  }

  for (const [id, patch] of Object.entries(update)) {
    const row = await prisma.jmapPushSubscription.findFirst({ where: { id, userId: ctx.user.userId } });
    if (!row) { notUpdated[id] = setError('notFound'); continue; }
    const bad = Object.keys(patch).filter((k) => !['verificationCode', 'expires', 'types'].includes(k));
    if (bad.length) { notUpdated[id] = setError('invalidProperties', 'immutable property', bad); continue; }
    const data: { verified?: boolean; expires?: Date; types?: string[] } = {};
    if (patch['verificationCode'] !== undefined) {
      if (patch['verificationCode'] !== row.verificationCode) { notUpdated[id] = setError('invalidProperties', 'verificationCode does not match', ['verificationCode']); continue; }
      data.verified = true;
    }
    if (patch['expires'] !== undefined) data.expires = clampExpiry(parseDate(patch['expires']));
    if (patch['types'] !== undefined) {
      const types = Array.isArray(patch['types']) ? (patch['types'] as string[]) : [];
      if (types.some((t) => !KNOWN_TYPES.has(t))) { notUpdated[id] = setError('invalidProperties', undefined, ['types']); continue; }
      data.types = types;
    }
    const saved = await prisma.jmapPushSubscription.update({ where: { id }, data });
    updated[id] = data.expires ? { expires: utc(saved.expires ?? data.expires) } : null;
  }

  for (const id of destroy) {
    const row = await prisma.jmapPushSubscription.findFirst({ where: { id, userId: ctx.user.userId }, select: { id: true } });
    if (!row) { notDestroyed[id] = setError('notFound'); continue; }
    await prisma.jmapPushSubscription.delete({ where: { id } });
    destroyed.push(id);
  }

  return {
    created: Object.keys(created).length ? created : null,
    updated: Object.keys(updated).length ? updated : null,
    destroyed: destroyed.length ? destroyed : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
});
