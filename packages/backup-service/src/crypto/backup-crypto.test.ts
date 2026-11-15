/**
 * 8.0.1: client-side backup encryption — round trip, tamper/truncation
 * detection, key handling, import of encrypted + legacy plaintext files.
 * Run: node --import tsx --test src/crypto/backup-crypto.test.ts  (in packages/backup-service)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BackupDecryptError, BackupKeyConfigError, createDecryptStream, createEncryptStream, decryptFile, downloadDescriptor,
  encryptFile, HEADER_LENGTH, isEncryptedFile, loadKeyring, openDecryptedStream, parseKeyString, TAG_LENGTH,
  type BackupKey,
} from './backup-crypto.js';
import { prepareImportFile } from '../restore/import-file.js';
import { backupS3Options, BackupStorageConfigError } from '../upload/config.js';

const HEX_KEY = 'a'.repeat(64);
const ENV = { BACKUP_ENCRYPTION_KEY: HEX_KEY, JWT_SECRET: 'j'.repeat(64), PEPPER: 'p'.repeat(64) };

function keyring(env: Record<string, string> = ENV) { return loadKeyring(env); }

/** Splits `buf` into random-sized chunks to exercise frame reassembly. */
function chunked(buf: Buffer, max = 9000): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length;) {
    const n = 1 + Math.floor(Math.random() * max);
    parts.push(buf.subarray(i, i + n));
    i += n;
  }
  return Readable.from(parts);
}

async function collect(source: Readable, transform: NodeJS.ReadWriteStream): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(source, transform, new Writable({ write(c, _e, cb) { out.push(c as Buffer); cb(); } }));
  return Buffer.concat(out);
}

const encrypt = (plain: Buffer, key: BackupKey, frameSize?: number) =>
  collect(chunked(plain), createEncryptStream(key, frameSize ? { frameSize } : {}));
const decrypt = (cipher: Buffer, kr = keyring()) => collect(chunked(cipher), createDecryptStream(kr));

describe('round trip', () => {
  for (const [label, size, frame] of [
    ['empty', 0, 1024], ['one byte', 1, 1024], ['exact frame', 1024, 1024], ['exact multiple', 4096, 1024],
    ['frame + 1', 1025, 1024], ['large, default frames', 300_000, undefined],
  ] as const) {
    test(label, async () => {
      const kr = keyring();
      const plain = randomBytes(size);
      const cipher = await encrypt(plain, kr.current, frame);
      const f = frame ?? 64 * 1024;
      const frames = Math.max(1, Math.ceil(size / f)); // the last frame is final (empty only for empty input)
      assert.equal(cipher.length, HEADER_LENGTH + size + frames * TAG_LENGTH, 'header + plaintext + one tag per frame');
      if (size >= 32) assert.ok(!cipher.includes(plain.subarray(0, 32)), 'no plaintext in the output');
      assert.deepEqual(await decrypt(cipher, kr), plain);
    });
  }

  test('two encryptions of the same data differ (random salt)', async () => {
    const kr = keyring();
    const plain = Buffer.from('From a@b.c\nSubject: x\n\nhello\n');
    assert.notDeepEqual(await encrypt(plain, kr.current), await encrypt(plain, kr.current));
  });

  test('file helpers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-bk-'));
    try {
      const kr = keyring();
      const plain = randomBytes(200_000);
      await writeFile(join(dir, 'a'), plain);
      await encryptFile(join(dir, 'a'), join(dir, 'a.enc'), kr.current, { frameSize: 4096 });
      assert.equal(await isEncryptedFile(join(dir, 'a.enc')), true);
      assert.equal(await isEncryptedFile(join(dir, 'a')), false);
      await decryptFile(join(dir, 'a.enc'), join(dir, 'b'), kr);
      assert.deepEqual(await readFile(join(dir, 'b')), plain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tamper detection', () => {
  const plain = randomBytes(10_000);

  test('every single flipped byte (header, ciphertext, tag) is detected', async () => {
    const kr = keyring();
    const cipher = await encrypt(plain, kr.current, 1000);
    // Header bytes, first frame, a middle frame, last tag byte.
    const positions = [0, 4, 5, 6, 12, 30, HEADER_LENGTH, HEADER_LENGTH + 500, HEADER_LENGTH + 1015, 5 * 1016 + HEADER_LENGTH + 3, cipher.length - 1];
    for (const pos of positions) {
      const bad = Buffer.from(cipher);
      bad[pos] = bad[pos]! ^ 0x01;
      await assert.rejects(decrypt(bad, kr), BackupDecryptError, `flip at ${pos} must be detected`);
    }
  });

  test('truncation (at a frame boundary, mid-frame, inside the header) is detected', async () => {
    const kr = keyring();
    const cipher = await encrypt(plain, kr.current, 1000);
    const frameBytes = 1000 + TAG_LENGTH;
    for (const len of [HEADER_LENGTH + 3 * frameBytes, HEADER_LENGTH + 3 * frameBytes + 100, HEADER_LENGTH - 1, HEADER_LENGTH, 0]) {
      await assert.rejects(decrypt(cipher.subarray(0, len), kr), BackupDecryptError, `truncated to ${len}`);
    }
  });

  test('swapped or dropped frames and trailing data are detected', async () => {
    const kr = keyring();
    const cipher = await encrypt(plain, kr.current, 1000);
    const f = 1000 + TAG_LENGTH;
    const h = cipher.subarray(0, HEADER_LENGTH);
    const fr = (i: number) => cipher.subarray(HEADER_LENGTH + i * f, HEADER_LENGTH + (i + 1) * f);
    const rest = cipher.subarray(HEADER_LENGTH + 2 * f);
    await assert.rejects(decrypt(Buffer.concat([h, fr(1), fr(0), rest]), kr), BackupDecryptError, 'swapped');
    await assert.rejects(decrypt(Buffer.concat([h, fr(1), rest]), kr), BackupDecryptError, 'dropped');
    await assert.rejects(decrypt(Buffer.concat([cipher, Buffer.from('x')]), kr), BackupDecryptError, 'trailing byte');
  });

  test('a file of another key is refused with a clear message', async () => {
    const other = loadKeyring({ BACKUP_ENCRYPTION_KEY: 'b'.repeat(64) });
    const cipher = await encrypt(plain, other.current);
    await assert.rejects(decrypt(cipher, loadKeyring({ BACKUP_ENCRYPTION_KEY: HEX_KEY })), /encrypted with a different key/);
  });

  test('openDecryptedStream rejects before streaming on a wrong key or foreign data', async () => {
    const kr = keyring();
    await assert.rejects(openDecryptedStream(Readable.from([Buffer.from('From a@b.c\nnot encrypted\n'.repeat(4))]), kr), /bad magic/);
    const other = loadKeyring({ BACKUP_ENCRYPTION_KEY: 'c'.repeat(64) });
    await assert.rejects(openDecryptedStream(Readable.from([await encrypt(plain, other.current)]), kr), /different key/);
    const ok = await openDecryptedStream(Readable.from([await encrypt(plain, kr.current)]), kr);
    const out: Buffer[] = [];
    for await (const c of ok) out.push(c as Buffer);
    assert.deepEqual(Buffer.concat(out), plain);
  });
});

describe('keys', () => {
  test('BACKUP_ENCRYPTION_KEY as hex or base64; invalid values fail closed', () => {
    const k = randomBytes(32);
    assert.deepEqual(parseKeyString(k.toString('hex')), k);
    assert.deepEqual(parseKeyString(k.toString('base64')), k);
    assert.deepEqual(parseKeyString(k.toString('base64url')), k);
    for (const bad of ['abc', 'a'.repeat(63), randomBytes(16).toString('base64'), 'not base64 !!']) {
      assert.throws(() => parseKeyString(bad), BackupKeyConfigError, bad);
    }
    assert.throws(() => loadKeyring({ ...ENV, BACKUP_ENCRYPTION_KEY: 'short' }), BackupKeyConfigError);
  });

  test('without BACKUP_ENCRYPTION_KEY the key is derived from JWT_SECRET + PEPPER, with a warning', () => {
    const warnings: string[] = [];
    const a = loadKeyring({ JWT_SECRET: ENV.JWT_SECRET, PEPPER: ENV.PEPPER }, (m) => warnings.push(m));
    assert.equal(a.current.source, 'derived');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /BACKUP_ENCRYPTION_KEY is not set/);
    const b = loadKeyring({ JWT_SECRET: ENV.JWT_SECRET, PEPPER: ENV.PEPPER });
    assert.deepEqual(a.current.key, b.current.key, 'deterministic');
    const c = loadKeyring({ JWT_SECRET: ENV.JWT_SECRET, PEPPER: 'q'.repeat(64) });
    assert.notDeepEqual(a.current.key, c.current.key, 'depends on PEPPER');
    assert.throws(() => loadKeyring({}), BackupKeyConfigError);
  });

  test('backups written with the derived key stay readable after BACKUP_ENCRYPTION_KEY is set', async () => {
    const before = loadKeyring({ JWT_SECRET: ENV.JWT_SECRET, PEPPER: ENV.PEPPER });
    const plain = randomBytes(5000);
    const cipher = await encrypt(plain, before.current);
    const after = loadKeyring(ENV);
    assert.equal(after.current.source, 'env');
    assert.equal(after.keys.length, 2);
    assert.deepEqual(await decrypt(cipher, after), plain);
  });
});

describe('import + download helpers', () => {
  test('prepareImportFile: legacy plaintext MBOX and encrypted MBOX', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cm-imp-'));
    try {
      const kr = keyring();
      const mbox = Buffer.from('From a@b.c Thu Jan  1 00:00:00 2026\nSubject: hi\n\nbody\n');
      const legacy = await prepareImportFile(mbox, dir, () => kr);
      assert.equal(legacy.encrypted, false);
      assert.deepEqual(await readFile(legacy.path), mbox);

      const enc = await encrypt(mbox, kr.current);
      const p = await prepareImportFile(enc, dir, () => kr);
      assert.equal(p.encrypted, true);
      assert.deepEqual(await readFile(p.path), mbox);
      assert.deepEqual((await readdir(dir)).sort(), ['import.mbox'], 'ciphertext temp file removed');

      const bad = Buffer.from(enc);
      bad[bad.length - 5] = bad[bad.length - 5]! ^ 0xff;
      await rm(p.path);
      await assert.rejects(prepareImportFile(bad, dir, () => kr), BackupDecryptError);
      assert.deepEqual(await readdir(dir), [], 'nothing left behind after a failed decryption');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('downloadDescriptor strips .enc and picks the original content type', () => {
    assert.deepEqual(downloadDescriptor('mailbox/u1/123.mbox.enc', 'application/octet-stream', 'application/mbox'),
      { encrypted: true, filename: '123.mbox', contentType: 'application/mbox' });
    assert.deepEqual(downloadDescriptor('full-backup/2026-01-01/a_at_b.zip.enc', 'application/octet-stream'),
      { encrypted: true, filename: 'a_at_b.zip', contentType: 'application/zip' });
    assert.deepEqual(downloadDescriptor('full-backup/2025-01-01/old.zip', 'application/zip'),
      { encrypted: false, filename: 'old.zip', contentType: 'application/zip' });
    assert.equal(downloadDescriptor('x/a"b\r\n.zip').filename, 'a_b__.zip');
  });

  test('backup S3 credentials fail closed (no minioadmin fallback)', () => {
    assert.throws(() => backupS3Options({}), BackupStorageConfigError);
    assert.throws(() => backupS3Options({ S3_ACCESS_KEY: 'minio' }), BackupStorageConfigError);
    const o = backupS3Options({ S3_ACCESS_KEY: 'u', S3_SECRET_KEY: 's', S3_ENDPOINT: '' });
    assert.equal(o.endpoint, 'http://minio:9000');
    assert.deepEqual(o.credentials, { accessKeyId: 'u', secretAccessKey: 's' });
  });
});
