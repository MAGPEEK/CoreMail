/**
 * Quota/* (RFC 9425). One quota per account: storage in octets from
 * User.quotaBytes/usedBytes or SharedMailbox.quotaBytes/usedBytes.
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_QUOTA } from '../capabilities.js';
import { cannotCalculateChanges } from '../errors.js';
import { hashState } from '../state.js';
import { paginate, parseGetArgs, pick } from './common.js';
import type { AccountContext, JsonObject } from '../types.js';

const QUOTA_ID = 'storage';

async function loadQuota(account: AccountContext): Promise<JsonObject | null> {
  let used = 0n; let limit = 0n;
  if (account.sharedMailboxId) {
    const s = await prisma.sharedMailbox.findUnique({ where: { id: account.sharedMailboxId }, select: { usedBytes: true, quotaBytes: true } });
    if (!s) return null;
    used = s.usedBytes; limit = s.quotaBytes;
  } else if (account.ownerUserId) {
    const u = await prisma.user.findUnique({ where: { id: account.ownerUserId }, select: { usedBytes: true, quotaBytes: true } });
    if (!u) return null;
    used = u.usedBytes; limit = u.quotaBytes;
  } else {
    return null;
  }
  const hard = Number(limit);
  return {
    id: QUOTA_ID,
    resourceType: 'octets',
    used: Number(used),
    hardLimit: hard,
    scope: 'account',
    name: 'Speicherplatz',
    description: `Speicherkontingent für ${account.email}`,
    types: ['Email'],
    warnLimit: Math.floor(hard * 0.9),
    softLimit: null,
  };
}

registerMethod('Quota/get', CAP_QUOTA, async (args, ctx) => {
  const { account, ids, properties } = parseGetArgs(args, ctx);
  const q = await loadQuota(account);
  const wanted = ids ?? [QUOTA_ID];
  const list = q && wanted.includes(QUOTA_ID) ? [pick(q, properties)] : [];
  return { accountId: account.accountId, state: hashState(q), list, notFound: wanted.filter((i) => i !== QUOTA_ID || !q) };
});

registerMethod('Quota/changes', CAP_QUOTA, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const q = await loadQuota(account);
  const newState = hashState(q);
  const oldState = String(args['sinceState'] ?? '');
  return {
    accountId: account.accountId, oldState, newState, hasMoreChanges: false,
    created: [], updated: oldState !== newState && q ? [QUOTA_ID] : [], destroyed: [],
  };
});

registerMethod('Quota/query', CAP_QUOTA, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const q = await loadQuota(account);
  let ids = q ? [QUOTA_ID] : [];
  const f = args['filter'] as JsonObject | undefined;
  if (f && q) {
    if (typeof f['resourceType'] === 'string' && f['resourceType'] !== 'octets') ids = [];
    if (typeof f['scope'] === 'string' && f['scope'] !== 'account') ids = [];
    if (typeof f['type'] === 'string' && f['type'] !== 'Email') ids = [];
    if (typeof f['name'] === 'string' && !String(q['name']).toLowerCase().includes(f['name'].toLowerCase())) ids = [];
  }
  const page = paginate(ids, args);
  return {
    accountId: account.accountId, queryState: hashState(q), canCalculateChanges: false,
    position: page.position, ids: page.ids, ...(args['calculateTotal'] === true ? { total: page.total } : {}),
  };
});

registerMethod('Quota/queryChanges', CAP_QUOTA, async () => { throw cannotCalculateChanges(); });
