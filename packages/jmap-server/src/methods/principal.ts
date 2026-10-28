/**
 * Principal/* + ShareNotification/* (RFC 9670). Principals = aktive User
 * (type individual) und Shared Mailboxes (type group) aller Domains des
 * Servers; ShareNotifications werden (noch) nicht erzeugt → leere Listen.
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_MAIL, CAP_PRINCIPALS, CAP_SUBMISSION } from '../capabilities.js';
import { cannotCalculateChanges, setError, unsupportedFilter, unsupportedSort } from '../errors.js';
import { hashState } from '../state.js';
import { paginate, parseGetArgs, parseSetArgs, pick } from './common.js';
import type { JsonObject, MethodContext } from '../types.js';

async function listPrincipals(ctx: MethodContext): Promise<JsonObject[]> {
  const [users, shared] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, select: { id: true, email: true, displayName: true }, orderBy: { displayName: 'asc' } }),
    prisma.sharedMailbox.findMany({ where: { active: true }, select: { id: true, email: true, displayName: true }, orderBy: { displayName: 'asc' } }),
  ]);
  const out: JsonObject[] = [];
  for (const u of users) {
    const acc = ctx.accounts.get(u.id);
    out.push({
      id: u.id, type: 'individual', name: u.displayName || u.email, description: null, email: u.email, timeZone: null,
      capabilities: {},
      accounts: acc ? { [acc.accountId]: { name: acc.name, isPersonal: acc.isPersonal, isReadOnly: acc.readOnly, accountCapabilities: { [CAP_MAIL]: {}, ...(acc.maySend ? { [CAP_SUBMISSION]: {} } : {}) } } } : null,
    });
  }
  for (const s of shared) {
    const acc = ctx.accounts.get(`shared-${s.id}`);
    out.push({
      id: `shared-${s.id}`, type: 'group', name: s.displayName || s.email, description: 'Shared Mailbox', email: s.email, timeZone: null,
      capabilities: {},
      accounts: acc ? { [acc.accountId]: { name: acc.name, isPersonal: false, isReadOnly: acc.readOnly, accountCapabilities: { [CAP_MAIL]: {} } } } : null,
    });
  }
  return out;
}

registerMethod('Principal/get', CAP_PRINCIPALS, async (args, ctx) => {
  const { account, ids, properties } = parseGetArgs(args, ctx);
  const all = await listPrincipals(ctx);
  const have = new Set(all.map((p) => String(p['id'])));
  const list = (ids ? all.filter((p) => ids.includes(String(p['id']))) : all).map((p) => pick(p, properties));
  return { accountId: account.accountId, state: hashState(all.map((p) => [p['id'], p['name'], p['email']])), list, notFound: ids ? ids.filter((i) => !have.has(i)) : [] };
});

registerMethod('Principal/changes', CAP_PRINCIPALS, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const all = await listPrincipals(ctx);
  const newState = hashState(all.map((p) => [p['id'], p['name'], p['email']]));
  const oldState = String(args['sinceState'] ?? '');
  if (oldState !== newState) throw cannotCalculateChanges();
  return { accountId: account.accountId, oldState, newState, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
});

registerMethod('Principal/set', CAP_PRINCIPALS, async (args, ctx) => {
  const { account, create, update, destroy } = parseSetArgs(args, ctx, false);
  const all = await listPrincipals(ctx);
  const state = hashState(all.map((p) => [p['id'], p['name'], p['email']]));
  const forbid = (): JsonObject => setError('forbidden', 'principals are managed in the admin panel');
  return {
    accountId: account.accountId, oldState: state, newState: state, created: null, updated: null, destroyed: null,
    notCreated: Object.keys(create).length ? Object.fromEntries(Object.keys(create).map((k) => [k, forbid()])) : null,
    notUpdated: Object.keys(update).length ? Object.fromEntries(Object.keys(update).map((k) => [k, forbid()])) : null,
    notDestroyed: destroy.length ? Object.fromEntries(destroy.map((k) => [k, forbid()])) : null,
  };
});

registerMethod('Principal/query', CAP_PRINCIPALS, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  let all = await listPrincipals(ctx);
  const f = args['filter'] as JsonObject | undefined;
  if (f) {
    if ('operator' in f) throw unsupportedFilter('FilterOperator not supported');
    const inc = (hay: unknown, needle: unknown): boolean => String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());
    if (typeof f['email'] === 'string') all = all.filter((p) => inc(p['email'], f['email']));
    if (typeof f['name'] === 'string') all = all.filter((p) => inc(p['name'], f['name']));
    if (typeof f['type'] === 'string') all = all.filter((p) => p['type'] === f['type']);
    if (typeof f['text'] === 'string') all = all.filter((p) => inc(p['name'], f['text']) || inc(p['email'], f['text']));
    if (Array.isArray(f['accountIds'])) all = all.filter((p) => p['accounts'] && (f['accountIds'] as string[]).some((a) => a in (p['accounts'] as JsonObject)));
  }
  const sort = Array.isArray(args['sort']) ? (args['sort'] as JsonObject[]) : [];
  for (const s of sort) {
    const prop = String(s['property']);
    if (prop !== 'name' && prop !== 'email') throw unsupportedSort(`Cannot sort by ${prop}`);
    const dir = s['isAscending'] === false ? -1 : 1;
    all.sort((a, b) => String(a[prop]).localeCompare(String(b[prop])) * dir);
  }
  const page = paginate(all.map((p) => String(p['id'])), args);
  return {
    accountId: account.accountId, queryState: hashState(all.map((p) => p['id'])), canCalculateChanges: false,
    position: page.position, ids: page.ids, ...(args['calculateTotal'] === true ? { total: page.total } : {}),
  };
});

registerMethod('Principal/queryChanges', CAP_PRINCIPALS, async () => { throw cannotCalculateChanges(); });

// ── ShareNotification — derzeit keine Einträge ──────────────────────────────

registerMethod('ShareNotification/get', CAP_PRINCIPALS, async (args, ctx) => {
  const { account, ids } = parseGetArgs(args, ctx);
  return { accountId: account.accountId, state: '0', list: [], notFound: ids ?? [] };
});
registerMethod('ShareNotification/changes', CAP_PRINCIPALS, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  return { accountId: account.accountId, oldState: String(args['sinceState'] ?? '0'), newState: '0', hasMoreChanges: false, created: [], updated: [], destroyed: [] };
});
registerMethod('ShareNotification/set', CAP_PRINCIPALS, async (args, ctx) => {
  const { account, create, update, destroy } = parseSetArgs(args, ctx, false);
  return {
    accountId: account.accountId, oldState: '0', newState: '0', created: null, updated: null, destroyed: null,
    notCreated: Object.keys(create).length ? Object.fromEntries(Object.keys(create).map((k) => [k, setError('forbidden')])) : null,
    notUpdated: Object.keys(update).length ? Object.fromEntries(Object.keys(update).map((k) => [k, setError('notFound')])) : null,
    notDestroyed: destroy.length ? Object.fromEntries(destroy.map((k) => [k, setError('notFound')])) : null,
  };
});
registerMethod('ShareNotification/query', CAP_PRINCIPALS, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  return { accountId: account.accountId, queryState: '0', canCalculateChanges: true, position: 0, ids: [], total: 0 };
});
registerMethod('ShareNotification/queryChanges', CAP_PRINCIPALS, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  return { accountId: account.accountId, oldQueryState: String(args['sinceQueryState'] ?? '0'), newQueryState: '0', total: 0, removed: [], added: [] };
});
