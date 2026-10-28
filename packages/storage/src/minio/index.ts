import { Client as MinioClient } from 'minio';
import { config, createLogger } from '@coremail/core';

const log = createLogger('minio');

let _client: MinioClient | null = null;

export function getMinioClient(): MinioClient {
  if (!_client) {
    _client = new MinioClient({
      endPoint: config.MINIO_ENDPOINT,
      port: config.MINIO_PORT,
      useSSL: false,
      accessKey: config.MINIO_ACCESS_KEY,
      secretKey: config.MINIO_SECRET_KEY,
    });
  }
  return _client;
}

export async function ensureBuckets(): Promise<void> {
  const client = getMinioClient();
  const bucket = config.MINIO_BUCKET_ATTACHMENTS;
  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket, 'eu-central-1');
    log.info({ bucket }, 'Bucket created');
  }
  // v3.18.24 E4: set lifecycle policies so temporary objects are deleted
  // automatically — prevents the MinIO bucket from filling up over the years.
  await ensureLifecyclePolicies();
}

/**
 * v3.18.24 E4: MinIO lifecycle policies — automatic cleanup of temporary
 * objects after fixed retention periods.
 *
 * Prefix-based rules (by convention in the object keys, see helpers below):
 *  - `outbound-queue/`  → expire 7 days (BullMQ outbound attachments,
 *                         deleted anyway after a successful send,
 *                         lifecycle is the safety net for dead jobs)
 *  - `quarantine/`       → expire 90 days (rspamd quarantine)
 *  - `backups/`          → expire 365 days (backup retention)
 *
 * NOT in lifecycle: `attachments/` and `raw/` (e-mail attachments + raw messages),
 * because they belong directly to messages and are removed individually when
 * a message is deleted.
 *
 * Idempotent: setBucketLifecycle() overwrites the policy every time — the current
 * state is guaranteed on every container start.
 */
async function ensureLifecyclePolicies(): Promise<void> {
  const client = getMinioClient();
  const bucket = config.MINIO_BUCKET_ATTACHMENTS;
  try {
    // The MinIO SDK accepts an object or XML string — we use the object form.
    // Format per MinIO Node SDK: { Rule: [{ ID, Status, Filter, Expiration }] }
    const policy = {
      Rule: [
        {
          ID: 'coremail-outbound-queue-7d',
          Status: 'Enabled',
          Filter: { Prefix: 'outbound-queue/' },
          Expiration: { Days: 7 },
        },
        {
          ID: 'coremail-quarantine-90d',
          Status: 'Enabled',
          Filter: { Prefix: 'quarantine/' },
          Expiration: { Days: 90 },
        },
        {
          // v5.7.1: JMAP blob uploads (RFC 8620 §6.1) — clients must reference the
          // blob promptly; MinIO cleans up after 7 days.
          ID: 'coremail-jmap-upload-7d',
          Status: 'Enabled',
          Filter: { Prefix: 'jmap-upload/' },
          Expiration: { Days: 7 },
        },
        {
          ID: 'coremail-backups-365d',
          Status: 'Enabled',
          Filter: { Prefix: 'backups/' },
          Expiration: { Days: 365 },
        },
      ],
    };
    // setBucketLifecycle is only stable since MinIO Node SDK v7.1 — eslint-disable
    // for the any cast in case the type definition is missing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).setBucketLifecycle(bucket, policy);
    log.info({ bucket, rules: policy.Rule.length }, 'Lifecycle policy applied');
  } catch (err) {
    // On older MinIO versions or permission problems → WARN only, no throw
    // (bucket existence and normal operations must not be blocked).
    log.warn({ err, bucket }, 'Failed to set bucket lifecycle policy — continuing without');
  }
}

export async function uploadBuffer(
  objectKey: string,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  const client = getMinioClient();
  await client.putObject(config.MINIO_BUCKET_ATTACHMENTS, objectKey, buffer, buffer.length, {
    'Content-Type': mimeType,
  });
}

export async function downloadBuffer(objectKey: string): Promise<Buffer> {
  const client = getMinioClient();
  const stream = await client.getObject(config.MINIO_BUCKET_ATTACHMENTS, objectKey);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function deleteObject(objectKey: string): Promise<void> {
  const client = getMinioClient();
  await client.removeObject(config.MINIO_BUCKET_ATTACHMENTS, objectKey);
}

export function attachmentKey(messageId: string, filename: string): string {
  return `attachments/${messageId}/${filename}`;
}

/** v5.7.1: JMAP upload blobs (RFC 8620 §6.1), lifecycle 7 days. */
export function jmapUploadKey(accountId: string, blobId: string): string {
  return `jmap-upload/${accountId}/${blobId}`;
}

export function rawMessageKey(messageId: string): string {
  return `raw/${messageId}.eml`;
}

export function quarantineKey(quarantineId: string): string {
  return `quarantine/${quarantineId}.eml`;
}

export function backupKey(jobId: string, format: string): string {
  return `backups/${jobId}.${format}`;
}

/**
 * MinIO path for attachments of an outbound queue job.
 * These objects are downloaded by the worker when building the MIME message
 * and cleaned up after successful delivery.
 */
export function outboundAttachKey(jobId: string, filename: string): string {
  return `outbound-queue/${jobId}/${filename}`;
}
