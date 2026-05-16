import { createLogger } from '@coremail/core';
import { connectDatabase, ensureBuckets } from '@coremail/storage';
import { createImapServer } from './server/index.js';

const log = createLogger('imap:main');

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

async function main() {
  await connectDatabase();
  await ensureBuckets();

  // net.Server kann nur auf EINEM Port gleichzeitig lauschen.
  // Für jeden Port eine eigene Serverinstanz erzeugen.
  const server143 = createImapServer();
  const server993 = createImapServer();

  server143.listen(IMAP_PORT, () => {
    log.info({ port: IMAP_PORT }, 'IMAP server started (STARTTLS)');
  });

  // TLS on port 993 — in production, wrap socket in TLSServer
  server993.listen(IMAP_PORT_TLS, () => {
    log.info({ port: IMAP_PORT_TLS }, 'IMAPS server started (TLS)');
  });

  process.on('SIGTERM', () => {
    log.info('Shutting down IMAP server...');
    server143.close();
    server993.close(() => process.exit(0));
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
