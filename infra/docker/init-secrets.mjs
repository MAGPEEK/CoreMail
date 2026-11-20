#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CoreMail — secrets generator (in the image: /usr/local/lib/coremail/init-secrets.mjs).
// Internal: run only by entrypoint-app.sh at every start of the coremail
// container, there is no command for it on PATH.
//
//   init-secrets.mjs [--dir <dir>] [--db-wait <seconds>]
//
// Creates <dir>/coremail.env (default dir: $COREMAIL_SECRETS_DIR or /secrets)
// with random secrets. An existing file is never rewritten: only keys that are
// missing are appended. Also writes the single-value files (one line, no
// newline) that the infrastructure containers of the Compose files read when
// their variable is empty: <dir>/postgres-password (POSTGRES_PASSWORD_FILE,
// pg-backup), <dir>/redis-password (redis), <dir>/minio-root-password (MinIO)
// and <dir>/rspamd-controller-password (rspamd). All files are 0600, written
// atomically (temp file + fsync + rename). Only key NAMES are printed, never values.
//
// Keys (docs/setup.md, "Automatic secrets"):
//   always       JWT_SECRET, PEPPER (64 hex), POSTGRES_PASSWORD (+ the same value
//                as COREMAIL_DB_PASSWORD), REDIS_PASSWORD, MINIO_ROOT_PASSWORD,
//                RSPAMD_CONTROLLER_PASSWORD (48 hex, URL-safe)
//   fresh only   MFA_ENCRYPTION_KEY, BACKUP_ENCRYPTION_KEY, AUDIT_EXPORT_SIGNING_KEY,
//                VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY — only for a FRESH installation.
//                Existing installations derive these from JWT_SECRET + PEPPER (or do
//                without); a new MFA key would break every enrolled TOTP login.
// A key the environment already provides (non-empty) is copied into the file
// instead of being generated, so the file holds the values that are in effect.
// POSTGRES_PASSWORD / COREMAIL_DB_PASSWORD / REDIS_PASSWORD are also taken from
// DATABASE_URL / REDIS_URL when the environment has those.
//
// "Fresh installation":
//   1. The database answers (DATABASE_URL, or built from the passwords):
//      fresh ⇔ the users table is empty AND the setup was never completed.
//   2. The database is unreachable or has no schema yet (the generator runs
//      before PostgreSQL is up): fresh ⇔ there was no coremail.env before this
//      run AND the environment has neither JWT_SECRET nor PEPPER.
//
// Safety: refuses (exit 2) when <dir> is a symlink, not a directory or
// world-writable, or when a target file is a symlink / not a regular file /
// hard-linked. Existing files are opened with O_NOFOLLOW. Exception: an EMPTY
// world-writable directory (Docker Desktop shows Windows bind mounts as 0777)
// is changed to 0700 first — with nobody else able to write and nothing in it,
// nothing can have been planted.
//
// Internal mode for entrypoint-app.sh:
//   init-secrets.mjs --export-env
// prints KEY=value lines for the entrypoint to export: the secrets file's values
// for keys the environment does not set (a non-empty environment value wins),
// DATABASE_URL / REDIS_URL built from the passwords when unset, and the markers
// COREMAIL_SECRETS_FILE_IN_USE / COREMAIL_SECRETS_GENERATED. Refuses to print to
// a terminal. Only the keys in LOADABLE_KEYS are ever taken from the file.
//
// Node 18+, built-ins only (runs before any CoreMail package is loaded).
// ─────────────────────────────────────────────────────────────────────────────
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRETS_FILE = 'coremail.env';
export const POSTGRES_PASSWORD_FILE = 'postgres-password';
export const REDIS_PASSWORD_FILE = 'redis-password';
export const MINIO_PASSWORD_FILE = 'minio-root-password';
export const RSPAMD_PASSWORD_FILE = 'rspamd-controller-password';
/** Single-value files (file name, key) for the infrastructure containers. */
export const PASSWORD_FILES = [
  [POSTGRES_PASSWORD_FILE, 'POSTGRES_PASSWORD'],
  [REDIS_PASSWORD_FILE, 'REDIS_PASSWORD'],
  [MINIO_PASSWORD_FILE, 'MINIO_ROOT_PASSWORD'],
  [RSPAMD_PASSWORD_FILE, 'RSPAMD_CONTROLLER_PASSWORD'],
];

/** Generated for every installation (in this order). */
export const ALWAYS_KEYS = [
  'JWT_SECRET', 'PEPPER', 'POSTGRES_PASSWORD', 'COREMAIL_DB_PASSWORD',
  'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'RSPAMD_CONTROLLER_PASSWORD',
];
/** Generated only for a fresh installation; groups are generated together. */
export const FRESH_ONLY_GROUPS = [
  ['MFA_ENCRYPTION_KEY'], ['BACKUP_ENCRYPTION_KEY'], ['AUDIT_EXPORT_SIGNING_KEY'],
  ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
];
export const FRESH_ONLY_KEYS = FRESH_ONLY_GROUPS.flat();
/**
 * The only keys --export-env takes from the file. Anything else is ignored with a
 * warning: the root entrypoint loads this file, so it must never be able to set
 * NODE_OPTIONS, LD_PRELOAD, PATH, DATABASE_URL or COREMAIL_ALLOW_SCHEMA_DATA_LOSS.
 */
export const LOADABLE_KEYS = new Set([...ALWAYS_KEYS, ...FRESH_ONLY_KEYS, 'COREMAIL_DB_USER', 'MINIO_ROOT_USER']);

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9._~+/=:@%,-]*$/;
// Comment written before generated keys. Also matches the marker of files
// written by 10.4.0/10.4.1 (the generator's former command name before "secrets").
const MARKER_GENERATED_RE = /^# (?:[a-z-]+-)?secrets \S+ - generated:/m;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Exit code 2: the directory or a file is unsafe — never continue. */
export class UnsafeSecretsError extends Error {
  constructor(message) { super(message); this.name = 'UnsafeSecretsError'; }
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// ── Value generators ─────────────────────────────────────────────────────────

const hex = (bytes) => randomBytes(bytes).toString('hex');
/** 64 hex characters = 32 bytes (JWT_SECRET, PEPPER, encryption/signing keys). */
export const key256 = () => hex(32);
/** Strong random password, URL- and shell-safe (48 hex characters = 192 bits). */
export const password = () => hex(24);

/** VAPID key pair (P-256) in the web-push format: base64url, uncompressed public point. */
export function vapidKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return { VAPID_PUBLIC_KEY: point.toString('base64url'), VAPID_PRIVATE_KEY: priv.d };
}

const GENERATORS = {
  JWT_SECRET: key256, PEPPER: key256,
  POSTGRES_PASSWORD: password, REDIS_PASSWORD: password,
  MINIO_ROOT_PASSWORD: password, RSPAMD_CONTROLLER_PASSWORD: password,
  MFA_ENCRYPTION_KEY: key256, BACKUP_ENCRYPTION_KEY: key256, AUDIT_EXPORT_SIGNING_KEY: key256,
};

// ── env file format ──────────────────────────────────────────────────────────

/**
 * Parses KEY=value lines. Blank lines and `#` comments are skipped, an optional
 * `export ` prefix and one pair of matching surrounding quotes are removed, a
 * trailing CR (file edited on Windows) is dropped. No interpolation, no escapes.
 * Later duplicates win.
 */
export function parseEnvFile(text) {
  const values = new Map();
  const invalid = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const t = line.trimStart();
    if (t === '' || t.startsWith('#')) continue;
    const body = t.startsWith('export ') ? t.slice(7).trimStart() : t;
    const eq = body.indexOf('=');
    const key = eq > 0 ? body.slice(0, eq).trim() : '';
    if (!KEY_RE.test(key)) { invalid.push(key || '(no key)'); continue; }
    let value = body.slice(eq + 1);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return { values, invalid, generatedMarker: MARKER_GENERATED_RE.test(text ?? '') };
}

/** A value as written to the file, or null when it cannot be represented on one line. */
export function formatValue(v) {
  if (SAFE_VALUE_RE.test(v)) return v;
  if (!/['\n\r\0]/.test(v)) return `'${v}'`;
  return null;
}

export const FILE_HEADER = [
  '# ─────────────────────────────────────────────────────────────────────────',
  '# CoreMail secrets — created by the coremail container (docs/setup.md).',
  '#',
  '# BACK THIS FILE UP — off this server (password manager, offline copy).',
  '# Without PEPPER no password works. Without JWT_SECRET + PEPPER (or',
  '# MFA_ENCRYPTION_KEY / BACKUP_ENCRYPTION_KEY) enrolled two-factor logins,',
  '# stored certificate keys and encrypted backups cannot be read.',
  '#',
  '# Format: KEY=value, one per line. A non-empty value in the container',
  '# environment (.env, Compose, Kubernetes) takes precedence over this file.',
  '# Never change PEPPER, JWT_SECRET or MFA_ENCRYPTION_KEY of a running',
  '# installation. Missing keys are appended on the next start; nothing in',
  '# this file is ever overwritten.',
  '# ─────────────────────────────────────────────────────────────────────────',
  '',
].join('\n');

// ── File system helpers ──────────────────────────────────────────────────────

/**
 * The secrets directory must be a real directory (no symlink) that is not
 * world-writable. Returns false when it does not exist.
 *
 * `tighten` (generator only): an EMPTY world-writable directory — typically a
 * bind mount that Docker Desktop created on a Windows host (shown as 0777) — is
 * first changed to 0700 and then checked again: once nobody else can write,
 * an empty directory cannot hold a planted file. A non-empty world-writable
 * directory is always refused.
 */
export function checkSecretsDir(dir, { tighten = false, log = () => {} } = {}) {
  let st;
  try { st = lstatSync(dir); } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (st.isSymbolicLink()) throw new UnsafeSecretsError(`${dir} is a symbolic link — refusing (mount a real directory)`);
  if (!st.isDirectory()) throw new UnsafeSecretsError(`${dir} is not a directory`);
  if (process.platform === 'win32' || !(st.mode & 0o002)) return true;
  const was = (st.mode & 0o7777).toString(8);
  const refuse = (why) => new UnsafeSecretsError(`${dir} is world-writable (mode ${was})${why} — anyone could plant a secrets file. Fix: chmod o-w ${dir}`);
  if (!tighten) throw refuse('');
  try { chmodSync(dir, 0o700); } catch { throw refuse(' and cannot be changed'); }
  const now = lstatSync(dir);
  if (now.isSymbolicLink() || !now.isDirectory() || (now.mode & 0o002)) throw refuse(' and stays so after chmod');
  if (readdirSync(dir).length > 0) throw refuse(' and is not empty');
  log(`${dir}: was world-writable and empty (mode ${was}) — changed to 700`);
  return true;
}

/** Reads a secrets file without following symlinks; null when it does not exist. */
export function readSecretFile(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW); } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') throw new UnsafeSecretsError(`${path} is a symbolic link — refusing`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafeSecretsError(`${path} is not a regular file — refusing`);
    if (st.nlink > 1) throw new UnsafeSecretsError(`${path} has ${st.nlink} hard links — refusing`);
    if (st.size > 1024 * 1024) throw new UnsafeSecretsError(`${path} is larger than 1 MB — refusing`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally { closeSync(fd); }
}

/** Atomic write: exclusive temp file (0600) in the same directory, fsync, rename, fsync dir. */
export function atomicWrite(dir, name, content, mode = 0o600) {
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.tmp-${hex(6)}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, mode);
  try {
    try { fchmodSync(fd, mode); } catch { /* filesystem without modes */ }
    const buf = Buffer.from(content, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  closeSync(fd);
  try { renameSync(tmp, target); } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try {
    const dfd = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* not supported on this platform/filesystem */ }
}

// ── Effective configuration ──────────────────────────────────────────────────

const PG_SUPERUSER_DEFAULT = 'coremail';

/** Passwords contained in DATABASE_URL / REDIS_URL (for adopting existing installations). */
export function passwordsFromUrls(env) {
  const out = {};
  if (nonEmpty(env.DATABASE_URL)) {
    try {
      const u = new URL(env.DATABASE_URL);
      const user = decodeURIComponent(u.username);
      const pw = decodeURIComponent(u.password);
      if (pw) {
        if (user === (nonEmpty(env.POSTGRES_USER) ? env.POSTGRES_USER : PG_SUPERUSER_DEFAULT)) out.POSTGRES_PASSWORD = pw;
        else out.COREMAIL_DB_PASSWORD = pw;
      }
    } catch { /* not a URL — ignore */ }
  }
  if (nonEmpty(env.REDIS_URL)) {
    try {
      const pw = decodeURIComponent(new URL(env.REDIS_URL).password);
      if (pw) out.REDIS_PASSWORD = pw;
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * DATABASE_URL built like the Compose files do:
 *   postgresql://<COREMAIL_DB_USER|coremail>:<password>@<COREMAIL_DB_HOST|postgres>:<COREMAIL_DB_PORT|5432>/<COREMAIL_DB_NAME|coremail>
 * password: COREMAIL_DB_PASSWORD from the environment; for the superuser
 * POSTGRES_PASSWORD; for another role COREMAIL_DB_PASSWORD from the file.
 * `get(key)` returns the effective value (environment first, then the file).
 */
export function buildDatabaseUrl(env, get) {
  const user = nonEmpty(env.COREMAIL_DB_USER) ? env.COREMAIL_DB_USER.trim() : (get('COREMAIL_DB_USER') || PG_SUPERUSER_DEFAULT);
  const superuser = nonEmpty(env.POSTGRES_USER) ? env.POSTGRES_USER.trim() : PG_SUPERUSER_DEFAULT;
  let pw;
  if (nonEmpty(env.COREMAIL_DB_PASSWORD)) pw = env.COREMAIL_DB_PASSWORD;
  else if (user === superuser) pw = get('POSTGRES_PASSWORD');
  else pw = get('COREMAIL_DB_PASSWORD') || get('POSTGRES_PASSWORD');
  if (!pw) return null;
  const host = nonEmpty(env.COREMAIL_DB_HOST) ? env.COREMAIL_DB_HOST.trim() : 'postgres';
  const port = nonEmpty(env.COREMAIL_DB_PORT) ? env.COREMAIL_DB_PORT.trim() : '5432';
  const db = nonEmpty(env.COREMAIL_DB_NAME) ? env.COREMAIL_DB_NAME.trim() : 'coremail';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@${host}:${port}/${encodeURIComponent(db)}`;
}

/** REDIS_URL: redis://:<REDIS_PASSWORD>@<COREMAIL_REDIS_HOST|redis>:<COREMAIL_REDIS_PORT|6379> */
export function buildRedisUrl(env, get) {
  const pw = get('REDIS_PASSWORD');
  if (!pw) return null;
  const host = nonEmpty(env.COREMAIL_REDIS_HOST) ? env.COREMAIL_REDIS_HOST.trim() : 'redis';
  const port = nonEmpty(env.COREMAIL_REDIS_PORT) ? env.COREMAIL_REDIS_PORT.trim() : '6379';
  return `redis://:${encodeURIComponent(pw)}@${host}:${port}`;
}

/**
 * Credentials of the BUNDLED MinIO container (what the Compose files map from
 * MINIO_ROOT_USER/_PASSWORD today). Only when the environment leaves them empty
 * and points at the bundled service — an external S3 keeps its own keys.
 */
export function bundledMinioCredentials(env, get) {
  const out = {};
  const pw = get('MINIO_ROOT_PASSWORD');
  if (!pw) return out;
  const user = get('MINIO_ROOT_USER') || 'minioadmin';
  const storage = (env.OBJECT_STORAGE ?? '').trim();
  const endpoint = (env.MINIO_ENDPOINT ?? '').trim();
  if (!nonEmpty(env.MINIO_SECRET_KEY) && (storage === '' || storage === 'minio') && (endpoint === '' || endpoint === 'minio')) {
    out.MINIO_SECRET_KEY = pw;
    if (!nonEmpty(env.MINIO_ACCESS_KEY)) out.MINIO_ACCESS_KEY = user;
  }
  if (!nonEmpty(env.S3_SECRET_KEY) && /^https?:\/\/minio(:9000)?\/?$/.test((env.S3_ENDPOINT ?? '').trim())) {
    out.S3_SECRET_KEY = pw;
    if (!nonEmpty(env.S3_ACCESS_KEY)) out.S3_ACCESS_KEY = user;
  }
  return out;
}

// ── Database probe ───────────────────────────────────────────────────────────

/** libpq environment for a postgres URL (password never on the command line). */
export function pgEnvFromUrl(url) {
  const u = new URL(url);
  const env = {
    PGHOST: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, '')),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    PGCONNECT_TIMEOUT: '5',
  };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/**
 * State of the target database:
 *   'empty'         reachable, schema present, no users, setup never completed
 *   'existing'      reachable, users present or setup completed
 *   'uninitialised' reachable, no CoreMail schema yet
 *   'unreachable'   no connection (or psql missing / query failed)
 * Retries an unreachable database for up to `waitSec` seconds.
 */
export function probeDatabase(url, { psql = 'psql', waitSec = 0, sleep = sleepSync } = {}) {
  let pgEnv;
  try { pgEnv = pgEnvFromUrl(url); } catch { return 'unreachable'; }
  const run = (sql) => {
    const r = spawnSync(psql, ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...pgEnv },
      encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 ? String(r.stdout).trim() : null;
  };
  const deadline = Date.now() + Math.max(0, waitSec) * 1000;
  for (;;) {
    const schema = run("SELECT to_regclass('public.users') IS NOT NULL");
    if (schema === 'f') return 'uninitialised';
    if (schema === 't') {
      const users = run('SELECT count(*) FROM public.users');
      if (users === null || !/^\d+$/.test(users)) return 'unreachable';
      if (Number(users) > 0) return 'existing';
      // Pre-v6 schemas have no setup flag — then "no users" alone decides.
      const done = run('SELECT count(*) FROM public.server_settings WHERE "setupCompletedAt" IS NOT NULL');
      return done !== null && /^[1-9]\d*$/.test(done) ? 'existing' : 'empty';
    }
    if (Date.now() >= deadline) return 'unreachable';
    sleep(2000);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The fresh-installation rule (see the file header). */
export function decideFresh({ dbState, fileExisted, env }) {
  if (dbState === 'empty') return { fresh: true, reason: 'the database has no users and the setup was never completed' };
  if (dbState === 'existing') return { fresh: false, reason: 'the database already has users or a completed setup' };
  const envSecrets = nonEmpty(env.JWT_SECRET) || nonEmpty(env.PEPPER);
  if (!fileExisted && !envSecrets) {
    return { fresh: true, reason: `database ${dbState}, no previous ${SECRETS_FILE} and no JWT_SECRET/PEPPER in the environment` };
  }
  return {
    fresh: false,
    reason: `database ${dbState} and ${fileExisted ? `${SECRETS_FILE} existed before` : 'JWT_SECRET/PEPPER come from the environment'} — treated as an existing installation`,
  };
}

// ── Generate ─────────────────────────────────────────────────────────────────

/**
 * Creates or extends <dir>/coremail.env and the password files.
 * Returns a summary (key names only). Throws UnsafeSecretsError for an unsafe
 * directory/file. `probe(url)` defaults to probeDatabase.
 */
export function initSecrets({ dir, env = process.env, probe, now = new Date(), dbWait = 0, log = () => {} } = {}) {
  if (!checkSecretsDir(dir, { tighten: true, log })) throw new Error(`${dir} does not exist — create it (mkdir -m 700 secrets) and mount it at ${dir}`);
  const filePath = join(dir, SECRETS_FILE);
  const existing = readSecretFile(filePath);
  const fileExisted = existing !== null;
  const parsed = parseEnvFile(existing);
  const fromFile = (k) => (nonEmpty(parsed.values.get(k)) ? parsed.values.get(k) : '');
  const urlPasswords = passwordsFromUrls(env);
  const fromEnv = (k) => (nonEmpty(env[k]) ? env[k] : (urlPasswords[k] ?? ''));

  const added = new Map(); // key → value
  const generated = [];
  const adopted = [];
  const copied = [];
  const unrepresentable = [];
  const take = (k, v, source) => {
    added.set(k, v);
    ({ generated, environment: adopted, copy: copied })[source].push(k);
  };
  const adopt = (k) => {
    const v = fromEnv(k);
    if (!v) return false;
    if (formatValue(v) === null) { unrepresentable.push(k); return true; }
    take(k, v, 'environment');
    return true;
  };
  const value = (k) => fromFile(k) || added.get(k) || '';

  for (const k of ALWAYS_KEYS) {
    if (fromFile(k) || adopt(k)) continue;
    if (k === 'COREMAIL_DB_PASSWORD') {
      // Same value as POSTGRES_PASSWORD (compatibility: the app connects as the
      // superuser "coremail" unless COREMAIL_DB_USER names another role).
      if (value('POSTGRES_PASSWORD')) take(k, value('POSTGRES_PASSWORD'), 'copy');
      continue;
    }
    take(k, GENERATORS[k](), 'generated');
  }

  // Fresh-only keys: from the file, else from the environment, else generated
  // only for a fresh installation.
  const pendingGroups = [];
  const incomplete = [];
  for (const group of FRESH_ONLY_GROUPS) {
    const missing = group.filter((k) => !fromFile(k) && !adopt(k));
    if (missing.length === 0) continue;
    if (missing.length < group.length) { incomplete.push(...missing); continue; }
    pendingGroups.push(group);
  }
  let freshness = null;
  const skipped = [];
  if (pendingGroups.length > 0) {
    let dbState = 'unreachable';
    const url = nonEmpty(env.DATABASE_URL) ? env.DATABASE_URL : buildDatabaseUrl(env, (k) => fromEnv(k) || value(k));
    if (url) dbState = (probe ?? ((u) => probeDatabase(u, { waitSec: dbWait })))(url);
    freshness = { dbState, ...decideFresh({ dbState, fileExisted, env }) };
    for (const group of pendingGroups) {
      if (!freshness.fresh) { skipped.push(...group); continue; }
      if (group[0] === 'VAPID_PUBLIC_KEY') {
        const pair = vapidKeyPair();
        for (const k of group) take(k, pair[k], 'generated');
      } else {
        for (const k of group) take(k, GENERATORS[k](), 'generated');
      }
    }
  }

  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const writes = [];
  if (added.size > 0) {
    let text = fileExisted ? existing : FILE_HEADER;
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    if (fileExisted) text += '\n';
    if (generated.length) text += `# secrets ${stamp} - generated: ${generated.join(' ')}\n`;
    if (adopted.length) text += `# secrets ${stamp} - taken from the environment: ${adopted.join(' ')}\n`;
    if (copied.length) text += `# secrets ${stamp} - copy of POSTGRES_PASSWORD: ${copied.join(' ')}\n`;
    for (const [k, v] of added) text += `${k}=${formatValue(v)}\n`;
    atomicWrite(dir, SECRETS_FILE, text);
    writes.push(SECRETS_FILE);
    log(`${filePath}: ${fileExisted ? 'appended' : 'created'}`);
  } else {
    log(`${filePath}: complete — nothing to add`);
  }
  if (generated.length) log(`  generated: ${generated.join(', ')}`);
  if (adopted.length) log(`  taken from the environment: ${adopted.join(', ')}`);
  if (copied.length) log(`  copy of POSTGRES_PASSWORD: ${copied.join(', ')}`);
  if (unrepresentable.length) log(`  NOT written (value has quotes/newlines, keep it in the environment): ${unrepresentable.join(', ')}`);
  if (incomplete.length) log(`  NOT generated (the other half of the pair exists): ${incomplete.join(', ')}`);
  if (skipped.length) {
    log(`  not generated (${freshness.reason}): ${skipped.join(', ')}`);
    log('  → these stay derived from JWT_SECRET + PEPPER (or unset) as before');
  } else if (freshness?.fresh) {
    log(`  fresh installation: ${freshness.reason}`);
  }

  // Single-value files for the infrastructure containers (POSTGRES_PASSWORD_FILE,
  // redis, MinIO, rspamd — the Compose files read them when the variable is empty).
  for (const [name, key] of PASSWORD_FILES) {
    const want = value(key);
    if (!want) continue;
    const have = readSecretFile(join(dir, name));
    if (have === null) {
      atomicWrite(dir, name, want);
      writes.push(name);
      log(`${join(dir, name)}: created`);
    } else if (have.replace(/\r?\n$/, '') !== want) {
      log(`WARNING: ${join(dir, name)} differs from ${key} in ${SECRETS_FILE} — left unchanged`);
    }
  }

  return {
    fileExisted, writes, generated, adopted, copied, skipped, incomplete, unrepresentable,
    fresh: freshness?.fresh ?? null, dbState: freshness?.dbState ?? null,
  };
}

// ── Export for the entrypoint ────────────────────────────────────────────────

/**
 * The variables the entrypoint exports. A non-empty environment value always
 * wins over the file (existing .env installations keep their values).
 * Returns { vars: [[k, v]], warnings: [] }.
 */
export function exportEnv({ dir, env = process.env } = {}) {
  const warnings = [];
  const fromFile = new Map();
  let generatedMarker = false;
  if (dir && checkSecretsDir(dir)) {
    const text = readSecretFile(join(dir, SECRETS_FILE));
    if (text !== null) {
      const parsed = parseEnvFile(text);
      generatedMarker = parsed.generatedMarker;
      if (parsed.invalid.length) warnings.push(`${SECRETS_FILE}: ignored malformed line(s): ${parsed.invalid.join(', ')}`);
      const ignored = [];
      for (const [k, v] of parsed.values) {
        if (!LOADABLE_KEYS.has(k)) { ignored.push(k); continue; }
        if (nonEmpty(v)) fromFile.set(k, v);
      }
      if (ignored.length) warnings.push(`${SECRETS_FILE}: ignored (not a CoreMail secret): ${ignored.join(', ')}`);
    }
  }
  const vars = [];
  const overridden = [];
  for (const [k, v] of fromFile) {
    if (nonEmpty(env[k])) {
      if (env[k] !== v) overridden.push(k);
      continue;
    }
    vars.push([k, v]);
  }
  if (overridden.length) warnings.push(`the environment overrides ${SECRETS_FILE} for: ${overridden.join(', ')}`);
  const get = (k) => (nonEmpty(env[k]) ? env[k] : (fromFile.get(k) ?? ''));
  if (!nonEmpty(env.DATABASE_URL)) {
    const url = buildDatabaseUrl(env, get);
    if (url) vars.push(['DATABASE_URL', url]);
  }
  if (!nonEmpty(env.REDIS_URL)) {
    const url = buildRedisUrl(env, get);
    if (url) vars.push(['REDIS_URL', url]);
  }
  for (const [k, v] of Object.entries(bundledMinioCredentials(env, get))) vars.push([k, v]);
  const inUse = vars.some(([k]) => fromFile.has(k));
  vars.push(['COREMAIL_SECRETS_FILE_IN_USE', inUse ? 'true' : 'false']);
  vars.push(['COREMAIL_SECRETS_GENERATED', inUse && generatedMarker ? 'true' : 'false']);
  return { vars: vars.filter(([, v]) => !/[\n\r\0]/.test(v)), warnings };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `usage: init-secrets.mjs [--dir <dir>] [--db-wait <seconds>]
       init-secrets.mjs --export-env [--dir <dir>]
(internal: run by the entrypoint of the coremail container)

Creates <dir>/${SECRETS_FILE} (default dir: $COREMAIL_SECRETS_DIR or /secrets) with
random secrets, appends missing keys to an existing file and writes the
single-value files <dir>/${POSTGRES_PASSWORD_FILE}, <dir>/${REDIS_PASSWORD_FILE},
<dir>/${MINIO_PASSWORD_FILE} and <dir>/${RSPAMD_PASSWORD_FILE}. Never overwrites a
value; prints key names only.

Back up ${SECRETS_FILE} off the server: without PEPPER no password works.
Details: docs/setup.md ("Automatic secrets").`;

function parseArgs(argv) {
  const opts = { dir: nonEmpty(process.env.COREMAIL_SECRETS_DIR) ? process.env.COREMAIL_SECRETS_DIR : '/secrets', dbWait: 0, exportEnv: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--export-env') opts.exportEnv = true;
    else if (a === '--dir' && i + 1 < argv.length) opts.dir = argv[++i];
    else if (a.startsWith('--dir=')) opts.dir = a.slice(6);
    else if (a === '--db-wait' && i + 1 < argv.length) opts.dbWait = Number(argv[++i]);
    else if (a.startsWith('--db-wait=')) opts.dbWait = Number(a.slice(10));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(opts.dbWait) || opts.dbWait < 0) throw new Error('--db-wait needs a number of seconds');
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const err = (m) => process.stderr.write(`[secrets] ${m}\n`);
  let opts;
  try { opts = parseArgs(argv); } catch (e) { err(e.message); process.stderr.write(`${USAGE}\n`); return 1; }
  if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    if (opts.exportEnv) {
      if (process.stdout.isTTY) { err('--export-env prints secrets — refusing to write them to a terminal'); return 1; }
      const { vars, warnings } = exportEnv({ dir: opts.dir });
      for (const w of warnings) err(`WARNING: ${w}`);
      process.stdout.write(vars.map(([k, v]) => `${k}=${v}\n`).join(''));
      return 0;
    }
    initSecrets({ dir: opts.dir, dbWait: opts.dbWait, log: (m) => process.stdout.write(`[secrets] ${m}\n`) });
    return 0;
  } catch (e) {
    err(`ERROR: ${e.message}`);
    return e instanceof UnsafeSecretsError ? 2 : 1;
  }
}

function isMain() {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) process.exitCode = main();
