/**
 * VacationResponse/* (RFC 8621 §8) — singleton on UserSettings.oof*.
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_VACATION } from '../capabilities.js';
import { MethodError, setError } from '../errors.js';
import { hashState } from '../state.js';
import { applyPatch, parseDate, parseGetArgs, parseSetArgs, pick, utc } from './common.js';
import type { JsonObject } from '../types.js';

async function load(userId: string): Promise<JsonObject> {
  const s = await prisma.userSettings.findUnique({ where: { userId } });
  const html = s?.oofExternal || s?.oofInternal || '';
  return {
    id: 'singleton',
    isEnabled: s?.oofEnabled ?? false,
    fromDate: s?.oofUseTimeRange && s.oofStart ? utc(s.oofStart) : null,
    toDate: s?.oofUseTimeRange && s.oofEnd ? utc(s.oofEnd) : null,
    subject: null,
    textBody: html.replace(/<[^>]+>/g, '').trim() || null,
    htmlBody: html || null,
  };
}

registerMethod('VacationResponse/get', CAP_VACATION, async (args, ctx) => {
  const { account, ids, properties } = parseGetArgs(args, ctx);
  if (!account.isPersonal) throw new MethodError('accountNotSupportedByMethod');
  const obj = await load(ctx.user.userId);
  const wanted = ids ?? ['singleton'];
  return {
    accountId: account.accountId,
    state: hashState(obj),
    list: wanted.includes('singleton') ? [pick(obj, properties)] : [],
    notFound: wanted.filter((i) => i !== 'singleton'),
  };
});

registerMethod('VacationResponse/set', CAP_VACATION, async (args, ctx) => {
  const { account, ifInState, create, update, destroy } = parseSetArgs(args, ctx);
  if (!account.isPersonal) throw new MethodError('accountNotSupportedByMethod');
  const before = await load(ctx.user.userId);
  const oldState = hashState(before);
  if (ifInState !== null && ifInState !== oldState) throw new MethodError('stateMismatch');
  const notCreated = Object.fromEntries(Object.keys(create).map((k) => [k, setError('singleton')]));
  const notDestroyed = Object.fromEntries(destroy.map((k) => [k, setError('singleton')]));
  const updated: JsonObject = {}; const notUpdated: JsonObject = {};
  for (const [id, patch] of Object.entries(update)) {
    if (id !== 'singleton') { notUpdated[id] = setError('notFound'); continue; }
    let next: JsonObject;
    try { next = applyPatch(before, patch); } catch (e) { notUpdated[id] = setError('invalidPatch', e instanceof Error ? e.message : undefined); continue; }
    const from = parseDate(next['fromDate']); const to = parseDate(next['toDate']);
    const html = typeof next['htmlBody'] === 'string' ? next['htmlBody'] : (typeof next['textBody'] === 'string' ? next['textBody'].replace(/\n/g, '<br>') : '');
    await prisma.userSettings.upsert({
      where: { userId: ctx.user.userId },
      create: { userId: ctx.user.userId, oofEnabled: next['isEnabled'] === true, oofExternal: html, oofInternal: html, oofUseTimeRange: !!(from || to), oofStart: from, oofEnd: to },
      update: { oofEnabled: next['isEnabled'] === true, oofExternal: html, oofInternal: html, oofUseTimeRange: !!(from || to), oofStart: from, oofEnd: to },
    });
    updated[id] = null;
  }
  return {
    accountId: account.accountId, oldState, newState: hashState(await load(ctx.user.userId)),
    created: null, updated: Object.keys(updated).length ? updated : null, destroyed: null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
});
