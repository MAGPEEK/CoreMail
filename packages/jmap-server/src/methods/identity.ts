/**
 * Identity/* (RFC 8621 §6). Identities are derived (not editable):
 *   u-<userId>     primary address of the account owner
 *   al-<aliasId>   e-mail alias (EmailAlias) of the user / shared mailbox
 *   sm-<sharedId>  shared mailbox with SEND_AS/FULL_ACCESS
 * Signature from UserSettings.signature (HTML) — text variant via tag strip.
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_SUBMISSION } from '../capabilities.js';
import { setError } from '../errors.js';
import { hashState } from '../state.js';
import { parseGetArgs, parseSetArgs, pick } from './common.js';
import type { AccountContext, JmapUser, JsonObject } from '../types.js';

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

export async function listIdentities(account: AccountContext, user: JmapUser): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  const settings = await prisma.userSettings.findUnique({ where: { userId: user.userId }, select: { signature: true } });
  const html = settings?.signature ?? '';
  const sig = { textSignature: stripHtml(html), htmlSignature: html };

  if (account.isPersonal || account.ownerUserId) {
    const ownerId = account.ownerUserId ?? user.userId;
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, email: true, displayName: true } });
    if (owner) {
      out.push({ id: `u-${owner.id}`, name: owner.displayName, email: owner.email, replyTo: null, bcc: null, ...sig, mayDelete: false });
      const aliases = await prisma.emailAlias.findMany({ where: { targetUserId: owner.id, active: true }, select: { id: true, address: true } });
      for (const a of aliases) out.push({ id: `al-${a.id}`, name: owner.displayName, email: a.address, replyTo: null, bcc: null, ...sig, mayDelete: false });
    }
    if (account.isPersonal) {
      const perms = await prisma.sharedMailboxPerm.findMany({
        where: { userId: user.userId, permission: { in: ['SEND_AS', 'FULL_ACCESS'] }, sharedMailbox: { active: true } },
        select: { sharedMailbox: { select: { id: true, email: true, displayName: true } } },
      });
      const seen = new Set<string>();
      for (const p of perms) {
        if (seen.has(p.sharedMailbox.id)) continue;
        seen.add(p.sharedMailbox.id);
        out.push({ id: `sm-${p.sharedMailbox.id}`, name: p.sharedMailbox.displayName, email: p.sharedMailbox.email, replyTo: null, bcc: null, ...sig, mayDelete: false });
      }
    }
  } else if (account.sharedMailboxId && account.maySend) {
    out.push({ id: `sm-${account.sharedMailboxId}`, name: account.name, email: account.email, replyTo: null, bcc: null, ...sig, mayDelete: false });
    const aliases = await prisma.emailAlias.findMany({ where: { targetSharedId: account.sharedMailboxId, active: true }, select: { id: true, address: true } });
    for (const a of aliases) out.push({ id: `al-${a.id}`, name: account.name, email: a.address, replyTo: null, bcc: null, ...sig, mayDelete: false });
  }
  return out;
}

export function identityState(list: JsonObject[]): string {
  return hashState(list.map((i) => [i['id'], i['name'], i['email'], i['htmlSignature']]));
}

registerMethod('Identity/get', CAP_SUBMISSION, async (args, ctx) => {
  const { account, ids, properties } = parseGetArgs(args, ctx);
  const all = await listIdentities(account, ctx.user);
  const list = (ids ? all.filter((i) => ids.includes(String(i['id']))) : all).map((i) => pick(i, properties));
  const have = new Set(all.map((i) => String(i['id'])));
  return { accountId: account.accountId, state: identityState(all), list, notFound: ids ? ids.filter((i) => !have.has(i)) : [] };
});

registerMethod('Identity/changes', CAP_SUBMISSION, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const all = await listIdentities(account, ctx.user);
  const newState = identityState(all);
  const oldState = String(args['sinceState'] ?? '');
  const changed = oldState !== newState;
  return {
    accountId: account.accountId, oldState, newState, hasMoreChanges: false,
    created: [], updated: changed ? all.map((i) => String(i['id'])) : [], destroyed: [],
  };
});

registerMethod('Identity/set', CAP_SUBMISSION, async (args, ctx) => {
  const { account, create, update, destroy } = parseSetArgs(args, ctx, false);
  const all = await listIdentities(account, ctx.user);
  const state = identityState(all);
  const forbid = (): JsonObject => setError('forbidden', 'identities are managed by the administrator');
  return {
    accountId: account.accountId, oldState: state, newState: state,
    created: null, updated: null, destroyed: null,
    notCreated: Object.keys(create).length ? Object.fromEntries(Object.keys(create).map((k) => [k, forbid()])) : null,
    notUpdated: Object.keys(update).length ? Object.fromEntries(Object.keys(update).map((k) => [k, forbid()])) : null,
    notDestroyed: destroy.length ? Object.fromEntries(destroy.map((k) => [k, forbid()])) : null,
  };
});
