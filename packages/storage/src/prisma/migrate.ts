import { execSync } from 'node:child_process';
import { createLogger } from '@coremail/core/logger';

const log = createLogger('storage-api:migrate');

export async function runMigrations() {
  log.info('running prisma migrations');
  try {
    execSync('npx prisma migrate deploy', {
      cwd: new URL('../../', import.meta.url).pathname,
      stdio: 'inherit',
      env: { ...process.env },
    });
    log.info('migrations complete');
  } catch (err) {
    log.error(err, 'migration failed');
    throw err;
  }
}
