import { createLogger } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { createApp } from './app.js';

const log = createLogger('auth-service');
const PORT = parseInt(process.env['AUTH_PORT'] ?? '3001', 10);

async function main() {
  await connectDatabase();
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
