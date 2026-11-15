import {
  createLogger, installProcessGuards, resolveBindHost, initRuntimeLogLevel, startAuthInvalidationSubscriber,
} from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { createApp } from './app.js';

const log = createLogger('auth-service');
installProcessGuards(log);
const PORT = parseInt(process.env['AUTH_PORT'] ?? '3003', 10);

async function main() {
  await connectDatabase();
  void initRuntimeLogLevel('auth-service', { aliases: ['auth'] }); // BCP per-service log level
  // v7.0.1: apply session revocations performed by other services in-process
  startAuthInvalidationSubscriber();
  // v5.6.0: initJwtKeys() removed — JWT back to HS256 (see core/auth/jwt.ts)
  const app = createApp();
  // v6: internal service — loopback by default (INTERNAL_BIND_HOST overrides)
  const host = resolveBindHost();
  app.listen(PORT, host, () => {
    log.info({ port: PORT, host }, 'Auth service started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
