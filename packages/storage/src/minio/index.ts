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

export function rawMessageKey(messageId: string): string {
  return `raw/${messageId}.eml`;
}

export function quarantineKey(quarantineId: string): string {
  return `quarantine/${quarantineId}.eml`;
}

export function backupKey(jobId: string, format: string): string {
  return `backups/${jobId}.${format}`;
}
