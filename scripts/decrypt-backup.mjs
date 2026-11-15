#!/usr/bin/env node
// CoreMail — decrypt an encrypted backup (*.enc) without a running CoreMail.
// Disaster recovery: the archive comes straight from the S3/MinIO bucket.
//
//   BACKUP_ENCRYPTION_KEY=<64 hex> node scripts/decrypt-backup.mjs in.zip.enc out.zip
//   # key derived from JWT_SECRET + PEPPER (installations without BACKUP_ENCRYPTION_KEY):
//   JWT_SECRET=... PEPPER=... node scripts/decrypt-backup.mjs in.mbox.enc out.mbox
//
// Node 18+, no dependencies. Format: packages/backup-service/src/crypto/backup-crypto.ts
// (header "CMBK" v1, AES-256-GCM frames, HKDF-SHA256 per-file key). Every frame
// is authenticated; a wrong key, a modified or a truncated file is an error and
// the partial output is deleted.
import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HEADER = 34;
const TAG = 16;

function parseKey(raw) {
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b.length === 32) return b;
  throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hex characters or base64 of 32 bytes');
}

function keyring(env) {
  const keys = [];
  if (env.BACKUP_ENCRYPTION_KEY) keys.push(parseKey(env.BACKUP_ENCRYPTION_KEY));
  if (env.JWT_SECRET && env.PEPPER) {
    keys.push(Buffer.from(hkdfSync('sha256', Buffer.from(`${env.JWT_SECRET}\u0000${env.PEPPER}`, 'utf8'),
      'coremail-backup-key', 'coremail backup encryption key v1', 32)));
  }
  if (keys.length === 0) throw new Error('set BACKUP_ENCRYPTION_KEY (or JWT_SECRET + PEPPER for the derived key)');
  return keys.map((k) => ({ key: k, id: createHmac('sha256', k).update('coremail-backup-key-id').digest().subarray(0, 8) }));
}

function nonce(i, final) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(i, 3);
  n[11] = final ? 1 : 0;
  return n;
}

function decryptor(keys) {
  let header = null; let fk = null; let frame = 0; let i = 0n; let buf = Buffer.alloc(0);
  const open = (chunk, final) => {
    const d = createDecipheriv('aes-256-gcm', fk, nonce(i, final));
    d.setAAD(header);
    d.setAuthTag(chunk.subarray(chunk.length - TAG));
    try {
      const out = Buffer.concat([d.update(chunk.subarray(0, chunk.length - TAG)), d.final()]);
      i++;
      return out;
    } catch {
      throw new Error(`backup is corrupted, truncated or was modified (frame ${i})`);
    }
  };
  return new Transform({
    transform(chunk, _e, cb) {
      try {
        buf = Buffer.concat([buf, chunk]);
        if (!header) {
          if (buf.length < HEADER) return cb();
          const h = buf.subarray(0, HEADER);
          if (h.subarray(0, 4).toString('ascii') !== 'CMBK') throw new Error('not an encrypted CoreMail backup');
          if (h[4] !== 1) throw new Error(`unsupported format version ${h[4]}`);
          frame = h.readUInt32BE(6);
          if (frame < 1 || frame > 16 * 1024 * 1024) throw new Error('invalid frame size');
          const k = keys.find((x) => x.id.equals(h.subarray(26, 34)));
          if (!k) throw new Error(`no matching key (key id ${h.subarray(26, 34).toString('hex')})`);
          header = Buffer.from(h);
          fk = Buffer.from(hkdfSync('sha256', k.key, h.subarray(10, 26), 'coremail-backup-v1 file key', 32));
          buf = buf.subarray(HEADER);
        }
        while (buf.length > frame + TAG) {
          this.push(open(buf.subarray(0, frame + TAG), false));
          buf = buf.subarray(frame + TAG);
        }
        cb();
      } catch (err) { cb(err); }
    },
    flush(cb) {
      try {
        if (!header) throw new Error('truncated (incomplete header)');
        if (buf.length < TAG || buf.length > frame + TAG) throw new Error('truncated or trailing data');
        this.push(open(buf, true));
        cb();
      } catch (err) { cb(err); }
    },
  });
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: BACKUP_ENCRYPTION_KEY=<hex> node scripts/decrypt-backup.mjs <in.enc> <out>');
  process.exit(2);
}
try {
  await pipeline(createReadStream(input), decryptor(keyring(process.env)), createWriteStream(output, { mode: 0o600 }));
  console.error(`decrypted ${input} -> ${output}`);
} catch (err) {
  try { unlinkSync(output); } catch { /* nothing written */ }
  console.error(`error: ${err.message}`);
  process.exit(1);
}
