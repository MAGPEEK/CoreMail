/**
 * Object storage helpers (historic module name — since v7.1 every call goes
 * through the configured driver, see ../object-store/). The function names are
 * kept so existing callers and test fakes continue to work:
 *
 *   uploadBuffer / downloadBuffer / getObjectStream / objectExists / deleteObject
 *   ensureBuckets  → prepares the store (directory or bucket + lifecycle rules)
 *
 * OBJECT_STORAGE=minio (default) | s3 | filesystem.
 */
import type { Readable } from 'node:stream';
import type { Client as MinioClient } from 'minio';
import { getObjectStore, safeKeySegment, S3ObjectStore, parseObjectStorageConfig, type InitResult } from '../object-store/index.js';
import type { S3StorageConfig } from '../object-store/config.js';

let _legacyClient: S3ObjectStore | null = null;

/**
 * @deprecated Use getObjectStore(). Returns the MinIO client of the configured
 * s3/minio store (or one built from the MINIO_* variables for a filesystem install).
 */
export function getMinioClient(): MinioClient {
  const store = getObjectStore();
  if (store instanceof S3ObjectStore) return store.client;
  _legacyClient ??= new S3ObjectStore(parseObjectStorageConfig(process.env, 'minio') as S3StorageConfig);
  return _legacyClient.client;
}

/** Prepares the configured object store (directory/bucket + expiry rules). */
export async function ensureBuckets(): Promise<InitResult> {
  return getObjectStore().init();
}

export async function uploadBuffer(objectKey: string, buffer: Buffer, mimeType: string): Promise<void> {
  await getObjectStore().put(objectKey, buffer, { contentType: mimeType });
}

export async function downloadBuffer(objectKey: string): Promise<Buffer> {
  return getObjectStore().get(objectKey);
}

/** Readable stream of an object (attachment downloads without buffering). */
export async function getObjectStream(objectKey: string): Promise<Readable> {
  return getObjectStore().getStream(objectKey);
}

/** True when the object exists (false when missing, rethrows other errors). */
export async function objectExists(objectKey: string): Promise<boolean> {
  return getObjectStore().exists(objectKey);
}

/** Idempotent delete. */
export async function deleteObject(objectKey: string): Promise<void> {
  await getObjectStore().delete(objectKey);
}

export function attachmentKey(messageId: string, filename: string): string {
  return `attachments/${safeKeySegment(messageId)}/${safeKeySegment(filename)}`;
}

/** v5.7.1: JMAP upload blobs (RFC 8620 §6.1), expire after 7 days. */
export function jmapUploadKey(accountId: string, blobId: string): string {
  return `jmap-upload/${safeKeySegment(accountId)}/${safeKeySegment(blobId)}`;
}

/**
 * @deprecated Per-message raw keys (`raw/<id>.eml`) are still read for existing rows;
 * new raw messages are stored content-addressed via `storeRawMessage()`.
 */
export function rawMessageKey(messageId: string): string {
  return `raw/${safeKeySegment(messageId)}.eml`;
}

export function quarantineKey(quarantineId: string): string {
  return `quarantine/${safeKeySegment(quarantineId)}.eml`;
}

export function backupKey(jobId: string, format: string): string {
  return `backups/${safeKeySegment(jobId)}.${safeKeySegment(format)}`;
}

/**
 * Object key for an attachment of an outbound queue job (expires after 7 days;
 * deleted by the worker after delivery). `name` is made a safe key segment —
 * pass an index rather than the user's file name.
 */
export function outboundAttachKey(jobId: string, name: string): string {
  return `outbound-queue/${safeKeySegment(jobId)}/${safeKeySegment(name)}`;
}
