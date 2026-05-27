import { createLogger, initJwtKeys } from '@coremail/core';
import { connectDatabase, prisma } from '@coremail/storage';
import { createApp } from './app.js';

const log = createLogger('auth-service');
// Port 3001 ist für storage-api reserviert — auth-service läuft auf 3003
const PORT = parseInt(process.env['AUTH_PORT'] ?? '3003', 10);

async function main() {
  await connectDatabase();
  // v5.3.0: RS256 JWT-Keys initialisieren (Modern Auth / OAuth2)
  await initJwtKeys(prisma);
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
