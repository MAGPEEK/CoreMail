import { S3Client, PutObjectCommand, ListObjectsV2Command, HeadBucketCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { stat } from 'node:fs/promises';
import { createLogger } from '@coremail/core';
import {
  createEncryptedFileStream, downloadDescriptor, ENCRYPTED_SUFFIX, ENCRYPTION_METADATA, loadKeyring, openDecryptedStream,
  type BackupKeyring,
} from '../crypto/backup-crypto.js';
import { backupS3Options } from './config.js';

const log = createLogger('backup:s3');

function getClient(): S3Client {
  return new S3Client(backupS3Options());
}

let _keyring: BackupKeyring | null = null;
/** Backup encryption keyring (BACKUP_ENCRYPTION_KEY; fallback derived from JWT_SECRET + PEPPER). */
export function backupKeyring(): BackupKeyring {
  _keyring ??= loadKeyring(process.env, (msg) => log.warn(msg));
  return _keyring;
}

const BUCKET = process.env['BACKUP_BUCKET'] ?? 'coremail-backups';

/**
 * v3.18.26 bugfix: called on service start. Prevents
 * listBackups() from crashing because the bucket does not exist (the NoSuchBucket error
 * killed the whole backup-service container).
 *
 * Idempotent — if the bucket already exists (200 OK from HeadBucket): do nothing.
 */
export async function ensureBackupBucket(): Promise<void> {
  let client: S3Client;
  try {
    client = getClient();
  } catch (err) {
    // Missing credentials must not crash the backup-service (mail keeps working);
    // every backup run then fails with the same clear message.
    log.error({ err }, 'Backup storage is not configured — backups will fail');
    return;
  }
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    log.info({ bucket: BUCKET }, 'Backup bucket exists');
  } catch (err) {
    // 404 NoSuchBucket → create. Other errors → throw.
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404 || status === 301) {
      log.warn({ bucket: BUCKET }, 'Backup bucket missing — creating');
      try {
        await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
        log.info({ bucket: BUCKET }, 'Backup bucket created');
      } catch (createErr) {
        log.error({ err: createErr, bucket: BUCKET }, 'Failed to create backup bucket');
      }
    } else {
      log.error({ err, bucket: BUCKET }, 'HeadBucket failed with unexpected error');
    }
  }
}

/**
 * Uploads a backup archive ENCRYPTED (AES-256-GCM frames, see
 * crypto/backup-crypto.ts) under `<s3Key>.enc` and returns the stored key —
 * callers persist that key (BackupJob.downloadUrl). The archive never leaves
 * the container in plaintext.
 *
 * 9.3 review: `opts.timeoutMs` aborts an upload that does not finish (hung
 * connection) so the job fails instead of staying RUNNING; `opts.onProgress`
 * reports uploaded bytes (job heartbeat progress).
 */
export async function uploadToS3(
  localPath: string,
  s3Key: string,
  contentType = 'application/octet-stream',
  opts: { timeoutMs?: number; onProgress?: (loaded: number) => void } = {},
): Promise<{ key: string; uri: string }> {
  const client = getClient();
  const keyring = backupKeyring();
  const fileSize = (await stat(localPath)).size;
  const storedKey = `${s3Key}${ENCRYPTED_SUFFIX}`;

  log.info({ s3Key: storedKey, fileSize }, 'Uploading encrypted backup to S3');

  const upload = new Upload({
    client,
    params: {
      Bucket: BUCKET,
      Key: storedKey,
      // pipeline-based: a read error aborts the upload (`.pipe()` would hang / truncate)
      Body: createEncryptedFileStream(localPath, keyring.current),
      ContentType: 'application/octet-stream',
      Metadata: {
        'uploaded-at': new Date().toISOString(),
        'file-size': String(fileSize),
        'encryption': ENCRYPTION_METADATA,
        'plain-content-type': contentType,
      },
    },
    partSize: 10 * 1024 * 1024, // 10 MB parts
    leavePartsOnError: false,
  });

  upload.on('httpUploadProgress', (progress) => {
    log.debug({ s3Key, loaded: progress.loaded, total: progress.total }, 'Upload progress');
    if (progress.loaded !== undefined) opts.onProgress?.(progress.loaded);
  });

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const limitMs = opts.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void upload.abort().catch(() => undefined);
        reject(Object.assign(
          new Error(`Upload nach ${Math.round(limitMs / 60_000) || '<1'} Min. abgebrochen (Zeitlimit BACKUP_UPLOAD_TIMEOUT_MIN)`),
          { code: 'ETIMEDOUT' },
        ));
      }, limitMs);
      timer.unref();
    });
    try {
      await Promise.race([upload.done(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    await upload.done();
  }

  const s3Uri = `s3://${BUCKET}/${storedKey}`;
  log.info({ s3Uri }, 'Upload complete');
  return { key: storedKey, uri: s3Uri };
}

/** Max. objects listed (9.3: pages through ListObjectsV2 — one call returned at most 1000). */
const LIST_MAX = 10_000;

export async function listBackups(prefix: string): Promise<{ key: string; size: number; lastModified: Date }[]> {
  const client = getClient();
  try {
    const out: { key: string; size: number; lastModified: Date }[] = [];
    let token: string | undefined;
    do {
      const result = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
      for (const obj of result.Contents ?? []) {
        out.push({ key: obj.Key ?? '', size: obj.Size ?? 0, lastModified: obj.LastModified ?? new Date() });
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token && out.length < LIST_MAX);
    // newest first (the BCP shows the list as it comes)
    return out.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  } catch (err) {
    // v3.18.26 bugfix: NoSuchBucket must not crash the service.
    // We try to create the bucket and then return an empty list.
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) {
      log.warn({ bucket: BUCKET }, 'listBackups: bucket missing — triggering ensureBackupBucket');
      await ensureBackupBucket();
      return [];
    }
    log.error({ err, bucket: BUCKET, prefix }, 'listBackups failed');
    return [];
  }
}

export async function getSignedDownloadUrl(s3Key: string): Promise<string> {
  // v3.18.28: known issue — http://minio:9000 is only reachable internally.
  // The frontend uses the download stream endpoint /backup/admin/download/:jobId instead.
  // We return the S3 key here so the frontend can map it to the right
  // stream endpoint.
  return s3Key;
}

/**
 * v3.18.28: return an object from S3 as a stream — piped to the client in the
 * Express handler. Works without a presigned URL.
 */
export async function streamObject(s3Key: string): Promise<{ stream: Readable; contentLength?: number; contentType?: string; plainContentType?: string }> {
  const client = getClient();
  const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
  const plain = result.Metadata?.['plain-content-type'];
  return {
    stream: result.Body as Readable,
    ...(typeof result.ContentLength === 'number' ? { contentLength: result.ContentLength } : {}),
    ...(typeof result.ContentType === 'string' ? { contentType: result.ContentType } : {}),
    ...(typeof plain === 'string' && plain ? { plainContentType: plain } : {}),
  };
}

/**
 * Opens a stored backup for download: encrypted objects (`.enc`) are
 * decrypted on the fly, legacy plaintext objects are passed through. Rejects
 * (before anything is sent) when the key does not match or the object is not
 * a valid encrypted backup.
 */
export async function openBackupDownload(s3Key: string): Promise<{ stream: Readable; filename: string; contentType: string; contentLength?: number }> {
  const obj = await streamObject(s3Key);
  const d = downloadDescriptor(s3Key, obj.contentType, obj.plainContentType);
  if (!d.encrypted) {
    return { stream: obj.stream, filename: d.filename, contentType: d.contentType, ...(obj.contentLength ? { contentLength: obj.contentLength } : {}) };
  }
  const stream = await openDecryptedStream(obj.stream, backupKeyring());
  return { stream, filename: d.filename, contentType: d.contentType };
}

/**
 * v3.18.28: delete an object from S3.
 */
export async function deleteObject(s3Key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: s3Key }));
}
