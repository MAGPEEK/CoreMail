import { S3Client, PutObjectCommand, ListObjectsV2Command, HeadBucketCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createLogger } from '@coremail/core';

const log = createLogger('backup:s3');

function getClient(): S3Client {
  return new S3Client({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://minio:9000',
    region: process.env['S3_REGION'] ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'minioadmin',
      secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'minioadmin',
    },
    forcePathStyle: true, // Required for MinIO
  });
}

const BUCKET = process.env['BACKUP_BUCKET'] ?? 'coremail-backups';

/**
 * v3.18.26 Bugfix: Wird beim Service-Start aufgerufen. Verhindert dass
 * listBackups() crasht weil der Bucket nicht existiert (NoSuchBucket-Error
 * killte den ganzen backup-service-Container).
 *
 * Idempotent — wenn Bucket schon existiert (200 OK von HeadBucket): nichts tun.
 */
export async function ensureBackupBucket(): Promise<void> {
  const client = getClient();
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    log.info({ bucket: BUCKET }, 'Backup bucket exists');
  } catch (err) {
    // 404 NoSuchBucket → erstellen. Andere Errors → throwen.
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

export async function uploadToS3(
  localPath: string,
  s3Key: string,
  contentType = 'application/octet-stream'
): Promise<string> {
  const client = getClient();
  const fileSize = (await stat(localPath)).size;

  log.info({ s3Key, fileSize }, 'Uploading backup to S3');

  const upload = new Upload({
    client,
    params: {
      Bucket: BUCKET,
      Key: s3Key,
      Body: createReadStream(localPath),
      ContentType: contentType,
      Metadata: {
        'uploaded-at': new Date().toISOString(),
        'file-size': String(fileSize),
      },
    },
    partSize: 10 * 1024 * 1024, // 10 MB parts
    leavePartsOnError: false,
  });

  upload.on('httpUploadProgress', (progress) => {
    log.debug({ s3Key, loaded: progress.loaded, total: progress.total }, 'Upload progress');
  });

  await upload.done();

  const s3Uri = `s3://${BUCKET}/${s3Key}`;
  log.info({ s3Uri }, 'Upload complete');
  return s3Uri;
}

export async function listBackups(prefix: string): Promise<{ key: string; size: number; lastModified: Date }[]> {
  const client = getClient();
  try {
    const result = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (result.Contents ?? []).map((obj) => ({
      key: obj.Key ?? '',
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ?? new Date(),
    }));
  } catch (err) {
    // v3.18.26 Bugfix: NoSuchBucket darf den Service nicht crashen.
    // Wir versuchen den Bucket zu erstellen und liefern dann leere Liste zurück.
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
  // v3.18.28: Bekanntes Problem — http://minio:9000 ist nur intern erreichbar.
  // Frontend nutzt stattdessen den Download-Stream-Endpoint /backup/admin/download/:jobId.
  // Wir liefern hier den S3-Key zurück damit das Frontend ihn auf den richtigen
  // Stream-Endpoint mappen kann.
  return s3Key;
}

/**
 * v3.18.28: Object aus S3 als Stream zurück — wird im Express-Handler an den
 * Client gepiped. Funktioniert ohne presigned URL.
 */
export async function streamObject(s3Key: string): Promise<{ stream: Readable; contentLength?: number; contentType?: string }> {
  const client = getClient();
  const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
  return {
    stream: result.Body as Readable,
    ...(typeof result.ContentLength === 'number' ? { contentLength: result.ContentLength } : {}),
    ...(typeof result.ContentType === 'string' ? { contentType: result.ContentType } : {}),
  };
}

/**
 * v3.18.28: Object aus S3 löschen.
 */
export async function deleteObject(s3Key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: s3Key }));
}
