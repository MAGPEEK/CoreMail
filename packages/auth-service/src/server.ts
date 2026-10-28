import { createLogger } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { createApp } from './app.js';

const log = createLogger('auth-service');
// Port 3001 is reserved for storage-api — auth-service runs on 3003
const PORT = parseInt(process.env['AUTH_PORT'] ?? '3003', 10);

async function main() {
  await connectDatabase();
  // v5.6.0: initJwtKeys() removed — JWT back to HS256 (see core/auth/jwt.ts)
  const app = createApp();
  app.listen(PORT, () => {
    log.info({ port: PORT }, 'Auth service started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
