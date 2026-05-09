import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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
  const result = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));

  return (result.Contents ?? []).map((obj) => ({
    key: obj.Key ?? '',
    size: obj.Size ?? 0,
    lastModified: obj.LastModified ?? new Date(),
  }));
}

export async function getSignedDownloadUrl(s3Key: string): Promise<string> {
  // For MinIO / S3-compatible, generate a pre-signed URL (TTL 1 hour)
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = getClient();
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: s3Key });
  return getSignedUrl(client, command, { expiresIn: 3600 });
}
