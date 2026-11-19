// Tests for schema-sync-classify.mjs (no stack needed):
//   node --test infra/docker/schema-sync-classify.test.mjs
// The fixtures are the verbatim output of `prisma db push` (Prisma 5.22.0,
// postgres:16-alpine), captured from the 8.0.0 → current schema change and from
// a scratch schema with dropped columns/tables, removed enum values and a new
// required column. UPGRADE_9_5 (10.0.0: the room tables are retired) uses the
// same "drop the `x` table" wording as the captured DROPS fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classify, classifyWarning, format, guardSql, loadOptionalColumns, optionalColumnsWithoutDefault, parseWarnings, schemaFromUrl,
  RETIRED_TABLES,
} from './schema-sync-classify.mjs';

// 9.5.x → 10.0.0: the room/equipment tables hold rows and are dropped.
const UPGRADE_9_5 = `
⚠️  There might be data loss when applying the changes:

  • You are about to drop the \`resource_bookings\` table, which is not empty (2 rows).

  • You are about to drop the \`resource_calendars\` table, which is not empty (1 rows).

  • You are about to drop the \`resource_mailboxes\` table, which is not empty (1 rows).


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;
const dropTable = (table, rows = 1) => `  • You are about to drop the \`${table}\` table, which is not empty (${rows} rows).`;
const warnings = (...bullets) => `\n⚠️  There might be data loss when applying the changes:\n\n${bullets.join('\n\n')}\n\n\nError: Use the --accept-data-loss flag\n`;

const UPGRADE_8_0 = `Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "coremail", schema "public" at "postgres:5432"

⚠️  There might be data loss when applying the changes:

  • A unique constraint covering the columns \`[calendarId,uid]\` on the table \`resource_bookings\` will be added. If there are existing duplicate values, this will fail.


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;

const DROPS = `
⚠️  There might be data loss when applying the changes:

  • You are about to drop the column \`extra\` on the \`foos\` table, which still contains 2 non-null values.

  • You are about to drop the \`bars\` table, which is not empty (1 rows).

  • A unique constraint covering the columns \`[name]\` on the table \`foos\` will be added. If there are existing duplicate values, this will fail.

  • A unique constraint covering the columns \`[email,num]\` on the table \`foos\` will be added. If there are existing duplicate values, this will fail.


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;

const ENUM = `
⚠️  There might be data loss when applying the changes:

  • The values [C] on the enum \`Kind\` will be removed. If these variants are still used in the database, this will fail.

  • A unique constraint covering the columns \`[name]\` on the table \`foos\` will be added. If there are existing duplicate values, this will fail.


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;

const UNEXECUTABLE = `
Error:
⚠️ We found changes that cannot be executed:

  • Added the required column \`tag\` to the \`foos\` table without a default value. There are 2 rows in this table, it is not possible to execute this step.

Use the --force-reset flag to drop the database before push like prisma db push --force-reset
All data will be lost.
`;

// 9.4.0 → 9.5: Task gets the optional column uid and @@unique([userId, uid]).
const UPGRADE_9_4 = `
⚠️  There might be data loss when applying the changes:

  • A unique constraint covering the columns \`[userId,uid]\` on the table \`tasks\` will be added. If there are existing duplicate values, this will fail.


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;

const TARGET_SCHEMA = readFileSync(fileURLToPath(new URL('../../packages/storage/prisma/schema.prisma', import.meta.url)), 'utf8');

test('8.0.0 → current: the new composite unique constraint is safe, with a duplicate check', () => {
  const r = classify(UPGRADE_8_0);
  assert.equal(r.verdict, 'safe');
  assert.equal(r.items.length, 1);
  const [u] = r.items;
  assert.equal(u.kind, 'unique');
  assert.equal(u.table, 'resource_bookings');
  assert.deepEqual(u.columns, ['calendarId', 'uid']);
  assert.equal(u.sql, 'SELECT count(*) FROM (SELECT 1 FROM "public"."resource_bookings" WHERE "calendarId" IS NOT NULL AND "uid" IS NOT NULL GROUP BY "calendarId", "uid" HAVING count(*) > 1) AS d');
  // both columns exist in 8.0.0 — the guard only looks for the table
  assert.equal(u.guard, `SELECT CASE WHEN to_regclass('"public"."resource_bookings"') IS NULL THEN 'new-table' ELSE 'check' END`);
});

test('9.4.0 → current: a unique constraint over the new optional Task.uid column is skipped while the column is missing', () => {
  const r = classify(UPGRADE_9_4, 'public', optionalColumnsWithoutDefault(TARGET_SCHEMA));
  assert.equal(r.verdict, 'safe');
  const [u] = r.items;
  assert.equal(u.table, 'tasks');
  assert.deepEqual(u.columns, ['userId', 'uid']);
  assert.equal(u.guard, `SELECT CASE WHEN to_regclass('"public"."tasks"') IS NULL THEN 'new-table' WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name IN ('uid')) < 1 THEN 'new-column' ELSE 'check' END`);
  // once the column exists (a re-run) the real duplicate check runs
  assert.match(u.sql, /GROUP BY "userId", "uid" HAVING count\(\*\) > 1/);
});

test('without the target schema no column counts as optional (fail-closed: the duplicate check must run)', () => {
  const [u] = classify(UPGRADE_9_4).items;
  assert.ok(!u.guard.includes('new-column'));
  assert.equal(loadOptionalColumns('does/not/exist.prisma').size, 0);
});

test('optional columns: only `Type?` without @default, @map/@@map honoured, relations and comments ignored', () => {
  const cols = optionalColumnsWithoutDefault(`
model Foo {
  id      String  @id @default(cuid())
  a       String?
  b       String? @default("x")
  c       String  // looks optional? no: String?
  d       Int?    @map("d_col") // @default(1) in a comment does not count
  e       String[]
  owner   User?   @relation(fields: [a], references: [id])
  @@unique([a, b])
  @@map("foos")
}

model Bar {
  x String?
}
`);
  assert.deepEqual([...cols.get('foos')].sort(), ['a', 'd_col']);
  assert.deepEqual([...cols.get('Bar')], ['x']);
  // the real schema: Task.uid / icalData are optional without default, Contact.uid has a default
  const real = optionalColumnsWithoutDefault(TARGET_SCHEMA);
  assert.ok(real.get('tasks').has('uid') && real.get('tasks').has('icalData'));
  assert.ok(!real.get('contacts').has('uid'));
  assert.ok(!real.has('resource_bookings'), '10.0: the retired room tables are gone from the schema');
});

test('guard SQL for a constraint without optional columns only checks the table', () => {
  assert.equal(guardSql('s', 't', []), `SELECT CASE WHEN to_regclass('"s"."t"') IS NULL THEN 'new-table' ELSE 'check' END`);
  assert.match(guardSql('s', 't', ['a', 'b']), /column_name IN \('a', 'b'\)\) < 2 THEN 'new-column'/);
});

test('dropped column / dropped table stay unsafe even next to unique constraints', () => {
  const r = classify(DROPS);
  assert.equal(r.verdict, 'unsafe');
  assert.deepEqual(r.items.map((i) => i.kind), ['unsafe', 'unsafe', 'unique', 'unique']);
  assert.match(r.items[0].text, /drop the column `extra`/);
  assert.match(r.items[1].text, /drop the `bars` table/);
});

test('removed enum values are unsafe', () => {
  assert.equal(classify(ENUM).verdict, 'unsafe');
});

test('"cannot be executed" is unsafe', () => {
  assert.equal(classify(UNEXECUTABLE).verdict, 'unsafe');
  assert.equal(classify('Error: We found changes that cannot be executed').verdict, 'unsafe');
});

test('no recognised bullet → none (schema-sync treats it as unsafe)', () => {
  assert.equal(classify('Error: Use the --accept-data-loss flag').verdict, 'none');
  assert.equal(classify('').verdict, 'none');
});

test('unusual identifiers and a foreign schema are never auto-applied', () => {
  assert.equal(classifyWarning('A unique constraint covering the columns `[a"b]` on the table `t` will be added. If there are existing duplicate values, this will fail.').kind, 'unsafe');
  assert.equal(classifyWarning('A unique constraint covering the columns `[a]` on the table `t;drop` will be added. If there are existing duplicate values, this will fail.').kind, 'unsafe');
  assert.equal(classifyWarning('A unique constraint covering the columns `[a]` on the table `t` will be added. If there are existing duplicate values, this will fail.', 'x-y').kind, 'unsafe');
  // a slightly different (future) wording is not trusted
  assert.equal(classifyWarning('A unique constraint covering the columns `[a]` on the table `t` will be added.').kind, 'unsafe');
});

test('database schema from DATABASE_URL', () => {
  assert.equal(schemaFromUrl('postgresql://u:p@h:5432/db?schema=e2e_upgrade&connection_limit=5'), 'e2e_upgrade');
  assert.equal(schemaFromUrl('postgresql://u:p@h:5432/db'), 'public');
  const r = classify(UPGRADE_8_0, 'e2e_upgrade');
  assert.match(r.items[0].sql, /FROM "e2e_upgrade"\."resource_bookings"/);
});

test('parseWarnings joins wrapped continuation lines', () => {
  const w = parseWarnings('  • A unique constraint covering the columns `[a]` on the table `t` will be added.\n    If there are existing duplicate values, this will fail.\n\nError: x');
  assert.deepEqual(w, ['A unique constraint covering the columns `[a]` on the table `t` will be added. If there are existing duplicate values, this will fail.']);
});

test('CLI output format (read by schema-sync.sh)', () => {
  const script = fileURLToPath(new URL('./schema-sync-classify.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, 'public'], { input: DROPS, encoding: 'utf8' });
  assert.equal(out, format(classify(DROPS)));
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[0], 'verdict\tunsafe');
  assert.equal(lines.filter((l) => l.startsWith('unique\t')).length, 2);
  assert.ok(lines.filter((l) => l.startsWith('unique\t')).every((l) => l.split('\t').length === 5));
});

test('CLI reads the target schema from COREMAIL_PRISMA_SCHEMA_FILE', () => {
  const script = fileURLToPath(new URL('./schema-sync-classify.mjs', import.meta.url));
  const schemaFile = fileURLToPath(new URL('../../packages/storage/prisma/schema.prisma', import.meta.url));
  const out = execFileSync(process.execPath, [script, 'public'], {
    input: UPGRADE_9_4, encoding: 'utf8', env: { ...process.env, COREMAIL_PRISMA_SCHEMA_FILE: schemaFile },
  });
  const [kind, table, columns, guard] = out.trimEnd().split('\n')[1].split('\t');
  assert.deepEqual([kind, table, columns], ['unique', 'tasks', 'userId,uid']);
  assert.match(guard, /THEN 'new-column'/);
});

// ── 10.0.0: retired tables ───────────────────────────────────────────────────

test('9.5.x → 10.0.0: dropping the room tables is a retirement (dump first, no opt-in)', () => {
  const r = classify(UPGRADE_9_5);
  assert.equal(r.verdict, 'retire');
  assert.deepEqual(r.items.map((i) => [i.kind, i.table, i.rows]), [
    ['retired', 'resource_bookings', 2], ['retired', 'resource_calendars', 1], ['retired', 'resource_mailboxes', 1],
  ]);
  assert.match(r.items[0].reason, /removed in CoreMail 10\.0\.0/);
  assert.deepEqual(Object.keys(RETIRED_TABLES).sort(), ['resource_bookings', 'resource_calendars', 'resource_mailboxes']);
});

test('retired tables next to new unique constraints: still a retirement, the unique items keep their duplicate check', () => {
  const r = classify(`${UPGRADE_9_5}\n${UPGRADE_9_4}`);
  assert.equal(r.verdict, 'retire');
  assert.deepEqual(r.items.map((i) => i.kind).sort(), ['retired', 'retired', 'retired', 'unique']);
});

test('any other drop next to a retired table stays fail-closed', () => {
  assert.equal(classify(warnings(dropTable('resource_bookings'), dropTable('users', 3))).verdict, 'unsafe');
  assert.equal(classify(warnings(dropTable('resource_bookings'),
    '  • You are about to drop the column `extra` on the `foos` table, which still contains 2 non-null values.')).verdict, 'unsafe');
  // a column drop inside a retired table is not a table retirement
  assert.equal(classify(warnings('  • You are about to drop the column `uid` on the `resource_bookings` table, which still contains 2 non-null values.')).verdict, 'unsafe');
  assert.equal(classify(`${UPGRADE_9_5}\n${ENUM}`).verdict, 'unsafe');
  assert.equal(classify(`${UPGRADE_9_5}\nError: We found changes that cannot be executed`).verdict, 'unsafe');
});

test('only exact retired table names qualify (no look-alikes, no qualified names, no prototype keys)', () => {
  for (const table of ['resource_bookings_old', 'public.resource_bookings', 'Resource_Bookings', 'constructor', 'toString', 'bars']) {
    assert.equal(classifyWarning(dropTable(table).replace(/^\s*•\s*/, '')).kind, 'unsafe', table);
  }
  // a different (future) wording is not trusted
  assert.equal(classifyWarning('You are about to drop the `resource_bookings` table.').kind, 'unsafe');
});

test('CLI output lists the retired tables for schema-sync.sh', () => {
  const script = fileURLToPath(new URL('./schema-sync-classify.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, 'public'], { input: UPGRADE_9_5, encoding: 'utf8' });
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[0], 'verdict\tretire');
  const retired = lines.filter((l) => l.startsWith('retired\t')).map((l) => l.split('\t'));
  assert.deepEqual(retired.map((f) => [f[1], f[2]]), [['resource_bookings', '2'], ['resource_calendars', '1'], ['resource_mailboxes', '1']]);
  assert.ok(retired.every((f) => f.length === 4 && /10\.0\.0/.test(f[3])));
  assert.equal(out, format(classify(UPGRADE_9_5)));
});
