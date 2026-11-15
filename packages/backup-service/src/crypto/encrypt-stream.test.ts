/**
 * Streaming upload body (createEncryptedFileStream / encryptReadable): source
 * errors must reach the consumer (S3 Upload) instead of hanging; and the
 * Synology setup pins the legacy-derived backup key with the same HKDF
 * parameters as deriveFallbackKey().
 * Run: node --import tsx --test src/crypto/encrypt-stream.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  createDecryptStream, createEncryptedFileStream, deriveFallbackKey, encryptReadable, loadKeyring, parseKeyString,
} from './backup-crypto.js';

const kr = loadKeyring({ BACKUP_ENCRYPTION_KEY: 'b'.repeat(64) });

/** Drains a stream like the S3 Upload does; rejects on a stream error. Fails the test on a hang. */
async function drain(stream: Readable, timeoutMs = 3000): Promise<Buffer> {
  const out: Buffer[] = [];
  let timer: NodeJS.Timeout | undefined;
  const hang = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stream hung (error not propagated)')), timeoutMs); });
  try {
    return await Promise.race([
      (async () => { for await (const c of stream) out.push(c as Buffer); return Buffer.concat(out); })(),
      hang,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('missing source file: the upload body errors with ENOENT instead of hanging', async () => {
  const body = createEncryptedFileStream(join(tmpdir(), `does-not-exist-${randomBytes(6).toString('hex')}`), kr.current);
  await assert.rejects(drain(body), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
});

test('read error in the middle of the source aborts the encrypted stream', async () => {
  let n = 0;
  const source = new Readable({
    read() {
      n++;
      if (n < 3) this.push(randomBytes(70_000));
      else this.destroy(Object.assign(new Error('EIO: disk read failed'), { code: 'EIO' }));
    },
  });
  await assert.rejects(drain(encryptReadable(source, kr.current)), /EIO: disk read failed/);
});

test('happy path: file → encrypted stream → decrypts to the same bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cm-encstream-'));
  try {
    const plain = randomBytes(200_000);
    await writeFile(join(dir, 'a.zip'), plain);
    const cipher = await drain(createEncryptedFileStream(join(dir, 'a.zip'), kr.current));
    const back: Buffer[] = [];
    await pipeline(Readable.from([cipher]), createDecryptStream(kr), new Writable({ write(c, _e, cb) { back.push(c as Buffer); cb(); } }));
    assert.ok(Buffer.concat(back).equals(plain));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('synology-setup.sh pins exactly the legacy-derived backup key (and the MFA key)', async () => {
  const script = await readFile(fileURLToPath(new URL('../../../../scripts/synology-setup.sh', import.meta.url)), 'utf8');
  const expr = /--entrypoint node "[^"]*" -e \\\n\s*"(process\.stdout\.write\(.*\))" \\/.exec(script)?.[1];
  assert.ok(expr, 'node -e expression of legacy_key() not found');
  const jwtDefault = /LEGACY_JWT_DEFAULT='([^']+)'/.exec(script)?.[1];
  assert.equal(jwtDefault, 'CHANGE-ME-openssl-rand-hex-32', 'public default of the old compose file');
  const backupCall = /BACKUP_KEY="\$\(legacy_key '([^']+)' '([^']+)'\)"/.exec(script);
  const mfaCall = /MFA_KEY="\$\(legacy_key '([^']+)' '([^']+)'\)"/.exec(script);
  assert.ok(backupCall && mfaCall, 'legacy_key calls not found');
  // The expression is in a double-quoted bash string: \0 reaches node verbatim.
  const run = (salt: string, info: string, pepper: string) => execFileSync(process.execPath, ['-e', expr!], {
    env: { ...process.env, LEGACY_JWT: jwtDefault!, LEGACY_PEPPER: pepper, HKDF_SALT: salt, HKDF_INFO: info },
    encoding: 'utf8',
  });
  for (const pepper of ['CHANGE-ME-openssl-rand-hex-32', 'p'.repeat(64)]) {
    const pinned = run(backupCall![1]!, backupCall![2]!, pepper);
    assert.match(pinned, /^[0-9a-f]{64}$/);
    const derived = deriveFallbackKey({ JWT_SECRET: jwtDefault!, PEPPER: pepper });
    assert.ok(derived && parseKeyString(pinned).equals(derived), 'pinned key differs from the key the backup-service derived');
    // the pinned key is accepted as BACKUP_ENCRYPTION_KEY and decrypts the old backups
    const ring = loadKeyring({ BACKUP_ENCRYPTION_KEY: pinned, JWT_SECRET: 'rotated'.repeat(8), PEPPER: pepper });
    assert.ok(ring.current.key.equals(derived!));
  }
  assert.deepEqual([mfaCall![1], mfaCall![2]], ['coremail-mfa', 'totp-secret-v1']);
});
