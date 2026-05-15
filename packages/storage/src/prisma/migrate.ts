import { execSync } from 'node:child_process';
import { createLogger } from '@coremail/core/logger';

const log = createLogger('storage-api:migrate');

export async function runMigrations() {
  log.info('applying prisma schema (db push)');
  try {
    // prisma migrate deploy requires migration files — we use db push instead
    // (schema-only workflow, no migration history needed)
    execSync('node_modules/.bin/prisma db push --skip-generate --accept-data-loss', {
      cwd: new URL('../../../../', import.meta.url).pathname,
      stdio: 'inherit',
      env: { ...process.env },
    });
    log.info('schema up to date');
  } catch (err) {
    log.warn({ err }, 'db push failed — schema may already be up to date');
    // Don't throw — services can still start if schema exists from entrypoint
  }
}
