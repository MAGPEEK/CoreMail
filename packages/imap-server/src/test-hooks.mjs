/**
 * TEST-ONLY module hooks (not part of the build, never imported by production code).
 *
 * Lets `*.test.ts` files run with plain Node (>= 22.15 / 24, built-in TypeScript
 * support) without node_modules, a database, Redis or MinIO:
 *
 *   1. `@coremail/core*` and `@coremail/storage*` resolve to an in-memory stub whose
 *      behaviour is controlled by the test through `globalThis.__coremailTest`
 *      ({ prisma, verifyPassword, redis }).
 *   2. Relative `./x.js` specifiers fall back to `./x.ts` (the repo uses NodeNext
 *      `.js` extensions in TypeScript sources).
 *
 * Usage (from the repository root):
 *   node --experimental-transform-types --import ./packages/<pkg>/src/test-hooks.mjs --test <file.test.ts>
 */
import { registerHooks } from 'node:module';

const STUB_URL = 'coremail-test-stub:all';

// The real message-store (UID/modSeq allocation) has no runtime imports and only
// talks to the transaction client it is given, so the stub re-exports it unchanged.
const MESSAGE_STORE_URL = new URL('../../storage/src/message-store.ts', import.meta.url).href;
// The shared mail credential check (pure, dependencies injected) — wired to the
// fake prisma / verifyPassword below and an in-memory lockout store.
const MAIL_AUTH_CORE_URL = new URL('../../storage/src/mail-auth-core.ts', import.meta.url).href;

// Pure storage modules (MIME tree, addresses, legacy builder, raw message store)
// are re-exported unchanged as well; the raw store is wired to an in-memory object
// store (globalThis.__coremailTest.objects: Map<key, Buffer>).
const storageUrl = (p) => new URL(`../../storage/src/${p}`, import.meta.url).href;

const STUB_SOURCE = `
export * from '${MESSAGE_STORE_URL}';
import { createMailCredentialVerifier, createMemoryAuthRedis } from '${MAIL_AUTH_CORE_URL}';
export { createMemoryAuthRedis, normalizeIp, isPrivateOrLoopbackIp, createExemptIpMatcher } from '${MAIL_AUTH_CORE_URL}';
export * from '${new URL('../../core/src/net/connection-limiter.ts', import.meta.url).href}';
export * from '${new URL('../../core/src/tls/tls-errors.ts', import.meta.url).href}';
export * from '${new URL('../../core/src/tls/legacy-tls.ts', import.meta.url).href}';
export * from '${storageUrl('mime/tree.ts')}';
export * from '${storageUrl('mime/address.ts')}';
export * from '${storageUrl('mime/build.ts')}';
export * from '${storageUrl('mime/index.ts')}';
export * from '${storageUrl('raw-message.ts')}';
export * from '${storageUrl('mailbox-access.ts')}';
export * from '${storageUrl('references.ts')}';
export * from '${storageUrl('folder-delete.ts')}';
// w3 folder permissions: the real rights model and access check; published
// changes are collected in globalThis.__coremailTest.permissionEvents.
export * from '${storageUrl('folder-permissions.ts')}';
export * from '${storageUrl('folder-access.ts')}';
export * from '${storageUrl('folder-grantees.ts')}';
export const publishFolderPermissionChange = async (changes, fallbackUserId) => {
  (g.permissionEvents ??= []).push({ changes, fallbackUserId });
};
import { splitReferences } from '${storageUrl('references.ts')}';
// v9.1 THREAD=REFERENCES: the stored column of the (fake) message rows; no backfill here.
export const loadThreadReferences = async (folderId, ids) => {
  const wanted = new Set(ids);
  const rows = await g.prisma.message.findMany({ where: { folderId, deletedAt: null } });
  const out = new Map();
  for (const r of rows) if (wanted.has(r.id) && typeof r.references === 'string') out.set(r.id, splitReferences(r.references));
  return out;
};
import { createRawMessageStore } from '${storageUrl('raw-message.ts')}';
const g = (globalThis.__coremailTest ??= {});
const objects = (g.objects ??= new Map());
export const downloadBuffer = async (key) => {
  const b = objects.get(key);
  if (!b) throw Object.assign(new Error('NoSuchKey: ' + key), { code: 'NoSuchKey' });
  return b;
};
export const uploadBuffer = async (key, data) => { objects.set(key, Buffer.from(data)); };
export const attachmentKey = (messageId, name) => 'attachments/' + messageId + '/' + name;
const rawStore = createRawMessageStore({
  download: downloadBuffer,
  upload: uploadBuffer,
  exists: async (key) => objects.has(key),
  markStored: async (id, storagePath, rawSize) => {
    if (g.prisma && g.prisma.message && g.prisma.message.updateMany) {
      await g.prisma.message.updateMany({ where: { id, storagePath: null }, data: { storagePath, rawSize } });
    }
  },
});
export const loadRawMessage = rawStore.loadRawMessage;
export const storeRawMessage = rawStore.storeRawMessage;
export const reconstructRawMessage = rawStore.reconstructRawMessage;
const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => logger };
export const createLogger = () => logger;
export const verifyPassword = (password, hash) =>
  (g.verifyPassword ?? (async (p, h) => h === 'hash:' + p))(password, hash);
export const getRedisClient = () => g.redis ?? {
  duplicate: () => ({ subscribe: async () => 1, on: noop, publish: async () => 0 }),
  publish: async () => 0,
};
export const CHANNEL_MAIL_NEW = 'mail:new';
// 9.4 realtime: the real event vocabulary; publishing goes through the fake Redis
// (g.redis.publish), so writes through the real message store wake IDLE sessions.
export * from '${new URL('../../core/src/realtime/events.ts', import.meta.url).href}';
export * from '${storageUrl('realtime/change-scope.ts')}';
export const publishMailboxChange = async (event) => { await getRedisClient().publish?.('mailbox:changes', JSON.stringify(event)); };
export const publishUserEvent = async () => {};
// v8.1 hard quota for client writes — g.overQuota(mailboxId) decides in tests.
export const isMailboxWriteBlocked = async (mailboxId) => (g.overQuota ? !!(await g.overQuota(mailboxId)) : false);
export const OVER_QUOTA_MESSAGE = 'Mailbox is full (over its storage quota): delete items and empty the Trash';
// v7.1.0 live-connection registry (credential changes) — inert in these tests.
export class LiveConnectionRegistry {
  register() { return () => {}; }
  terminateAffected() { return 0; }
  count() { return 0; }
  attachInvalidation() { return () => {}; }
}
// 9.4 protocol switches — covered by live-sessions.test.ts, not by these suites.
export const PROTOCOL_ACCESS_CHANGE = 'protocol-access-change';
export const CHANNEL_ADMIN_ATTACK = 'admin:attack';
// 10.5 connect guard (block list / locked IPs) — g.connectGuard decides in tests, default: admit.
export const connectGuard = {
  isBlocked: (ip) => !!g.connectGuard?.isBlocked?.(ip),
  lockedFor: async (ip) => (g.connectGuard?.lockedFor ? g.connectGuard.lockedFor(ip) : 0),
  refused: () => {},
};
// 9.4 mailbox access audit — events are collected in globalThis.__coremailTest.accessAudit.
export const recordMailboxAccess = async (event) => { (g.accessAudit ??= []).push(event); return true; };
export const prisma = new Proxy({}, {
  get(_target, model) {
    const db = g.prisma;
    if (!db || !(model in db)) throw new Error('test stub: prisma.' + String(model) + ' was accessed but is not faked');
    return db[model];
  },
});
let mailAuth = null;
export const verifyMailCredentials = (login, password, ctx) => {
  mailAuth ??= createMailCredentialVerifier({
    prisma,
    redis: g.authRedis ?? createMemoryAuthRedis(),
    verifyPassword: (p, h) => verifyPassword(p, h),
    dummyHash: async () => 'hash:\\u0000dummy',
  });
  return mailAuth.verify(login, password, ctx);
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@coremail/core') || specifier.startsWith('@coremail/storage')) {
      return { url: STUB_URL, format: 'module', shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (url === STUB_URL) {
      return { format: 'module', source: STUB_SOURCE, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
