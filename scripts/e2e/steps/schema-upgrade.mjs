// Step 15: schema upgrade from the 8.0.0 schema with the image's coremail-schema-sync.
// Run with: node scripts/e2e/run.mjs schema-upgrade   (needs the e2e stack + git in the repo)
//
// Works on scratch databases in the e2e PostgreSQL (the CoreMail database is not
// touched). For each scenario the 8.0.0 schema (`git show <E2E_SCHEMA_BASE>:…`,
// default d5ad681 = v8.0.0) is pushed with the image's Prisma CLI, rows are
// inserted with SQL, then coremail-schema-sync runs inside the app container
// against that database — exactly what the entrypoint / Helm init container do:
//  A  8.0.0 → current: ResourceBooking uid @unique → @@unique([calendarId, uid]).
//     Prisma reports a data-loss warning, but only a unique constraint is added →
//     applied automatically after the duplicate check (best-effort dump written).
//  B  the same change with duplicate (calendarId, uid) rows → refused, nothing changed.
//  C  a dropped column that holds data → still fail-closed (refused, column kept).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, assert, CONTAINER, STATE_DIR } from '../lib.mjs';

const PG = process.env.E2E_PG_CONTAINER ?? 'coremail-e2e-postgres';
const PG_USER = process.env.E2E_PG_USER ?? 'coremail';
const BASE_REF = process.env.E2E_SCHEMA_BASE ?? 'd5ad681';
const PRISMA = 'node /app/packages/storage/node_modules/prisma/build/index.js';
const OLD_SCHEMA = '/tmp/e2e-schema-base.prisma';
const BACKUP_DIR = '/tmp/e2e-schema-backups';
const DBS = ['e2e_upgrade_a', 'e2e_upgrade_b', 'e2e_upgrade_c'];

function pgPassword() {
  const env = readFileSync(process.env.E2E_ENV_FILE ?? join(STATE_DIR, 'e2e.env'), 'utf8');
  const pw = env.match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1]?.trim();
  assert(pw, 'POSTGRES_PASSWORD missing in the e2e env file');
  return pw;
}

/** psql as the PostgreSQL superuser inside the postgres container. */
function psql(db, sql) {
  return execFileSync('docker', ['exec', PG, 'psql', '-U', PG_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** sh -c <script> in the app container; returns { code, out }. */
function inApp(script, env = {}) {
  const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = spawnSync('docker', ['exec', ...e, CONTAINER, 'sh', '-c', script], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const urlFor = (db) => `postgresql://${PG_USER}:${pgPassword()}@postgres:5432/${db}`;

function freshDb(db) {
  psql('postgres', `DROP DATABASE IF EXISTS ${db}`);
  psql('postgres', `CREATE DATABASE ${db}`);
  const r = inApp(`cd /app/packages/storage && ${PRISMA} db push --skip-generate --schema ${OLD_SCHEMA}`,
    { DATABASE_URL: urlFor(db), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' });
  assert(r.code === 0, `8.0.0 schema push failed: ${r.out.slice(-400)}`);
}

/** Rows without the FK parents (session_replication_role = replica skips FK triggers). */
function booking(id, cal, uid, extra = '') {
  return `('${id}','${cal}','${uid}','s','o',now(),now(),''${extra})`;
}
function insertBookings(db, values, extraCol = '') {
  psql(db, `SET session_replication_role = replica; INSERT INTO resource_bookings(id,"calendarId",uid,summary,organizer,"dtStart","dtEnd","icalData"${extraCol}) VALUES ${values.join(',')}`);
}

function schemaSync(db, env = {}) {
  return inApp('/usr/local/bin/coremail-schema-sync', {
    DATABASE_URL: urlFor(db), MAX_ATTEMPTS: '3', COREMAIL_SCHEMA_BACKUP_DIR: BACKUP_DIR,
    CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', ...env,
  });
}

const indexes = (db) => psql(db, "SELECT indexname FROM pg_indexes WHERE tablename = 'resource_bookings' ORDER BY 1").split('\n');

export async function run() {
  let ready = false;
  await check('schema-upgrade: 8.0.0 schema available', async () => {
    const schema = execFileSync('git', ['show', `${BASE_REF}:packages/storage/prisma/schema.prisma`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert(/uid\s+String\s+@unique/.test(schema), `${BASE_REF} schema has no ResourceBooking uid @unique`);
    execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', `cat > ${OLD_SCHEMA}`], { input: schema });
    const cur = inApp('grep -c "@@unique(\\[calendarId, uid\\])" /app/packages/storage/prisma/schema.prisma');
    assert(cur.out.trim() !== '0', 'image schema has no @@unique([calendarId, uid]) — rebuild the e2e image');
    inApp(`rm -rf ${BACKUP_DIR}`);
    ready = true;
    return `base ${BASE_REF} copied into ${CONTAINER}`;
  });
  if (!ready) return;

  try {
    await check('schema-upgrade: new unique constraint is applied automatically (no duplicates)', async () => {
      const db = DBS[0];
      freshDb(db);
      insertBookings(db, [booking('b1', 'cal1', 'u1'), booking('b2', 'cal2', 'u2')]);
      const r = schemaSync(db);
      assert(r.code === 0, `schema-sync exit ${r.code}: ${r.out.slice(-800)}`);
      assert(/only ADD unique constraints/.test(r.out), 'classifier message missing');
      assert(/no duplicates/.test(r.out), 'duplicate check missing');
      const idx = indexes(db);
      assert(idx.includes('resource_bookings_calendarId_uid_key'), `composite unique index missing: ${idx.join(', ')}`);
      assert(!idx.includes('resource_bookings_uid_key'), 'old uid unique index still present');
      assert(psql(db, 'SELECT count(*) FROM resource_bookings') === '2', 'rows lost');
      const dumps = inApp(`ls ${BACKUP_DIR}`).out.trim();
      assert(/^pre-migrate-.*\.sql\.gz$/m.test(dumps), `no pre-migration dump: ${dumps}`);
      // a second run is a no-op
      const again = schemaSync(db);
      assert(again.code === 0 && /Schema applied \(attempt 1/.test(again.out), `re-run: ${again.out.slice(-300)}`);
      return `applied, rows kept, dump ${dumps.split('\n')[0]}`;
    });

    await check('schema-upgrade: duplicates for the new unique constraint → refused, nothing changed', async () => {
      const db = DBS[1];
      freshDb(db);
      psql(db, 'DROP INDEX resource_bookings_uid_key');   // a drifted 8.0.0 database
      insertBookings(db, [booking('b1', 'cal1', 'dup'), booking('b2', 'cal1', 'dup')]);
      const r = schemaSync(db);
      assert(r.code !== 0, 'schema-sync succeeded despite duplicates');
      assert(/duplicate value group/.test(r.out), `no duplicate message: ${r.out.slice(-500)}`);
      assert(!indexes(db).includes('resource_bookings_calendarId_uid_key'), 'constraint was created');
      assert(psql(db, 'SELECT count(*) FROM resource_bookings') === '2', 'rows changed');
      return 'refused with a duplicate report';
    });

    await check('schema-upgrade: dropped column with data stays fail-closed', async () => {
      const db = DBS[2];
      freshDb(db);
      psql(db, 'ALTER TABLE resource_bookings ADD COLUMN e2e_extra text');
      insertBookings(db, [booking('b1', 'cal1', 'u1', ",'keep-me'")], ',e2e_extra');
      const r = schemaSync(db);
      assert(r.code !== 0, 'schema-sync applied a destructive change without COREMAIL_ALLOW_SCHEMA_DATA_LOSS');
      assert(/would DELETE DATA/.test(r.out), `no data-loss refusal: ${r.out.slice(-500)}`);
      assert(psql(db, 'SELECT e2e_extra FROM resource_bookings') === 'keep-me', 'column data lost');
      assert(!indexes(db).includes('resource_bookings_calendarId_uid_key'), 'partial change applied');
      return 'refused, column and data kept';
    });
  } finally {
    for (const db of DBS) { try { psql('postgres', `DROP DATABASE IF EXISTS ${db}`); } catch { /* ignore */ } }
    inApp(`rm -rf ${BACKUP_DIR} ${OLD_SCHEMA}`);
  }
}
