/**
 * EmailSubmission/* (RFC 8621 §7). Sending via the BullMQ queue `smtp-outbound`
 * (same path as SMTP submission: rawMessage base64). Submission objects
 * live in Redis (7 days) since CoreMail has no submission table.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { prisma } from '@coremail/storage';
import { createBullMqConnection, getRedisClient, createLogger } from '@coremail/core';
import { registerMethod } from '../dispatcher.js';
import { CAP_SUBMISSION } from '../capabilities.js';
import { MethodError, cannotCalculateChanges, setError, type SetError } from '../errors.js';
import { emailState } from '../state.js';
import { loadRawMessage, parseAddress, parseHeaders } from '../mail/raw.js';
import { listIdentities } from './identity.js';
import { runEmailSet, setResponse } from './email.js';
import { paginate, parseGetArgs, parseSetArgs, pick, parseDate, utc } from './common.js';
import type { AccountContext, JsonObject, MethodContext } from '../types.js';

const log = createLogger('jmap:submission');
const TTL = 7 * 24 * 3600;

interface Submission {
  id: string;
  identityId: string;
  emailId: string;
  threadId: string;
  envelope: { mailFrom: { email: string; parameters: null }; rcptTo: Array<{ email: string; parameters: null }> };
  sendAt: string;
  undoStatus: 'pending' | 'final' | 'canceled';
  deliveryStatus: null;
  dsnBlobIds: string[];
  mdnBlobIds: string[];
  jobId: string;
}

let queue: Queue | null = null;
function outboundQueue(): Queue {
  if (!queue) queue = new Queue('smtp-outbound', { connection: createBullMqConnection() });
  return queue;
}

const key = (acc: string, id: string): string => `jmap:sub:${acc}:${id}`;
const setKey = (acc: string): string => `jmap:subs:${acc}`;
const stateKey = (acc: string): string => `jmap:substate:${acc}`;

async function save(acc: string, s: Submission): Promise<void> {
  const r = getRedisClient();
  await r.set(key(acc, s.id), JSON.stringify(s), 'EX', TTL);
  await r.sadd(setKey(acc), s.id);
  await r.expire(setKey(acc), TTL);
  await r.incr(stateKey(acc));
}
async function load(acc: string, id: string): Promise<Submission | null> {
  const raw = await getRedisClient().get(key(acc, id));
  return raw ? (JSON.parse(raw) as Submission) : null;
}
async function loadAll(acc: string): Promise<Submission[]> {
  const ids = await getRedisClient().smembers(setKey(acc));
  const out: Submission[] = [];
  for (const id of ids) { const s = await load(acc, id); if (s) out.push(s); }
  return out.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}
async function state(acc: string): Promise<string> {
  return (await getRedisClient().get(stateKey(acc))) ?? '0';
}

function toJson(s: Submission): JsonObject {
  const { jobId: _jobId, ...rest } = s;
  return rest as unknown as JsonObject;
}

interface CreateInput { identityId: string; emailId: string; envelope: Submission['envelope']; sendAt: Date }

async function parseCreate(obj: JsonObject, account: AccountContext, ctx: MethodContext): Promise<CreateInput & { raw: Buffer; threadId: string }> {
  const identityId = typeof obj['identityId'] === 'string' ? ctx.resolveId(obj['identityId']) : '';
  const identities = await listIdentities(account, ctx.user);
  const identity = identities.find((i) => i['id'] === identityId);
  if (!identity) throw setError('invalidProperties', 'identityId unknown', ['identityId']);
  const identityEmail = String(identity['email']).toLowerCase();

  const emailId = typeof obj['emailId'] === 'string' ? ctx.resolveId(obj['emailId']) : '';
  const msg = await prisma.message.findFirst({
    where: { id: emailId, folder: { mailboxId: account.mailboxId }, deletedAt: null },
    include: { attachments: true },
  });
  if (!msg) throw setError('invalidProperties', 'emailId not found', ['emailId']);

  // From header must match the identity (forbiddenFrom)
  if (msg.fromAddr && msg.fromAddr.toLowerCase() !== identityEmail) {
    throw setError('forbiddenFrom', `From ${msg.fromAddr} does not match identity ${identityEmail}`);
  }

  const raw = await loadRawMessage(msg);
  let rcpt: string[];
  let mailFrom = identityEmail;
  const env = obj['envelope'] as JsonObject | undefined;
  if (env && typeof env === 'object') {
    const mf = env['mailFrom'] as JsonObject | undefined;
    if (mf && typeof mf['email'] === 'string') mailFrom = mf['email'].toLowerCase();
    const rt = Array.isArray(env['rcptTo']) ? (env['rcptTo'] as JsonObject[]) : [];
    rcpt = rt.map((r) => String(r['email'] ?? '').trim()).filter(Boolean);
  } else {
    const hdr = await parseHeaders(raw);
    const all = ['to', 'cc', 'bcc'].flatMap((h) => {
      const v = hdr.parsed[h as 'to' | 'cc' | 'bcc'];
      const list = Array.isArray(v) ? v : v ? [v] : [];
      return list.flatMap((a) => a.value.map((x) => x.address ?? '').filter(Boolean));
    });
    rcpt = all.length ? all : [...msg.toAddrs, ...msg.ccAddrs, ...msg.bccAddrs].map((a) => parseAddress(a).email);
  }
  if (mailFrom !== identityEmail) throw setError('forbiddenMailFrom', 'envelope mailFrom must equal identity email');
  rcpt = [...new Set(rcpt.map((r) => r.toLowerCase()))];
  if (!rcpt.length) throw setError('noRecipients');
  const bad = rcpt.filter((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r));
  if (bad.length) throw setError('invalidRecipients', `invalid: ${bad.join(', ')}`);

  const sendAt = parseDate(obj['sendAt']) ?? new Date();
  const threadId = msg.threadId ?? msg.id;
  return {
    identityId, emailId, sendAt, raw, threadId,
    envelope: { mailFrom: { email: mailFrom, parameters: null }, rcptTo: rcpt.map((e) => ({ email: e, parameters: null })) },
  };
}

async function enqueue(account: AccountContext, ctx: MethodContext, c: CreateInput & { raw: Buffer }, jobId: string): Promise<void> {
  const domainName = c.envelope.mailFrom.email.split('@')[1] ?? '';
  const domain = await prisma.domain.findFirst({ where: { name: domainName }, select: { name: true, dkimSelector: true, dkimPrivateKey: true } });
  const delay = Math.max(0, c.sendAt.getTime() - Date.now());
  await outboundQueue().add('send', {
    messageId: jobId,
    from: c.envelope.mailFrom.email,
    to: c.envelope.rcptTo.map((r) => r.email),
    senderUserId: account.ownerUserId ?? ctx.user.userId,
    ...(domain?.dkimPrivateKey ? { dkimDomain: domain.name, dkimSelector: domain.dkimSelector, dkimPrivateKey: domain.dkimPrivateKey } : {}),
    rawMessage: c.raw.toString('base64'),
  }, { jobId, ...(delay > 0 ? { delay } : {}) });
  void prisma.systemLog.create({
    data: {
      level: 'INFO', service: 'jmap-server', category: 'MAIL_FLOW',
      message: `Sent (JMAP): ${c.envelope.mailFrom.email} → ${c.envelope.rcptTo.map((r) => r.email).join(', ')}`,
      userId: ctx.user.userId,
      metadata: { sender: c.envelope.mailFrom.email, recipient: c.envelope.rcptTo.map((r) => r.email).join(', '), status: 'ACCEPTED', messageId: jobId, direction: 'OUTBOUND', protocol: 'JMAP' },
    },
  }).catch((e: unknown) => log.warn({ err: e }, 'MAIL_FLOW-Log fehlgeschlagen'));
}

registerMethod('EmailSubmission/get', CAP_SUBMISSION, async (args, ctx) => {
  const { account, ids, properties } = parseGetArgs(args, ctx);
  const all = await loadAll(account.accountId);
  const have = new Set(all.map((s) => s.id));
  const list = (ids ? all.filter((s) => ids.includes(s.id)) : all).map((s) => pick(toJson(s), properties));
  return { accountId: account.accountId, state: await state(account.accountId), list, notFound: ids ? ids.filter((i) => !have.has(i)) : [] };
});

registerMethod('EmailSubmission/changes', CAP_SUBMISSION, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const newState = await state(account.accountId);
  const oldState = String(args['sinceState'] ?? '');
  if (oldState !== newState) throw cannotCalculateChanges();
  return { accountId: account.accountId, oldState, newState, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
});

registerMethod('EmailSubmission/query', CAP_SUBMISSION, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  let all = await loadAll(account.accountId);
  const f = args['filter'] as JsonObject | undefined;
  if (f && typeof f === 'object') {
    if (Array.isArray(f['identityIds'])) all = all.filter((s) => (f['identityIds'] as string[]).includes(s.identityId));
    if (Array.isArray(f['emailIds'])) all = all.filter((s) => (f['emailIds'] as string[]).includes(s.emailId));
    if (Array.isArray(f['threadIds'])) all = all.filter((s) => (f['threadIds'] as string[]).includes(s.threadId));
    if (typeof f['undoStatus'] === 'string') all = all.filter((s) => s.undoStatus === f['undoStatus']);
    if (typeof f['before'] === 'string') all = all.filter((s) => s.sendAt < (f['before'] as string));
    if (typeof f['after'] === 'string') all = all.filter((s) => s.sendAt >= (f['after'] as string));
  }
  const sort = Array.isArray(args['sort']) ? (args['sort'] as JsonObject[]) : [];
  for (const s of sort) {
    const prop = String(s['property']);
    if (!['emailId', 'threadId', 'sentAt', 'sendAt'].includes(prop)) throw new MethodError('unsupportedSort', `Cannot sort by ${prop}`);
    const dir = s['isAscending'] === false ? -1 : 1;
    const k = (prop === 'sentAt' ? 'sendAt' : prop) as keyof Submission;
    all.sort((a, b) => String(a[k]).localeCompare(String(b[k])) * dir);
  }
  const page = paginate(all.map((s) => s.id), args);
  return {
    accountId: account.accountId, queryState: await state(account.accountId), canCalculateChanges: false,
    position: page.position, ids: page.ids, ...(args['calculateTotal'] === true ? { total: page.total } : {}),
  };
});

registerMethod('EmailSubmission/queryChanges', CAP_SUBMISSION, async () => { throw cannotCalculateChanges(); });

registerMethod('EmailSubmission/set', CAP_SUBMISSION, async (args, ctx) => {
  const { account, ifInState, create, update, destroy } = parseSetArgs(args, ctx, false);
  if (!account.maySend) throw new MethodError('forbidden', 'no send permission for this account');
  const oldState = await state(account.accountId);
  if (ifInState !== null && ifInState !== oldState) throw new MethodError('stateMismatch');

  const created: JsonObject = {}; const notCreated: JsonObject = {};
  const updated: JsonObject = {}; const notUpdated: JsonObject = {};
  const destroyed: string[] = []; const notDestroyed: JsonObject = {};
  const createdEmailIds = new Map<string, string>(); // creationId → emailId

  for (const [cid, obj] of Object.entries(create)) {
    try {
      const c = await parseCreate(obj, account, ctx);
      const id = `sub-${randomUUID()}`;
      const jobId = `jmap-${id}`;
      await enqueue(account, ctx, c, jobId);
      const sub: Submission = {
        id, identityId: c.identityId, emailId: c.emailId, threadId: c.threadId, envelope: c.envelope,
        sendAt: utc(c.sendAt), undoStatus: c.sendAt.getTime() > Date.now() + 1000 ? 'pending' : 'final',
        deliveryStatus: null, dsnBlobIds: [], mdnBlobIds: [], jobId,
      };
      await save(account.accountId, sub);
      ctx.createdIds.set(cid, id);
      createdEmailIds.set(cid, c.emailId);
      created[cid] = { id, threadId: c.threadId, sendAt: sub.sendAt, undoStatus: sub.undoStatus, deliveryStatus: null, dsnBlobIds: [], mdnBlobIds: [] };
    } catch (e) {
      notCreated[cid] = isSetError(e) ? e : setError('serverFail', e instanceof Error ? e.message : undefined);
    }
  }

  for (const [id, patch] of Object.entries(update)) {
    const sub = await load(account.accountId, id);
    if (!sub) { notUpdated[id] = setError('notFound'); continue; }
    const keys = Object.keys(patch);
    if (keys.length !== 1 || keys[0] !== 'undoStatus' || patch['undoStatus'] !== 'canceled') {
      notUpdated[id] = setError('invalidProperties', 'only undoStatus=canceled may be set', keys); continue;
    }
    if (sub.undoStatus !== 'pending') { notUpdated[id] = setError('cannotUnsend'); continue; }
    try {
      const job = await outboundQueue().getJob(sub.jobId);
      if (job) await job.remove();
      sub.undoStatus = 'canceled';
      await save(account.accountId, sub);
      updated[id] = null;
    } catch (e) {
      notUpdated[id] = setError('cannotUnsend', e instanceof Error ? e.message : undefined);
    }
  }

  for (const id of destroy) {
    const sub = await load(account.accountId, id);
    if (!sub) { notDestroyed[id] = setError('notFound'); continue; }
    await getRedisClient().del(key(account.accountId, id));
    await getRedisClient().srem(setKey(account.accountId), id);
    await getRedisClient().incr(stateKey(account.accountId));
    destroyed.push(id);
  }

  const responses: Array<{ name: string; args: JsonObject }> = [{
    name: 'EmailSubmission/set',
    args: {
      accountId: account.accountId, oldState, newState: await state(account.accountId),
      created: Object.keys(created).length ? created : null,
      updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    },
  }];

  // onSuccessUpdateEmail / onSuccessDestroyEmail → implicit Email/set (RFC 8621 §7.5)
  const upd = (args['onSuccessUpdateEmail'] ?? {}) as Record<string, JsonObject>;
  const des = Array.isArray(args['onSuccessDestroyEmail']) ? (args['onSuccessDestroyEmail'] as string[]) : [];
  const resolveSubRef = async (ref: string): Promise<string | null> => {
    if (ref.startsWith('#')) return createdEmailIds.get(ref.slice(1)) ?? null;
    const s = await load(account.accountId, ref);
    return s?.emailId ?? null;
  };
  const emailUpdates: Record<string, JsonObject> = {};
  for (const [ref, patch] of Object.entries(upd)) { const eid = await resolveSubRef(ref); if (eid) emailUpdates[eid] = patch; }
  const emailDestroys: string[] = [];
  for (const ref of des) { const eid = await resolveSubRef(ref); if (eid) emailDestroys.push(eid); }
  if (Object.keys(emailUpdates).length || emailDestroys.length) {
    if (account.readOnly) {
      responses.push({ name: 'error', args: { type: 'accountReadOnly' } });
    } else {
      const eOld = await emailState(account.mailboxId);
      const r = await runEmailSet(account, ctx, {}, emailUpdates, emailDestroys);
      responses.push({ name: 'Email/set', args: setResponse(account.accountId, eOld, await emailState(account.mailboxId), r) });
    }
  }
  return responses;
});

function isSetError(e: unknown): e is SetError {
  return !!e && typeof e === 'object' && !(e instanceof Error) && typeof (e as SetError).type === 'string';
}
