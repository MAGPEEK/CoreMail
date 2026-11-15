/**
 * v7.1 object storage: filesystem driver, key rules, configuration, cleaner,
 * startup check and migration (fake in-memory stores, temp directories only).
 * Run: node --import tsx --test src/object-store/object-store.test.ts  (in packages/storage)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ObjectStore, ObjectInfo, ObjectStat, PutOptions, S3StorageConfig } from './index.js';

// The logger (via @coremail/core) validates the environment on import.
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
const {
  FilesystemObjectStore, ObjectNotFoundError, InvalidObjectKeyError, ObjectStorageConfigError,
  validateObjectKey, safeKeySegment, isContentAddressedKey,
  parseObjectStorageConfig, describeConfig, minioClientOptions,
  runExpiryCleanup, runLockedCleanup, CLEANER_LOCK_KEY,
  checkObjectStorage, isOnContainerRootFs,
  migrateObjects, createObjectStore, S3ObjectStore,
} = await import('./index.js');

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const rawKey = (b: Buffer): string => { const h = sha(b); return `raw/${h.slice(0, 2)}/${h}.eml`; };

let dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'cm-objstore-'));
  dirs.push(d);
  return join(d, 'objects');
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

async function collect(it: AsyncIterable<ObjectInfo>): Promise<string[]> {
  const keys: string[] = [];
  for await (const o of it) keys.push(o.key);
  return keys;
}

// ── In-memory store for check/migration tests ────────────────────────────────
class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { data: Buffer; mtime: Date }>();
  puts = 0;
  failPut = new Set<string>();
  corruptOnWrite = new Set<string>();
  initError: Error | null = null;
  constructor(readonly driver: 'minio' | 's3' | 'filesystem', readonly location: string) {}
  async init() { if (this.initError) throw this.initError; return { lifecycle: this.driver !== 'filesystem' }; }
  async put(key: string, data: Buffer, _o?: PutOptions) {
    if (this.failPut.has(key)) throw new Error('disk full');
    this.puts++;
    const stored = this.corruptOnWrite.has(key) ? Buffer.concat([data, Buffer.from('X')]) : Buffer.from(data);
    this.objects.set(key, { data: stored, mtime: new Date() });
  }
  async putStream(key: string, stream: Readable, o?: PutOptions) {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    await this.put(key, Buffer.concat(chunks), o);
  }
  async get(key: string) { const o = this.objects.get(key); if (!o) throw new ObjectNotFoundError(key); return o.data; }
  async getStream(key: string) { return Readable.from([await this.get(key)]); }
  async stat(key: string): Promise<ObjectStat | null> { const o = this.objects.get(key); return o ? { size: o.data.length, lastModified: o.mtime } : null; }
  async exists(key: string) { return this.objects.has(key); }
  async delete(key: string) { this.objects.delete(key); }
  async *list(prefix: string) {
    for (const k of [...this.objects.keys()].sort()) if (k.startsWith(prefix)) { const o = this.objects.get(k)!; yield { key: k, size: o.data.length, lastModified: o.mtime }; }
  }
}

// ── Key rules ────────────────────────────────────────────────────────────────
describe('object keys', () => {
  test('rejects traversal, absolute keys, NUL, backslashes, empty and reserved segments', () => {
    for (const bad of ['', '../etc/passwd', 'raw/../../x', 'a/./b', '/etc/passwd', 'a\\b', '..\\x', 'a\0b', 'C:/Windows/x', 'a//b', 'a/', '.tmp-123', 'raw/.tmp-x/y', 'a\nb']) {
      assert.throws(() => validateObjectKey(bad, { platform: 'linux' }), InvalidObjectKeyError, JSON.stringify(bad));
    }
    for (const good of ['raw/ab/' + 'a'.repeat(64) + '.eml', 'attachments/cm1/0-0123456789abcdef', 'smime/u1/AA:BB.p12', 'quarantine/x.eml', 'a/..b/c..']) {
      validateObjectKey(good, { platform: 'linux' });
    }
    assert.throws(() => validateObjectKey('smime/u1/AA:BB.p12', { platform: 'win32' }), InvalidObjectKeyError);
  });

  test('safeKeySegment never yields a traversal or separator', () => {
    for (const s of ['..', '.', '', '../../etc', 'a/b', 'a\\b', 'x\0y', '.hidden', 'Bericht "Q1".pdf', 'ü'.repeat(300)]) {
      const seg = safeKeySegment(s);
      validateObjectKey(`outbound-queue/j/${seg}`, { platform: 'win32' });
      assert.ok(!seg.includes('/') && seg.length <= 201, seg);
    }
    assert.equal(safeKeySegment('0-0123456789abcdef'), '0-0123456789abcdef');
  });

  test('content-addressed keys are recognised', () => {
    assert.ok(isContentAddressedKey(rawKey(Buffer.from('x'))));
    assert.ok(!isContentAddressedKey('raw/m1.eml'));
    assert.ok(!isContentAddressedKey('attachments/a/b'));
  });
});

// ── Filesystem driver ────────────────────────────────────────────────────────
describe('filesystem driver', () => {
  test('put/get/stat/exists/delete/list round trip; delete is idempotent', async () => {
    const root = tempRoot();
    const fs = new FilesystemObjectStore(root);
    assert.deepEqual(await fs.init(), { lifecycle: false });
    const data = Buffer.from('Subject: hi\r\n\r\nbody\r\n');
    const key = rawKey(data);
    await fs.put(key, data);
    await fs.put('attachments/m1/0-aa', Buffer.from('att'));
    assert.deepEqual(await fs.get(key), data);
    assert.equal((await fs.stat(key))!.size, data.length);
    assert.ok(await fs.exists(key));
    assert.deepEqual(await collect(fs.list('')), ['attachments/m1/0-aa', key]);
    assert.deepEqual(await collect(fs.list('raw/')), [key]);
    assert.deepEqual(await collect(fs.list('attachments/m1/')), ['attachments/m1/0-aa']);
    assert.deepEqual(await collect(fs.list('nothing/')), []);
    await fs.delete(key);
    await fs.delete(key);
    await fs.delete('never/existed');
    assert.equal(await fs.stat(key), null);
    await assert.rejects(fs.get(key), ObjectNotFoundError);
    await assert.rejects(fs.getStream(key), (e: unknown) => e instanceof ObjectNotFoundError && (e as { code?: string }).code === 'NoSuchKey');
  });

  test('path traversal attempts never touch files outside the root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cm-trav-'));
    dirs.push(base);
    const root = join(base, 'objects');
    const fs = new FilesystemObjectStore(root);
    await fs.init();
    writeFileSync(join(base, 'secret.txt'), 'top secret');
    for (const key of ['../secret.txt', 'raw/../../secret.txt', '/secret.txt', '..\\secret.txt', 'raw\\..\\..\\secret.txt', `..${sep}secret.txt`, 'a\0/../../secret.txt']) {
      await assert.rejects(fs.get(key), InvalidObjectKeyError, key);
      await assert.rejects(fs.put(key, Buffer.from('pwned')), InvalidObjectKeyError, key);
      await assert.rejects(fs.delete(key), InvalidObjectKeyError, key);
      assert.throws(() => fs.pathFor(key), InvalidObjectKeyError);
    }
    assert.throws(() => [...[fs.list('../')]].length && fs.pathFor('..'), InvalidObjectKeyError);
    await assert.rejects(collect(fs.list('../')), InvalidObjectKeyError);
    assert.equal(allFiles(base).filter((f) => f.endsWith('secret.txt')).length, 1);
    assert.ok(fs.pathFor('raw/ab/x.eml').startsWith(root + sep));
  });

  test('atomic write: a crash before rename leaves no (partial) object, only an invisible temp file', async () => {
    const root = tempRoot();
    const crashing = new FilesystemObjectStore(root, { beforeRename: () => { throw new Error('simulated crash'); } });
    await crashing.init();
    const data = randomBytes(64 * 1024);
    const key = 'attachments/m1/0-crash';
    await assert.rejects(crashing.put(key, data), /simulated crash/);
    const fs = new FilesystemObjectStore(root);
    assert.equal(await fs.stat(key), null, 'no object after crash');
    assert.deepEqual(await collect(fs.list('')), [], 'temp file is not listed');
    const temps = allFiles(root).filter((f) => f.split(sep).pop()!.startsWith('.tmp-'));
    assert.equal(temps.length, 1, 'temp file left like after a real crash');
    // Existing object survives a crashed overwrite unchanged.
    await fs.put(key, Buffer.from('old'));
    await assert.rejects(crashing.put(key, Buffer.from('new-but-crashed')), /simulated crash/);
    assert.equal((await fs.get(key)).toString(), 'old');
    // The cleaner removes stale temp files (here: pretend 7 h passed).
    const r = await runExpiryCleanup(fs, [], Date.now() + 7 * 3600_000);
    assert.equal(r.tempFiles, 2);
    assert.equal(allFiles(root).filter((f) => f.includes('.tmp-')).length, 0);
  });

  test('concurrent writes of the same content-addressed key: one object, correct content, no temp files', async () => {
    const root = tempRoot();
    const fs = new FilesystemObjectStore(root);
    await fs.init();
    const data = randomBytes(256 * 1024);
    const key = rawKey(data);
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? fs.put(key, data) : fs.putStream(key, Readable.from([data.subarray(0, 1000), data.subarray(1000)])))));
    assert.equal(sha(await fs.get(key)), sha(data));
    assert.deepEqual(await collect(fs.list('')), [key]);
    assert.equal(allFiles(root).length, 1, 'no temp files left');
  });

  test('content-addressed objects are written once; overwrite only on request', async () => {
    const root = tempRoot();
    const fs = new FilesystemObjectStore(root);
    const data = Buffer.from('original');
    const key = rawKey(data);
    await fs.put(key, data);
    await fs.put(key, Buffer.from('different bytes'));
    assert.equal((await fs.get(key)).toString(), 'original');
    await fs.put(key, Buffer.from('repaired'), { overwrite: true });
    assert.equal((await fs.get(key)).toString(), 'repaired');
    // Non content-addressed keys are replaced atomically.
    await fs.put('jmap-upload/a/u-1', Buffer.from('v1'));
    await fs.put('jmap-upload/a/u-1', Buffer.from('v2'));
    assert.equal((await fs.get('jmap-upload/a/u-1')).toString(), 'v2');
  });

  test('streams large objects in and out (32 MiB, chunked)', async () => {
    const root = tempRoot();
    const fs = new FilesystemObjectStore(root);
    const chunk = randomBytes(1024 * 1024);
    const n = 32;
    const h = createHash('sha256');
    for (let i = 0; i < n; i++) h.update(chunk);
    const expected = h.digest('hex');
    await fs.putStream('raw/big.eml', Readable.from((function* () { for (let i = 0; i < n; i++) yield chunk; })()), { size: n * chunk.length });
    assert.equal((await fs.stat('raw/big.eml'))!.size, n * chunk.length);
    const rh = createHash('sha256');
    let reads = 0;
    for await (const c of await fs.getStream('raw/big.eml')) { rh.update(c as Buffer); reads++; }
    assert.equal(rh.digest('hex'), expected);
    assert.ok(reads > 1, 'read in several chunks');
  });

  test('failed stream write leaves nothing behind', async () => {
    const root = tempRoot();
    const fs = new FilesystemObjectStore(root);
    const broken = new Readable({ read() { this.push(Buffer.from('partial')); this.destroy(new Error('source broke')); } });
    await assert.rejects(fs.putStream('attachments/m/0', broken), /source broke/);
    assert.equal(await fs.stat('attachments/m/0'), null);
    assert.equal(allFiles(root).length, 0);
  });

  test('file and directory modes are 0640 / 0750 (POSIX only)', { skip: process.platform === 'win32' }, async () => {
    const { statSync } = await import('node:fs');
    const root = tempRoot();
    const fs = new FilesystemObjectStore(root);
    await fs.put('quarantine/q1.eml', Buffer.from('x'));
    assert.equal(statSync(fs.pathFor('quarantine/q1.eml')).mode & 0o777, 0o640);
    assert.equal(statSync(join(root, 'quarantine')).mode & 0o777, 0o750 & ~process.umask());
  });
});

// ── Cleaner ──────────────────────────────────────────────────────────────────
describe('expiry cleaner', () => {
  test('deletes expired objects of the temporary prefixes only and prunes empty directories', async () => {
    const root = tempRoot();
    const fs = new FilesystemObjectStore(root);
    const old = new Date(Date.now() - 10 * 86400_000);
    const keys = {
      oldOutbound: 'outbound-queue/job1/0', newOutbound: 'outbound-queue/job2/0',
      oldQuarantine: 'quarantine/q-old.eml', youngQuarantine: 'quarantine/q-young.eml',
      oldUpload: 'jmap-upload/acc/u-1', oldRaw: rawKey(Buffer.from('keep me')), oldAtt: 'attachments/m1/0-x',
    };
    for (const k of Object.values(keys)) await fs.put(k, k === keys.oldRaw ? Buffer.from('keep me') : Buffer.from(k));
    for (const k of [keys.oldOutbound, keys.oldQuarantine, keys.oldUpload, keys.oldRaw, keys.oldAtt]) utimesSync(fs.pathFor(k), old, old);
    const r = await runExpiryCleanup(fs);
    assert.equal(r.perPrefix['outbound-queue/'], 1);
    assert.equal(r.perPrefix['jmap-upload/'], 1);
    assert.equal(r.perPrefix['quarantine/'], 0, 'quarantine keeps 90 days');
    const left = await collect(fs.list(''));
    assert.ok(!left.includes(keys.oldOutbound) && !left.includes(keys.oldUpload));
    for (const k of [keys.newOutbound, keys.oldQuarantine, keys.youngQuarantine, keys.oldRaw, keys.oldAtt]) assert.ok(left.includes(k), k);
    assert.ok(!existsSync(join(root, 'outbound-queue', 'job1')), 'empty job directory pruned');
    assert.ok(existsSync(join(root, 'outbound-queue')), 'prefix directory itself stays');
    // 100 days later the quarantine object expires as well.
    const r2 = await runExpiryCleanup(fs, undefined, Date.now() + 100 * 86400_000);
    assert.equal(r2.perPrefix['quarantine/'], 2);
  });

  test('Redis lock: only one run per interval', async () => {
    const store = new MemoryStore('filesystem', '/mem');
    const locks = new Map<string, string>();
    const redis = { set: async (k: string, v: string) => { if (locks.has(k)) return null; locks.set(k, v); return 'OK' as const; } };
    assert.ok(await runLockedCleanup(store, redis));
    assert.equal(await runLockedCleanup(store, redis), null);
    assert.ok(locks.has(CLEANER_LOCK_KEY));
  });
});

// ── Configuration ────────────────────────────────────────────────────────────
describe('configuration', () => {
  const CREDS = { MINIO_ACCESS_KEY: 'ak', MINIO_SECRET_KEY: 'sk' };

  test('minio/s3 without credentials fails closed (no minioadmin fallback)', () => {
    assert.throws(() => parseObjectStorageConfig({}), /needs MINIO_ACCESS_KEY and MINIO_SECRET_KEY/);
    assert.throws(() => parseObjectStorageConfig({ OBJECT_STORAGE: 's3', MINIO_ACCESS_KEY: 'ak' }), ObjectStorageConfigError);
    assert.throws(() => parseObjectStorageConfig({ MINIO_ACCESS_KEY: ' ', MINIO_SECRET_KEY: 'sk' }), ObjectStorageConfigError);
    assert.equal(parseObjectStorageConfig({ OBJECT_STORAGE: 'filesystem' }).driver, 'filesystem', 'filesystem needs no S3 credentials');
  });

  test('unset OBJECT_STORAGE keeps the pre-7.1 MinIO behaviour', () => {
    const cfg = parseObjectStorageConfig({ ...CREDS });
    assert.deepEqual(cfg, { driver: 'minio', endPoint: 'minio', port: 9000, useSSL: false, accessKey: 'ak', secretKey: 'sk', bucket: 'coremail-attachments' });
    const legacy = parseObjectStorageConfig({ MINIO_ENDPOINT: 'minio', MINIO_PORT: '9000', MINIO_ACCESS_KEY: 'u', MINIO_SECRET_KEY: 'p', MINIO_BUCKET: 'mail-attachments' });
    assert.equal((legacy as S3StorageConfig).bucket, 'coremail-attachments', 'MINIO_BUCKET (compose leftover) is not the bucket');
    assert.equal(describeConfig(legacy), 'http://minio:9000/coremail-attachments');
  });

  test('filesystem driver: STORAGE_PATH default and validation', () => {
    const cfg = parseObjectStorageConfig({ OBJECT_STORAGE: 'filesystem' });
    assert.equal(cfg.driver, 'filesystem');
    assert.ok(cfg.driver === 'filesystem' && cfg.root.replace(/\\/g, '/').endsWith('/data/objects'));
    assert.throws(() => parseObjectStorageConfig({ OBJECT_STORAGE: 'filesystem', STORAGE_PATH: 'data/objects' }), ObjectStorageConfigError);
    assert.throws(() => parseObjectStorageConfig({ OBJECT_STORAGE: 'filesystem', STORAGE_PATH: '/' }), ObjectStorageConfigError);
    assert.equal(parseObjectStorageConfig({ OBJECT_STORAGE: ' FileSystem ' }).driver, 'filesystem');
    assert.throws(() => parseObjectStorageConfig({ OBJECT_STORAGE: 'nfs' }), /OBJECT_STORAGE must be one of/);
  });

  test('S3 with TLS, region, CA, path style', () => {
    const cfg = parseObjectStorageConfig({
      OBJECT_STORAGE: 's3', MINIO_ENDPOINT: 's3.eu-central-003.backblazeb2.com', MINIO_USE_SSL: 'true',
      MINIO_REGION: 'eu-central-003', MINIO_PATH_STYLE: 'false', MINIO_ACCESS_KEY: 'k', MINIO_SECRET_KEY: 's', MINIO_BUCKET_ATTACHMENTS: 'cm-mail',
    }) as S3StorageConfig;
    assert.equal(cfg.driver, 's3');
    assert.equal(cfg.port, 443, 'TLS default port');
    assert.equal(cfg.useSSL, true);
    assert.equal(cfg.region, 'eu-central-003');
    assert.equal(cfg.pathStyle, false);
    assert.equal(describeConfig(cfg), 'https://s3.eu-central-003.backblazeb2.com/cm-mail');

    const url = parseObjectStorageConfig({ OBJECT_STORAGE: 's3', MINIO_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', MINIO_REGION: 'auto', ...CREDS }) as S3StorageConfig;
    assert.equal(url.endPoint, 'acc.r2.cloudflarestorage.com');
    assert.equal(url.useSSL, true);
    assert.equal(url.port, 443);
    const urlPort = parseObjectStorageConfig({ MINIO_ENDPOINT: 'http://10.0.0.5:9100', ...CREDS }) as S3StorageConfig;
    assert.equal(urlPort.port, 9100);
    assert.equal(urlPort.useSSL, false);

    assert.throws(() => parseObjectStorageConfig({ MINIO_ENDPOINT: 'https://x.test', MINIO_USE_SSL: 'false' }), /contradicts/);
    assert.throws(() => parseObjectStorageConfig({ MINIO_USE_SSL: 'maybe' }), /MINIO_USE_SSL must be true or false/);
    assert.throws(() => parseObjectStorageConfig({ MINIO_CA_FILE: '/ca.pem' }), /MINIO_CA_FILE is set but MINIO_USE_SSL/);
    assert.throws(() => parseObjectStorageConfig({ MINIO_PORT: '70000' }), /MINIO_PORT/);
    assert.throws(() => parseObjectStorageConfig({ MINIO_REGION: 'eu central' }), /MINIO_REGION/);
    assert.throws(() => parseObjectStorageConfig({ MINIO_ENDPOINT: 'https://x.test/bucket' }), /must not contain a path/);
    assert.throws(() => parseObjectStorageConfig({ MINIO_BUCKET_ATTACHMENTS: 'Bad_Bucket' }), /bucket name/);
  });

  test('client options carry TLS, region, path style and a custom CA agent', () => {
    const cfg = parseObjectStorageConfig({ MINIO_ENDPOINT: 'minio.internal', MINIO_USE_SSL: 'true', MINIO_PORT: '9443', MINIO_CA_FILE: '/etc/ssl/private-ca.pem', MINIO_REGION: 'us-east-1', MINIO_PATH_STYLE: 'true', ...CREDS }) as S3StorageConfig;
    let readPath = '';
    const opts = minioClientOptions(cfg, (p) => { readPath = p; return Buffer.from('-----BEGIN CERTIFICATE-----\n'); });
    assert.equal(readPath, '/etc/ssl/private-ca.pem');
    assert.equal(opts.useSSL, true);
    assert.equal(opts.port, 9443);
    assert.equal(opts.region, 'us-east-1');
    assert.equal(opts.pathStyle, true);
    assert.ok(opts.transportAgent, 'https agent with the CA');
    const plain = minioClientOptions(parseObjectStorageConfig({ ...CREDS }) as S3StorageConfig);
    assert.equal(plain.useSSL, false);
    assert.equal(plain.transportAgent, undefined);
    assert.equal('region' in plain, false, 'region auto-detected when unset');
  });

  test('createObjectStore picks the driver', () => {
    assert.ok(createObjectStore({ driver: 'filesystem', root: tempRoot() }) instanceof FilesystemObjectStore);
    const s3 = createObjectStore(parseObjectStorageConfig({ OBJECT_STORAGE: 's3', ...CREDS }));
    assert.ok(s3 instanceof S3ObjectStore);
    assert.equal(s3.driver, 's3');
  });
});

// ── Startup check ────────────────────────────────────────────────────────────
describe('startup check', () => {
  const refs = ['raw/aa/1.eml', 'raw/bb/2.eml', 'raw/cc/3.eml', 'attachments/m1/0', 'attachments/m2/0'];

  test('all referenced objects present → ok', async () => {
    const s = new MemoryStore('filesystem', '/data/objects');
    for (const k of refs) await s.put(k, Buffer.from(k));
    const r = await checkObjectStorage({ store: s, references: async () => refs });
    assert.equal(r.status, 'ok');
    assert.equal(r.blocking, false);
    assert.equal(r.sampled, 5);
  });

  test('switched to filesystem without migrating → blocking with the migration command', async () => {
    const s = new MemoryStore('filesystem', '/data/objects');
    const r = await checkObjectStorage({ store: s, references: async () => refs });
    assert.equal(r.status, 'missing-objects');
    assert.equal(r.blocking, true);
    assert.equal(r.missing, 5);
    assert.match(r.hint!, /coremail storage migrate --from minio --to filesystem/);
  });

  test('a single lost object only degrades (never takes a working install down)', async () => {
    const s = new MemoryStore('minio', 'http://minio:9000/b');
    for (const k of refs.slice(1)) await s.put(k, Buffer.from(k));
    const r = await checkObjectStorage({ store: s, references: async () => refs });
    assert.equal(r.status, 'degraded');
    assert.equal(r.blocking, false);
    assert.deepEqual(r.missingKeys, ['raw/aa/1.eml']);
  });

  test('empty database (fresh install) → ok; store unusable → unavailable; ephemeral root → blocking; disabled', async () => {
    const s = new MemoryStore('filesystem', '/data/objects');
    assert.equal((await checkObjectStorage({ store: s, references: async () => [] })).status, 'ok');
    s.initError = new Error('EACCES: permission denied');
    const u = await checkObjectStorage({ store: s, references: async () => [] });
    assert.equal(u.status, 'unavailable');
    assert.equal(u.blocking, true);
    s.initError = null;
    const e = await checkObjectStorage({ store: s, references: async () => [], isEphemeral: async () => true });
    assert.equal(e.status, 'ephemeral');
    assert.equal(e.blocking, true);
    assert.equal((await checkObjectStorage({ store: s, references: async () => [], isEphemeral: async () => true, allowEphemeral: true })).status, 'ok');
    assert.equal((await checkObjectStorage({ store: s, references: async () => refs, disabled: true })).status, 'disabled');
    const db = await checkObjectStorage({ store: s, references: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(db.status, 'unavailable');
  });

  test('mountinfo: container root fs vs. mounted volume', () => {
    const info = [
      '1200 1100 0:120 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/x',
      '1201 1200 0:123 / /proc rw,nosuid - proc proc rw',
      '1250 1200 8:1 /var/lib/docker/volumes/coremail_coremail-data/_data /data rw,relatime - ext4 /dev/sda1 rw',
      '1251 1200 8:1 /volume1/docker/coremail/data/objects /srv/obj\\040x rw - btrfs /dev/md2 rw',
    ].join('\n');
    assert.equal(isOnContainerRootFs('/data/objects', info), false);
    assert.equal(isOnContainerRootFs('/data', info), false);
    assert.equal(isOnContainerRootFs('/srv/obj x/raw', info), false);
    assert.equal(isOnContainerRootFs('/dataX/objects', info), true);
    assert.equal(isOnContainerRootFs('/app/objects', info), true);
    assert.equal(isOnContainerRootFs('/var/lib/coremail', '22 1 8:1 / / rw - ext4 /dev/sda1 rw'), false, 'bare-metal root fs is fine');
  });
});

// ── Migration ────────────────────────────────────────────────────────────────
describe('migration', () => {
  let source: MemoryStore;
  const bodies = [Buffer.from('mail one'), Buffer.from('mail two'), randomBytes(200_000)];
  before(async () => {
    source = new MemoryStore('minio', 'http://minio:9000/coremail-attachments');
    for (const b of bodies) await source.put(rawKey(b), b);
    await source.put('attachments/m1/0-aa', Buffer.from('attachment'));
    await source.put('quarantine/q1.eml', Buffer.from('spam'));
  });

  test('dry run counts and writes nothing', async () => {
    const target = new MemoryStore('filesystem', '/data/objects');
    const p = await migrateObjects({ source, target, dryRun: true });
    assert.equal(p.phase, 'done');
    assert.equal(p.scanned, 5);
    assert.equal(p.copied, 5);
    assert.equal(target.objects.size, 0);
    assert.equal(target.puts, 0);
  });

  test('copies and verifies everything; the source is never modified', async () => {
    const target = new MemoryStore('filesystem', '/data/objects');
    const before = new Map([...source.objects].map(([k, v]) => [k, sha(v.data)]));
    const progress: string[] = [];
    const p = await migrateObjects({ source, target, onProgress: (x) => progress.push(x.phase) });
    assert.equal(p.phase, 'done');
    assert.equal(p.copied, 5);
    assert.equal(p.verified, 5);
    assert.equal(p.failed, 0);
    for (const [k, v] of source.objects) assert.equal(sha(target.objects.get(k)!.data), sha(v.data), k);
    assert.deepEqual(new Map([...source.objects].map(([k, v]) => [k, sha(v.data)])), before);
    assert.ok(progress.includes('copying') && progress.at(-1) === 'done');
  });

  test('resume: an interrupted run continues, already copied objects are skipped', async () => {
    const target = new MemoryStore('filesystem', '/data/objects');
    const failing = rawKey(bodies[2]!);
    target.failPut.add(failing);
    const first = await migrateObjects({ source, target });
    assert.equal(first.phase, 'failed');
    assert.equal(first.failed, 1);
    assert.equal(first.errors[0]!.key, failing);
    target.failPut.clear();
    const puts = target.puts;
    const second = await migrateObjects({ source, target });
    assert.equal(second.phase, 'done');
    assert.equal(second.copied, 1);
    assert.equal(second.skipped, 4);
    assert.equal(target.puts - puts, 1, 'only the missing object is written');
  });

  test('verification catches a corrupted write; verifyExisting repairs a same-size mismatch', async () => {
    const target = new MemoryStore('filesystem', '/data/objects');
    target.corruptOnWrite.add('attachments/m1/0-aa');
    const p = await migrateObjects({ source, target });
    assert.equal(p.failed, 1);
    assert.match(p.errors[0]!.error, /verification failed/);
    target.corruptOnWrite.clear();
    // same size, different bytes: invisible to the size check, found by verifyExisting
    target.objects.set('quarantine/q1.eml', { data: Buffer.from('SPAM'), mtime: new Date() });
    const quick = await migrateObjects({ source, target });
    assert.equal(quick.phase, 'done');
    assert.equal(target.objects.get('quarantine/q1.eml')!.data.toString(), 'SPAM', 'size check alone skips it');
    const deep = await migrateObjects({ source, target, verifyExisting: true });
    assert.equal(deep.phase, 'done');
    assert.equal(target.objects.get('quarantine/q1.eml')!.data.toString(), 'spam', 'repaired');
  });

  test('a source object that does not match its content address is reported', async () => {
    const src = new MemoryStore('minio', 'http://minio:9000/b');
    const good = Buffer.from('good');
    src.objects.set(rawKey(good), { data: Buffer.from('tampered'), mtime: new Date() });
    const target = new MemoryStore('filesystem', '/data/objects');
    const p = await migrateObjects({ source: src, target });
    assert.equal(p.failed, 1);
    assert.match(p.errors[0]!.error, /content address/);
  });

  test('same store is refused; cancellation stops the run', async () => {
    const same = await migrateObjects({ source, target: source });
    assert.equal(same.phase, 'failed');
    const ac = new AbortController();
    ac.abort();
    const target = new MemoryStore('filesystem', '/data/objects');
    const c = await migrateObjects({ source, target, signal: ac.signal });
    assert.equal(c.phase, 'cancelled');
  });

  test('real filesystem target: copy from memory, re-run is a no-op', async () => {
    const root = tempRoot();
    const target = new FilesystemObjectStore(root);
    const p = await migrateObjects({ source, target, concurrency: 3 });
    assert.equal(p.phase, 'done');
    assert.equal(p.copied, 5);
    for (const [k, v] of source.objects) assert.equal(sha(await target.get(k)), sha(v.data));
    const again = await migrateObjects({ source, target, verifyExisting: true });
    assert.equal(again.copied, 0);
    assert.equal(again.skipped, 5);
    assert.equal(allFiles(root).filter((f) => f.includes('.tmp-')).length, 0);
    // and back: filesystem → memory
    const back = new MemoryStore('minio', 'http://other:9000/b');
    const r = await migrateObjects({ source: target, target: back });
    assert.equal(r.copied, 5);
    mkdirSync(join(root, 'raw', 'zz'), { recursive: true }); // empty dirs are not objects
    assert.equal((await collect(target.list(''))).length, 5);
  });
});

// v8.0 review: putStream ignored short writes (put() already looped on bytesWritten).
test('writeFully loops on short writes and fails on a write without progress', async () => {
  const { writeFully } = await import('./filesystem.js');
  const out: Buffer[] = [];
  const shortWriter = {
    write: async (buf: Buffer, off: number, len: number) => {
      const n = Math.min(3, len);
      out.push(Buffer.from(buf.subarray(off, off + n)));
      return { bytesWritten: n, buffer: buf };
    },
  };
  const data = Buffer.from('0123456789abcdef');
  await writeFully(shortWriter as never, data);
  assert.deepEqual(Buffer.concat(out), data);
  const stuck = { write: async (buf: Buffer) => ({ bytesWritten: 0, buffer: buf }) };
  await assert.rejects(writeFully(stuck as never, data), /short write/);
});
