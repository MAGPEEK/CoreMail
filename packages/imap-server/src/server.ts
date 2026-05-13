import { createLogger } from '@coremail/core';
import { connectDatabase, ensureBuckets } from '@coremail/storage';
import { createImapServer } from './server/index.js';

const log = createLogger('imap:main');

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

async function main() {
  await connectDatabase();
  await ensureBuckets();

  const server = createImapServer();

  server.listen(IMAP_PORT, () => {
    log.info({ port: IMAP_PORT }, 'IMAP server started (STARTTLS)');
  });

  // TLS on port 993 — in production, wrap socket in TLSServer
  server.listen(IMAP_PORT_TLS, () => {
    log.info({ port: IMAP_PORT_TLS }, 'IMAPS server started (TLS)');
  });

  process.on('SIGTERM', () => {
    log.info('Shutting down IMAP server...');
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
