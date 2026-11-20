// Tests for schema-sync.sh's retirement path with stub prisma / psql / pg_dump
// (no database, no container):
//   node --test infra/docker/schema-sync.test.mjs
// Needs a POSIX sh on PATH (Linux, macOS, Git Bash); skipped otherwise.
// The real classifier (schema-sync-classify.mjs) and the real target schema are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const posix = (p) => p.replace(/\\/g, '/');
const SCRIPT = posix(join(here, 'schema-sync.sh'));
const CLASSIFIER = posix(join(here, 'schema-sync-classify.mjs'));
const SCHEMA = posix(fileURLToPath(new URL('../../packages/storage/prisma/schema.prisma', import.meta.url)));
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
// the "no psql" case cannot hide a psql installed on the machine
const systemPsql = hasSh && spawnSync('sh', ['-c', 'command -v psql']).status === 0;

// 9.5.x → 10.0.0 (same wording as the classifier fixture UPGRADE_9_5)
const ROOM_WARNINGS = `
⚠️  There might be data loss when applying the changes:

  • You are about to drop the \`resource_bookings\` table, which is not empty (2 rows).

  • You are about to drop the \`resource_calendars\` table, which is not empty (1 rows).

  • You are about to drop the \`resource_mailboxes\` table, which is not empty (1 rows).


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;

/** A scratch dir with stub tools; every call is appended to calls.log. */
function harness({ prismaOut = ROOM_WARNINGS, psqlFails = false, withPsql = true, prismaJs = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-schema-sync-'));
  const bin = join(dir, 'bin');
  const prismaDir = join(dir, 'storage', 'node_modules', 'prisma', 'build');
  mkdirSync(bin, { recursive: true });
  mkdirSync(prismaDir, { recursive: true });
  const log = posix(join(dir, 'calls.log'));
  writeFileSync(join(dir, 'prisma-out.txt'), prismaOut);
  writeFileSync(join(prismaDir, 'index.js'), [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(log)}, 'prisma ' + args.join(' ') + '\\n');`,
    ...(prismaJs ?? [
      "if (args.includes('--accept-data-loss')) { console.log('applied'); process.exit(0); }",
      `process.stdout.write(fs.readFileSync(${JSON.stringify(posix(join(dir, 'prisma-out.txt')))}, 'utf8'));`,
      'process.exit(1);',
    ]),
  ].join('\n'));
  writeFileSync(join(dir, 'storage', 'package.json'), '{"type":"commonjs"}');
  const stub = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  if (withPsql) {
    stub('psql', [
      `q=""; for a in "$@"; do q="$a"; done`,
      `case "$q" in`,
      `  *"WITH doomed"*) echo "psql cleanup" >> "${log}"; ${psqlFails ? 'echo "ERROR:  boom" >&2; exit 1' : 'echo "1 mailbox(es), 2 folder(s), 3 message(s)"'} ;;`,
      `  "SHOW server_version_num") echo 160004 ;;`,
      `  *) echo 0 ;;`,
      `esac`,
    ].join('\n'));
  }
  stub('pg_dump', [
    `if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.4"; exit 0; fi`,
    `out=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done`,
    `echo dump > "$out"; echo "pg_dump" >> "${log}"`,
  ].join('\n'));
  const run = (env = {}) => {
    const r = spawnSync('sh', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        DATABASE_URL: 'postgresql://u:p@db:5432/coremail?schema=public',
        COREMAIL_STORAGE_PKG: posix(join(dir, 'storage')),
        COREMAIL_SCHEMA_CLASSIFIER: CLASSIFIER,
        COREMAIL_PRISMA_SCHEMA_FILE: SCHEMA,
        COREMAIL_SCHEMA_BACKUP_DIR: posix(join(dir, 'backups')),
        MAX_ATTEMPTS: '1',
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
  };
  const dumps = () => (existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')) : []);
  return { dir, run, dumps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('retirement: dump first, then the room mailbox clean-up, then the push — no opt-in needed', { skip: !hasSh && 'no sh' }, () => {
  const h = harness();
  try {
    const r = h.run();
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ['prisma db push --skip-generate', 'pg_dump', 'psql cleanup', 'prisma db push --skip-generate --accept-data-loss']);
    assert.match(r.out, /Removed the mailboxes of the former room\/equipment mailboxes \(retired table resource_mailboxes\): 1 mailbox\(es\), 2 folder\(s\), 3 message\(s\)/);
    assert.match(r.out, /retired tables dropped/);
    assert.equal(h.dumps().length, 1);
  } finally { h.cleanup(); }
});

test('retirement: a failing clean-up stops the start before the push (fail-closed)', { skip: !hasSh && 'no sh' }, () => {
  const h = harness({ psqlFails: true });
  try {
    const r = h.run();
    assert.notEqual(r.code, 0);
    assert.match(r.out, /removing the mailboxes of the former room\/equipment mailboxes \(retired table resource_mailboxes\) failed: ERROR: {2}boom/);
    assert.ok(!r.calls.some((c) => c.includes('--accept-data-loss')), 'push ran after a failed clean-up');
  } finally { h.cleanup(); }
});

test('retirement: no dump possible → nothing deleted, the message names the Helm values', { skip: !hasSh && 'no sh' }, () => {
  const h = harness();
  try {
    // the backup directory cannot be created (a file is in the way), as on a read-only root FS
    writeFileSync(join(h.dir, 'blocker'), '');
    const r = h.run({ COREMAIL_SCHEMA_BACKUP_DIR: posix(join(h.dir, 'blocker', 'backups')) });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /cannot write the pre-migration dump/);
    assert.match(r.out, /app\.schemaSync\.backupClaim/);
    assert.ok(!r.calls.some((c) => c === 'psql cleanup' || c.includes('--accept-data-loss')));
  } finally { h.cleanup(); }
});

test('retirement without psql stops before anything is deleted or dropped', { skip: (!hasSh && 'no sh') || (systemPsql && 'psql installed on this machine') }, () => {
  const h = harness({ withPsql: false });
  try {
    const r = h.run({ COREMAIL_SCHEMA_BACKUP: 'skip' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /psql is not available — cannot remove the data of the retired tables/);
    assert.ok(!r.calls.some((c) => c.includes('--accept-data-loss')));
  } finally { h.cleanup(); }
});

test('an unrelated data loss next to the room tables: refused without opt-in; with opt-in the room mailboxes are cleaned up too', { skip: !hasSh && 'no sh' }, () => {
  const mixed = ROOM_WARNINGS.replace('\n\nError:', '\n  • You are about to drop the column `extra` on the `tasks` table, which still contains 2 non-null values.\n\nError:');
  const h = harness({ prismaOut: mixed });
  try {
    const refused = h.run();
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /would DELETE DATA/);
    assert.deepEqual(refused.calls, ['prisma db push --skip-generate'], 'nothing but the first push attempt');
    const allowed = h.run({ COREMAIL_ALLOW_SCHEMA_DATA_LOSS: 'true' });
    assert.equal(allowed.code, 0, allowed.out);
    assert.deepEqual(allowed.calls.slice(1), ['prisma db push --skip-generate', 'pg_dump', 'psql cleanup', 'prisma db push --skip-generate --accept-data-loss']);
  } finally { h.cleanup(); }
});

// ── 10.2: optional extension pg_trgm ─────────────────────────────────────────
// The stub fails like `prisma db push` as the least-privilege app role on a database
// without pg_trgm while the pushed schema still needs it; a schema without the
// extension (the degraded copy) is applied. The copy is saved for the assertions.
const NO_CREATE = 'Error: ERROR: permission denied to create extension "pg_trgm"\nHINT: Must have CREATE privilege on current database to create this extension.\n';
function trgmStub(dir, failure = NO_CREATE) {
  const copy = posix(join(dir, 'pushed-schema.prisma'));
  return [
    'const at = args.indexOf(\'--schema\');',
    `const schema = fs.readFileSync(at >= 0 ? args[at + 1] : ${JSON.stringify(SCHEMA)}, 'utf8');`,
    `if (at >= 0) fs.writeFileSync(${JSON.stringify(copy)}, schema);`,
    `if (/gin_trgm_ops|extensions\\s*=\\s*\\[pg_trgm\\]/.test(schema)) { process.stdout.write(${JSON.stringify(failure)}); process.exit(1); }`,
    "console.log('Your database is now in sync with your Prisma schema.');",
  ];
}

test('pg_trgm unavailable: the schema is applied once more without the tagged lines, with a warning', { skip: !hasSh && 'no sh' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-schema-sync-trgm-'));
  const h = harness({ prismaJs: trgmStub(dir) });
  try {
    const r = h.run();
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls.length, 2, r.calls.join('\n'));
    assert.equal(r.calls[0], 'prisma db push --skip-generate');
    assert.match(r.calls[1], /^prisma db push --skip-generate --schema \S+\.schema\.prisma$/);
    assert.match(r.out, /WARNING: the database cannot provide the PostgreSQL extension pg_trgm/);
    assert.match(r.out, /WITHOUT the trigram index of the mail search \(messages_search_trgm_idx\)/);
    assert.match(r.out, /CREATE EXTENSION IF NOT EXISTS pg_trgm;/);
    assert.ok(!r.calls.some((c) => c.includes('--accept-data-loss') || c === 'pg_dump'), 'no dump, no data-loss push');
    const pushed = readFileSync(join(dir, 'pushed-schema.prisma'), 'utf8');
    const full = readFileSync(SCHEMA, 'utf8');
    assert.deepEqual(pushed.split('\n'), full.split('\n').filter((l) => !/schema-sync:optional pg_trgm/.test(l)), 'only the tagged lines are left out');
    assert.equal(h.dumps().length, 0);
  } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('another failure is not mistaken for a missing optional extension (no degraded push)', { skip: !hasSh && 'no sh' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-schema-sync-trgm-'));
  const h = harness({ prismaJs: trgmStub(dir, 'Error: ERROR: permission denied for table messages\n') });
  try {
    const r = h.run();
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.calls, ['prisma db push --skip-generate']);
    assert.doesNotMatch(r.out, /cannot provide the PostgreSQL extension/);
  } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
