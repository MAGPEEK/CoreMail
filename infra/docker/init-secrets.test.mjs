// Tests for init-secrets.mjs (coremail-init-secrets) and the secrets step of
// entrypoint-app.sh (no database, no container):
//   node --test infra/docker/init-secrets.test.mjs
// File-mode and symlink cases are skipped on Windows; the entrypoint case needs
// a POSIX sh on PATH (Linux, macOS, Git Bash).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALWAYS_KEYS, FRESH_ONLY_KEYS, PASSWORD_FILES, UnsafeSecretsError, atomicWrite, buildDatabaseUrl, decideFresh,
  exportEnv, formatValue, initSecrets, parseEnvFile, pgEnvFromUrl, vapidKeyPair,
} from './init-secrets.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(here, 'init-secrets.mjs');
const ENTRYPOINT = join(here, 'entrypoint-app.sh');
const posixFs = process.platform !== 'win32';
const posix = (p) => p.replace(/\\/g, '/');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

const scratchDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-secrets-'));
  chmodSync(dir, 0o700);
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of scratchDirs) {
    try { chmodSync(d, 0o700); } catch { /* ignore */ }
    rmSync(d, { recursive: true, force: true });
  }
});
const read = (dir, name = 'coremail.env') => readFileSync(join(dir, name), 'utf8');
const values = (dir) => parseEnvFile(read(dir)).values;
const mode = (p) => statSync(p).mode & 0o777;

/** initSecrets with a stub database probe; returns { result, logs, probes }. */
function run(dir, { env = {}, db = 'unreachable' } = {}) {
  const logs = [];
  const probes = [];
  const result = initSecrets({ dir, env, probe: (url) => { probes.push(url); return db; }, log: (m) => logs.push(m) });
  return { result, logs, probes };
}

// ── Generator ────────────────────────────────────────────────────────────────

test('fresh start: every key is generated, formats are right, files are 0600', () => {
  const dir = scratch();
  const { result, logs } = run(dir);
  const v = values(dir);
  for (const k of [...ALWAYS_KEYS, ...FRESH_ONLY_KEYS]) assert.ok(v.get(k), `${k} generated`);
  for (const k of ['JWT_SECRET', 'PEPPER', 'MFA_ENCRYPTION_KEY', 'BACKUP_ENCRYPTION_KEY', 'AUDIT_EXPORT_SIGNING_KEY']) {
    assert.match(v.get(k), /^[0-9a-f]{64}$/, k);
  }
  for (const k of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'RSPAMD_CONTROLLER_PASSWORD']) {
    assert.match(v.get(k), /^[0-9a-f]{48}$/, k);
  }
  assert.equal(v.get('COREMAIL_DB_PASSWORD'), v.get('POSTGRES_PASSWORD'));
  assert.equal(Buffer.from(v.get('VAPID_PUBLIC_KEY'), 'base64url').length, 65);
  assert.equal(Buffer.from(v.get('VAPID_PRIVATE_KEY'), 'base64url').length, 32);
  assert.notEqual(v.get('JWT_SECRET'), v.get('PEPPER'));
  // single-value files for the database containers: no trailing newline
  assert.equal(read(dir, 'postgres-password'), v.get('POSTGRES_PASSWORD'));
  assert.equal(read(dir, 'redis-password'), v.get('REDIS_PASSWORD'));
  assert.equal(read(dir, 'minio-root-password'), v.get('MINIO_ROOT_PASSWORD'));
  assert.equal(read(dir, 'rspamd-controller-password'), v.get('RSPAMD_CONTROLLER_PASSWORD'));
  const text = read(dir);
  assert.match(text, /BACK THIS FILE UP/);
  assert.match(text, /Without PEPPER no password works/);
  assert.equal(parseEnvFile(text).generatedMarker, true);
  assert.equal(result.fresh, true);
  const files = ['coremail.env', 'postgres-password', 'redis-password', 'minio-root-password', 'rspamd-controller-password'];
  assert.deepEqual(result.writes, files);
  if (posixFs) for (const f of files) assert.equal(mode(join(dir, f)), 0o600, f);
  // no temp files left behind
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  // never prints a value
  const printed = logs.join('\n');
  for (const [k, val] of v) assert.ok(!printed.includes(val), `${k} value not printed`);
  assert.match(printed, /generated: JWT_SECRET, PEPPER/);
});

test('second run creates nothing and changes nothing', () => {
  const dir = scratch();
  run(dir);
  const snapshot = () => Object.fromEntries(['coremail.env', ...PASSWORD_FILES.map(([f]) => f)].map((f) => [f, read(dir, f)]));
  const before = snapshot();
  const { result, probes } = run(dir, { db: 'empty' });
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.generated, []);
  assert.equal(probes.length, 0, 'nothing missing → no database probe');
  assert.deepEqual(snapshot(), before);
});

test('existing file: append-only, the old text stays byte-identical, values are never overwritten', () => {
  const dir = scratch();
  const old = '# my notes\nJWT_SECRET=' + 'a'.repeat(64) + '\r\nFOO=bar\nPEPPER="' + 'b'.repeat(64) + '"';
  writeFileSync(join(dir, 'coremail.env'), old, { mode: 0o600 });
  const { result } = run(dir); // database unreachable + file existed → not fresh
  const text = read(dir);
  assert.ok(text.startsWith(old), 'old content untouched');
  const v = values(dir);
  assert.equal(v.get('JWT_SECRET'), 'a'.repeat(64));
  assert.equal(v.get('PEPPER'), 'b'.repeat(64));
  assert.equal(v.get('FOO'), 'bar');
  for (const k of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'RSPAMD_CONTROLLER_PASSWORD']) assert.ok(v.get(k), k);
  assert.ok(!result.generated.includes('JWT_SECRET') && !result.generated.includes('PEPPER'));
  for (const k of FRESH_ONLY_KEYS) assert.equal(v.has(k), false, `${k} not generated for an existing installation`);
  assert.equal(result.fresh, false);
  if (posixFs) assert.equal(mode(join(dir, 'coremail.env')), 0o600);
});

test('fresh-only keys: decided by the database when it answers', () => {
  const existing = scratch();
  const r1 = run(existing, { db: 'existing' });
  for (const k of FRESH_ONLY_KEYS) assert.equal(values(existing).has(k), false, `${k} skipped (users exist)`);
  assert.deepEqual(r1.result.skipped, FRESH_ONLY_KEYS);
  assert.match(r1.logs.join('\n'), /derived from JWT_SECRET \+ PEPPER/);

  // .env installation (JWT_SECRET/PEPPER in the environment) on an EMPTY database → fresh
  const empty = scratch();
  const env = { JWT_SECRET: 'c'.repeat(64), PEPPER: 'd'.repeat(64) };
  const r2 = run(empty, { env, db: 'empty' });
  assert.equal(r2.result.fresh, true);
  const v = values(empty);
  for (const k of FRESH_ONLY_KEYS) assert.ok(v.get(k), `${k} generated`);
  assert.equal(v.get('JWT_SECRET'), env.JWT_SECRET, 'taken from the environment, not generated');
  assert.equal(v.get('PEPPER'), env.PEPPER);
  assert.deepEqual(r2.result.adopted, ['JWT_SECRET', 'PEPPER']);
});

test('fresh-only keys: unreachable database → fresh only without an earlier file and without JWT_SECRET/PEPPER', () => {
  const withEnvSecrets = scratch();
  run(withEnvSecrets, { env: { PEPPER: 'e'.repeat(64) }, db: 'unreachable' });
  for (const k of FRESH_ONLY_KEYS) assert.equal(values(withEnvSecrets).has(k), false, k);

  const uninitialised = scratch();
  run(uninitialised, { db: 'uninitialised' });
  for (const k of FRESH_ONLY_KEYS) assert.ok(values(uninitialised).get(k), k);
});

test('fresh-only keys provided by the environment are copied, not generated (and need no probe)', () => {
  const dir = scratch();
  const env = {
    MFA_ENCRYPTION_KEY: '1'.repeat(64), BACKUP_ENCRYPTION_KEY: '2'.repeat(64), AUDIT_EXPORT_SIGNING_KEY: '3'.repeat(64),
    ...vapidKeyPair(),
  };
  const { probes, result } = run(dir, { env, db: 'existing' });
  assert.equal(probes.length, 0);
  const v = values(dir);
  for (const k of FRESH_ONLY_KEYS) assert.equal(v.get(k), env[k], k);
  assert.ok(result.adopted.includes('MFA_ENCRYPTION_KEY'));
});

test('half a VAPID pair is never completed with a non-matching key', () => {
  const dir = scratch();
  const { result } = run(dir, { env: { VAPID_PUBLIC_KEY: vapidKeyPair().VAPID_PUBLIC_KEY }, db: 'empty' });
  assert.deepEqual(result.incomplete, ['VAPID_PRIVATE_KEY']);
  assert.equal(values(dir).has('VAPID_PRIVATE_KEY'), false);
});

test('existing installation: passwords are taken from DATABASE_URL / REDIS_URL', () => {
  const dir = scratch();
  run(dir, { env: { DATABASE_URL: 'postgresql://coremail:p%40ss@postgres:5432/coremail', REDIS_URL: 'redis://:r3d1s@redis:6379' }, db: 'existing' });
  const v = values(dir);
  assert.equal(v.get('POSTGRES_PASSWORD'), 'p@ss');
  assert.equal(v.get('COREMAIL_DB_PASSWORD'), 'p@ss');
  assert.equal(v.get('REDIS_PASSWORD'), 'r3d1s');
  assert.equal(read(dir, 'postgres-password'), 'p@ss');

  // least-privilege role: its password is COREMAIL_DB_PASSWORD, POSTGRES_PASSWORD stays unknown → generated
  const role = scratch();
  run(role, { env: { DATABASE_URL: 'postgresql://coremail_app:apppw@postgres:5432/coremail' }, db: 'existing' });
  assert.equal(values(role).get('COREMAIL_DB_PASSWORD'), 'apppw');
  assert.match(values(role).get('POSTGRES_PASSWORD'), /^[0-9a-f]{48}$/);
});

test('the probe gets a URL built from the generated passwords', () => {
  const dir = scratch();
  const { probes } = run(dir, { env: { COREMAIL_DB_HOST: 'db.internal' } });
  assert.equal(probes.length, 1);
  const pg = pgEnvFromUrl(probes[0]);
  assert.equal(pg.PGHOST, 'db.internal');
  assert.equal(pg.PGUSER, 'coremail');
  assert.equal(pg.PGPASSWORD, values(dir).get('POSTGRES_PASSWORD'));
  assert.equal(pg.PGDATABASE, 'coremail');
});

test('an empty world-writable directory is tightened to 0700 first (Docker Desktop bind mounts)', { skip: !posixFs && 'POSIX modes' }, () => {
  const ww = scratch();
  chmodSync(ww, 0o777);
  const { logs } = run(ww);
  assert.equal(mode(ww), 0o700);
  assert.ok(values(ww).get('PEPPER'));
  assert.match(logs.join('\n'), /was world-writable and empty \(mode 777\) — changed to 700/);
  // loading never changes modes: a world-writable directory is refused there
  chmodSync(ww, 0o777);
  assert.throws(() => exportEnv({ dir: ww, env: {} }), UnsafeSecretsError);
});

test('unsafe directory or files are refused', { skip: !posixFs && 'POSIX modes/symlinks' }, () => {
  const ww = scratch();
  writeFileSync(join(ww, 'planted'), 'x');
  chmodSync(ww, 0o777);
  assert.throws(() => run(ww), /world-writable \(mode 777\) and is not empty/);
  assert.equal(existsSync(join(ww, 'coremail.env')), false);

  const base = scratch();
  const real = join(base, 'real');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(base, 'link'));
  assert.throws(() => run(join(base, 'link')), UnsafeSecretsError);

  const dir = scratch();
  const outside = join(scratch(), 'outside.env');
  writeFileSync(outside, 'JWT_SECRET=x\n');
  symlinkSync(outside, join(dir, 'coremail.env'));
  assert.throws(() => run(dir), UnsafeSecretsError);
  assert.equal(readFileSync(outside, 'utf8'), 'JWT_SECRET=x\n', 'target untouched');

  const hl = scratch();
  writeFileSync(join(hl, 'coremail.env'), 'JWT_SECRET=x\n', { mode: 0o600 });
  linkSync(join(hl, 'coremail.env'), join(hl, 'second-name'));
  assert.throws(() => run(hl), UnsafeSecretsError);

  assert.throws(() => run(join(base, 'missing')), /does not exist/);
});

test('atomic write replaces a planted symlink instead of following it', { skip: !posixFs && 'POSIX symlinks' }, () => {
  const dir = scratch();
  const outside = join(scratch(), 'victim');
  writeFileSync(outside, 'keep');
  symlinkSync(outside, join(dir, 'redis-password'));
  atomicWrite(dir, 'redis-password', 'new');
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  assert.equal(read(dir, 'redis-password'), 'new');
  assert.equal(mode(join(dir, 'redis-password')), 0o600);
});

test('password files hold the values from the environment (existing .env installation)', () => {
  const dir = scratch();
  const env = { JWT_SECRET: 'a'.repeat(64), PEPPER: 'b'.repeat(64), POSTGRES_PASSWORD: 'pg-from-env',
    REDIS_PASSWORD: 'redis-from-env', MINIO_ROOT_PASSWORD: 'minio-from-env', RSPAMD_CONTROLLER_PASSWORD: 'rspamd-from-env' };
  const { result } = run(dir, { env });
  assert.equal(result.fresh, false, 'JWT_SECRET/PEPPER from the environment → existing installation');
  assert.equal(read(dir, 'postgres-password'), 'pg-from-env');
  assert.equal(read(dir, 'redis-password'), 'redis-from-env');
  assert.equal(read(dir, 'minio-root-password'), 'minio-from-env');
  assert.equal(read(dir, 'rspamd-controller-password'), 'rspamd-from-env');
  const v = values(dir);
  for (const [k, val] of Object.entries(env)) assert.equal(v.get(k), val, k);
  assert.equal(v.get('COREMAIL_DB_PASSWORD'), 'pg-from-env');
  for (const k of FRESH_ONLY_KEYS) assert.equal(v.has(k), false, `${k} not generated for an existing installation`);
});

test('a differing password file is reported, never overwritten', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'postgres-password'), 'old-password', { mode: 0o600 });
  const { logs } = run(dir);
  assert.equal(read(dir, 'postgres-password'), 'old-password');
  assert.match(logs.join('\n'), /postgres-password differs from POSTGRES_PASSWORD/);
});

test('parseEnvFile / formatValue', () => {
  const p = parseEnvFile('# c\n\nexport A=1\nB="two words"\nC=\'x$y\'\r\nbad line\n9X=1\nD=e=f\nA=2\n');
  assert.equal(p.values.get('A'), '2');
  assert.equal(p.values.get('B'), 'two words');
  assert.equal(p.values.get('C'), 'x$y');
  assert.equal(p.values.get('D'), 'e=f');
  assert.deepEqual(p.invalid, ['(no key)', '9X']);
  assert.equal(formatValue('abc-DEF_09.~+/=:@%,'), 'abc-DEF_09.~+/=:@%,');
  assert.equal(formatValue('a b$c#'), "'a b$c#'");
  assert.equal(formatValue("it's\n"), null);
  assert.equal(parseEnvFile(`K=${formatValue('a b$c#')}`).values.get('K'), 'a b$c#');
});

test('decideFresh rule table', () => {
  const t = (dbState, fileExisted, env = {}) => decideFresh({ dbState, fileExisted, env }).fresh;
  assert.equal(t('empty', true, { PEPPER: 'x' }), true);
  assert.equal(t('existing', false), false);
  for (const s of ['unreachable', 'uninitialised']) {
    assert.equal(t(s, false), true, s);
    assert.equal(t(s, true), false, s);
    assert.equal(t(s, false, { JWT_SECRET: 'x' }), false, s);
    assert.equal(t(s, false, { PEPPER: 'x' }), false, s);
    assert.equal(t(s, false, { JWT_SECRET: ' ' }), true, `${s}: blank = unset`);
  }
});

// ── Export for the entrypoint ────────────────────────────────────────────────

test('exportEnv: non-empty environment wins, empty environment falls back to the file', () => {
  const dir = scratch();
  run(dir);
  const v = values(dir);
  const env = { JWT_SECRET: 'f'.repeat(64), PEPPER: '' };
  const { vars, warnings } = exportEnv({ dir, env });
  const out = new Map(vars);
  assert.equal(out.has('JWT_SECRET'), false, 'environment value kept');
  assert.equal(out.get('PEPPER'), v.get('PEPPER'), 'empty environment value → file');
  assert.equal(out.get('DATABASE_URL'), `postgresql://coremail:${v.get('POSTGRES_PASSWORD')}@postgres:5432/coremail`);
  assert.equal(out.get('REDIS_URL'), `redis://:${v.get('REDIS_PASSWORD')}@redis:6379`);
  assert.equal(out.get('COREMAIL_SECRETS_FILE_IN_USE'), 'true');
  assert.equal(out.get('COREMAIL_SECRETS_GENERATED'), 'true');
  assert.match(warnings.join('\n'), /overrides coremail\.env for: JWT_SECRET/);
  assert.ok(!warnings.join('\n').includes('f'.repeat(64)), 'warnings carry names only');
});

test('exportEnv: DATABASE_URL / REDIS_URL from the environment are kept; hosts and roles are configurable', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'coremail.env'), 'POSTGRES_PASSWORD=pg pw\nCOREMAIL_DB_PASSWORD=app/pw\nREDIS_PASSWORD=r\n', { mode: 0o600 });
  const kept = new Map(exportEnv({ dir, env: { DATABASE_URL: 'postgresql://x:y@h/db', REDIS_URL: 'redis://h' } }).vars);
  assert.equal(kept.has('DATABASE_URL'), false);
  assert.equal(kept.has('REDIS_URL'), false);
  assert.equal(kept.get('COREMAIL_SECRETS_GENERATED'), 'false', 'hand-written file');

  const env = { COREMAIL_DB_USER: 'coremail_app', COREMAIL_DB_HOST: 'db', COREMAIL_DB_PORT: '6432', COREMAIL_DB_NAME: 'mail', COREMAIL_REDIS_HOST: 'cache', COREMAIL_REDIS_PORT: '7000' };
  const built = new Map(exportEnv({ dir, env }).vars);
  assert.equal(built.get('DATABASE_URL'), 'postgresql://coremail_app:app%2Fpw@db:6432/mail');
  assert.equal(built.get('REDIS_URL'), 'redis://:r@cache:7000');
  // superuser: POSTGRES_PASSWORD (URL-encoded)
  assert.equal(new Map(exportEnv({ dir, env: {} }).vars).get('DATABASE_URL'), 'postgresql://coremail:pg%20pw@postgres:5432/coremail');
  // an explicit COREMAIL_DB_PASSWORD in the environment wins (Compose semantics)
  const fileOnly = (k) => (k === 'POSTGRES_PASSWORD' ? 'filepw' : '');
  assert.equal(buildDatabaseUrl({ COREMAIL_DB_PASSWORD: 'envpw' }, fileOnly), 'postgresql://coremail:envpw@postgres:5432/coremail');
  assert.equal(buildDatabaseUrl({}, fileOnly), 'postgresql://coremail:filepw@postgres:5432/coremail');
  assert.equal(buildDatabaseUrl({}, () => ''), null, 'no password → no URL');
});

test('exportEnv: only CoreMail secrets are loaded from the file', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'coremail.env'), 'NODE_OPTIONS=--require /tmp/x.js\nLD_PRELOAD=/tmp/x.so\nPATH=/tmp\nDATABASE_URL=postgresql://evil\nCOREMAIL_ALLOW_SCHEMA_DATA_LOSS=true\nJWT_SECRET=' + '9'.repeat(64) + '\n', { mode: 0o600 });
  const { vars, warnings } = exportEnv({ dir, env: {} });
  const keys = vars.map(([k]) => k);
  for (const k of ['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'COREMAIL_ALLOW_SCHEMA_DATA_LOSS']) assert.equal(keys.includes(k), false, k);
  assert.equal(new Map(vars).has('DATABASE_URL'), false, 'no password → no URL; the file cannot set it');
  assert.ok(keys.includes('JWT_SECRET'));
  assert.match(warnings.join('\n'), /ignored \(not a CoreMail secret\): NODE_OPTIONS, LD_PRELOAD, PATH, DATABASE_URL, COREMAIL_ALLOW_SCHEMA_DATA_LOSS/);
});

test('exportEnv: without a secrets directory only URLs and markers are produced', () => {
  const none = new Map(exportEnv({ dir: join(scratch(), 'absent'), env: { POSTGRES_PASSWORD: 'p', REDIS_PASSWORD: 'r' } }).vars);
  assert.equal(none.get('DATABASE_URL'), 'postgresql://coremail:p@postgres:5432/coremail');
  assert.equal(none.get('REDIS_URL'), 'redis://:r@redis:6379');
  assert.equal(none.get('COREMAIL_SECRETS_FILE_IN_USE'), 'false');
  assert.equal(none.get('COREMAIL_SECRETS_GENERATED'), 'false');
});

test('exportEnv: bundled MinIO credentials only for the bundled service', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'coremail.env'), 'MINIO_ROOT_PASSWORD=m1n10\n', { mode: 0o600 });
  const bundled = new Map(exportEnv({ dir, env: { S3_ENDPOINT: 'http://minio:9000' } }).vars);
  assert.equal(bundled.get('MINIO_SECRET_KEY'), 'm1n10');
  assert.equal(bundled.get('MINIO_ACCESS_KEY'), 'minioadmin');
  assert.equal(bundled.get('S3_SECRET_KEY'), 'm1n10');
  const external = new Map(exportEnv({ dir, env: { OBJECT_STORAGE: 's3', MINIO_ENDPOINT: 's3.example.net', S3_ENDPOINT: 'https://s3.example.net' } }).vars);
  assert.equal(external.has('MINIO_SECRET_KEY'), false);
  assert.equal(external.has('S3_SECRET_KEY'), false);
  const filesystem = new Map(exportEnv({ dir, env: { OBJECT_STORAGE: 'filesystem' } }).vars);
  assert.equal(filesystem.has('MINIO_SECRET_KEY'), false);
  const explicit = new Map(exportEnv({ dir, env: { MINIO_SECRET_KEY: 'own' } }).vars);
  assert.equal(explicit.has('MINIO_SECRET_KEY'), false);
});

// ── CLI ──────────────────────────────────────────────────────────────────────

const cliEnv = (extra = {}) => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '',
  // a database that is certainly not there (connection refused immediately)
  DATABASE_URL: 'postgresql://coremail@127.0.0.1:1/coremail', ...extra,
});

test('CLI: prints key names only; second run adds nothing; refusal exits 2', () => {
  const dir = scratch();
  const first = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { env: cliEnv(), encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /coremail\.env: created/);
  for (const [, val] of values(dir)) assert.ok(!first.stdout.includes(val) && !first.stderr.includes(val));
  const second = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { env: cliEnv(), encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /nothing to add/);
  assert.doesNotMatch(second.stdout, /created/);

  const exp = spawnSync(process.execPath, [SCRIPT, '--export-env', '--dir', dir], { env: cliEnv({ DATABASE_URL: '' }), encoding: 'utf8' });
  assert.equal(exp.status, 0, exp.stderr);
  assert.match(exp.stdout, /^JWT_SECRET=[0-9a-f]{64}$/m);
  assert.match(exp.stdout, /^DATABASE_URL=postgresql:\/\/coremail:[0-9a-f]{48}@postgres:5432\/coremail$/m);

  if (posixFs) {
    const ww = scratch();
    writeFileSync(join(ww, 'coremail.env'), 'JWT_SECRET=planted\n');
    chmodSync(ww, 0o777);
    const refused = spawnSync(process.execPath, [SCRIPT, '--dir', ww], { env: cliEnv(), encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /world-writable/);
  }
  const bad = spawnSync(process.execPath, [SCRIPT, '--bogus'], { env: cliEnv(), encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

// ── entrypoint-app.sh, step 0 ────────────────────────────────────────────────

/** Runs only the secrets step of the real entrypoint, then prints the variables of interest. */
function entrypointStep(dir, env) {
  const text = readFileSync(ENTRYPOINT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('# ── 0. Secrets');
  const end = text.indexOf('# ── 1. Wait for PostgreSQL');
  assert.ok(start > 0 && end > start, 'step 0 markers present');
  const work = scratch();
  const wrapper = join(work, 'init-secrets');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${posix(process.execPath)}" "${posix(SCRIPT)}" "$@"\n`, { mode: 0o755 });
  const show = ['JWT_SECRET', 'PEPPER', 'DATABASE_URL', 'REDIS_URL', 'TRICKY', 'COREMAIL_SECRETS_FILE_IN_USE', 'COREMAIL_SECRETS_GENERATED'];
  const script = 'set -e\nlog() { echo "[entrypoint] $*"; }\n' + text.slice(start, end)
    + show.map((k) => `printf '%s=%s\\n' ${k} "\${${k}-<unset>}"`).join('\n') + '\n';
  const scriptFile = join(work, 'step0.sh');
  writeFileSync(scriptFile, script);
  const r = spawnSync('sh', [posix(scriptFile)], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '', COREMAIL_SECRETS_DIR: posix(dir), COREMAIL_INIT_SECRETS: posix(wrapper), COREMAIL_SECRETS_DB_WAIT: '0', ...env },
    encoding: 'utf8',
  });
  const vars = Object.fromEntries(r.stdout.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, vars };
}

test('entrypoint step 0: generates, loads, environment wins, values are not evaluated', { skip: !hasSh && 'needs sh' }, () => {
  const dir = scratch();
  const first = entrypointStep(dir, { DATABASE_URL: '' });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const v = values(dir);
  assert.equal(first.vars.JWT_SECRET, v.get('JWT_SECRET'));
  assert.equal(first.vars.PEPPER, v.get('PEPPER'));
  assert.equal(first.vars.DATABASE_URL, `postgresql://coremail:${v.get('POSTGRES_PASSWORD')}@postgres:5432/coremail`);
  assert.equal(first.vars.COREMAIL_SECRETS_FILE_IN_USE, 'true');
  assert.equal(first.vars.COREMAIL_SECRETS_GENERATED, 'true');
  assert.match(first.stdout, /Secrets loaded from/);

  // .env installation: its values win, the file only fills gaps
  const kept = entrypointStep(dir, { JWT_SECRET: 'j'.repeat(40), PEPPER: '', DATABASE_URL: 'postgresql://coremail:x@postgres:5432/coremail' });
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(kept.vars.JWT_SECRET, 'j'.repeat(40));
  assert.equal(kept.vars.PEPPER, v.get('PEPPER'));
  assert.equal(kept.vars.DATABASE_URL, 'postgresql://coremail:x@postgres:5432/coremail');

  // a value with shell syntax is exported verbatim, never evaluated
  const tricky = scratch();
  writeFileSync(join(tricky, 'coremail.env'), "JWT_SECRET='$(touch pwned)`id`\\n$HOME'\nPEPPER=" + 'p'.repeat(64) + '\n', { mode: 0o600 });
  const t = entrypointStep(tricky, { DATABASE_URL: 'postgresql://coremail:x@h/db' });
  assert.equal(t.status, 0, t.stderr);
  assert.equal(t.vars.JWT_SECRET, '$(touch pwned)`id`\\n$HOME');
  assert.equal(existsSync('pwned'), false);
});

test('entrypoint step 0: fails clearly without JWT_SECRET/PEPPER and without a secrets directory', { skip: !hasSh && 'needs sh' }, () => {
  const r = entrypointStep(join(scratch(), 'absent'), { DATABASE_URL: 'postgresql://coremail:x@h/db' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /ERROR: missing: JWT_SECRET PEPPER/);
  assert.match(r.stdout, /mount a secrets directory/);
});

test('entrypoint step 0: an unsafe secrets directory stops the start', { skip: (!hasSh || !posixFs) && 'needs sh + POSIX modes' }, () => {
  const dir = scratch();
  writeFileSync(join(dir, 'coremail.env'), 'JWT_SECRET=planted\nPEPPER=planted\n');
  chmodSync(dir, 0o777);
  const r = entrypointStep(dir, {});
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /unsafe|world-writable/);
});
