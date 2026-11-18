/**
 * CoreMail MAPI over HTTP server — port 3007, loopback only; the api-gateway
 * proxies /mapi/* to it. Classic Outlook ("Exchange" account type) talks to
 * /mapi/emsmdb (mailbox) and /mapi/nspi (address book).
 * Off by default: the per-account protocol switch `mapi` (docs/protocol-access.md).
 *
 * Environment: MAPI_PORT (3007), MAPI_SESSION_IDLE_MS (1 800 000),
 * MAPI_PENDING_MS (15 000), MAPI_ALLOW_PLAIN_HTTP (false),
 * MAPI_RATE_LIMIT (3000 requests per account and window, 0 = off),
 * MAPI_RATE_WINDOW_SEC (300), MAPI_SESSION_MEMORY_MB (64, open objects per session).
 */
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import {
  createFixedWindowLimiter, createLogger, envLimit, getRedisClient, installProcessGuards, initRuntimeLogLevel,
  LiveConnectionRegistry, resolveBindHost, startAuthInvalidationSubscriber, type CounterStore,
} from '@coremail/core';
import { connectDatabase, waitForObjectStorage, startWebmailPolicySubscriber } from '@coremail/storage';
import { createApp } from './app.js';
import { authenticate } from './http/auth.js';
import { SessionRegistry, type SessionRedis } from './session/registry.js';
import { startForeignAccessWatcher } from './session/foreign-access.js';
import { queueNotificationSource } from './emsmdb/notification-wait.js';
import { startNotificationBus } from './emsmdb/notify/bus.js';
import { createPrismaStore } from './store/prisma-store.js';
import { createEndpointProvider, createPrismaDirectory } from './store/prisma-directory.js';
import { ROP_REGISTRY } from './rop/registry.js';

const log = createLogger('mapi-server');
installProcessGuards(log);
registerLdapMailVerifier();

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const PORT = envInt('MAPI_PORT', 3007);
const IDLE_MS = envInt('MAPI_SESSION_IDLE_MS', 30 * 60_000);
const PENDING_MS = envInt('MAPI_PENDING_MS', 15_000);
const RATE_LIMIT = envLimit('MAPI_RATE_LIMIT', 3000);
const RATE_WINDOW_SEC = envInt('MAPI_RATE_WINDOW_SEC', 300);
const SESSION_MEMORY_BYTES = envInt('MAPI_SESSION_MEMORY_MB', 64) * 1024 * 1024;

async function main(): Promise<void> {
  await connectDatabase();
  void initRuntimeLogLevel('mapi-server', { aliases: ['mapi'] });
  await waitForObjectStorage('mapi-server');

  const live = new LiveConnectionRegistry('mapi');
  live.attachInvalidation();
  startAuthInvalidationSubscriber();
  startWebmailPolicySubscriber(); // 9.4: the app-password module switch applies to MAPI logins at once

  const sessions = new SessionRegistry({
    redis: getRedisClient() as unknown as SessionRedis, live, idleMs: IDLE_MS, memoryLimitBytes: SESSION_MEMORY_BYTES,
  });
  setInterval(() => { void sessions.sweep(); }, 60_000).unref();

  const store = createPrismaStore();
  startNotificationBus({ sessions, store });
  // 9.5: a revoked shared / delegated mailbox grant ends that logon in open sessions at once.
  startForeignAccessWatcher({ sessions, store });
  const app = createApp({
    sessions,
    store,
    rops: ROP_REGISTRY,
    notifications: queueNotificationSource(),
    directory: createPrismaDirectory(),
    endpoints: createEndpointProvider(),
    authenticate,
    limiter: createFixedWindowLimiter({
      scope: 'mapi', limit: RATE_LIMIT, windowSec: RATE_WINDOW_SEC, store: () => getRedisClient() as unknown as CounterStore,
    }),
    config: { pendingMs: PENDING_MS, idleMs: IDLE_MS },
  });
  const host = resolveBindHost();
  const server = app.listen(PORT, host, () => log.info({ port: PORT, host }, 'MAPI server started'));
  // NotificationWait holds a request for up to 5 minutes (+ keep-alives).
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
