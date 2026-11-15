/**
 * Object storage driver interface (v7.1).
 *
 * Every object-storage use in CoreMail (raw messages, attachments, quarantine,
 * outbound-queue attachments, JMAP uploads, S/MIME files) goes through one
 * `ObjectStore`, selected by `OBJECT_STORAGE=minio|s3|filesystem`
 * (see config.ts and index.ts). Keys are `/`-separated relative paths such as
 * `raw/ab/<sha256>.eml` or `attachments/<messageId>/0-<sha16>`.
 */
import type { Readable } from 'node:stream';

export type ObjectStorageDriver = 'minio' | 's3' | 'filesystem';
export const OBJECT_STORAGE_DRIVERS: readonly ObjectStorageDriver[] = ['minio', 's3', 'filesystem'];

export interface ObjectStat {
  size: number;
  lastModified: Date;
}

export interface ObjectInfo extends ObjectStat {
  key: string;
}

export interface PutOptions {
  contentType?: string;
  /** Byte length of a stream (S3 uses it to avoid multipart buffering). */
  size?: number;
  /**
   * Replace an existing content-addressed object. Content-addressed keys
   * (`raw/<aa>/<sha256>.eml`) are written once; only the migration's repair of
   * a mismatching copy sets this.
   */
  overwrite?: boolean;
}

export interface InitResult {
  /** True when the backend expires temporary prefixes itself (S3 lifecycle rules). */
  lifecycle: boolean;
}

export interface ObjectStore {
  readonly driver: ObjectStorageDriver;
  /** Human-readable location without secrets (path or endpoint/bucket). */
  readonly location: string;
  /** Prepares the backend (directory / bucket + lifecycle). Idempotent. */
  init(): Promise<InitResult>;
  put(key: string, data: Buffer, opts?: PutOptions): Promise<void>;
  putStream(key: string, stream: Readable, opts?: PutOptions): Promise<void>;
  /** Whole object; rejects with {@link ObjectNotFoundError} when missing. */
  get(key: string): Promise<Buffer>;
  /** Streaming read; rejects with {@link ObjectNotFoundError} when missing. */
  getStream(key: string): Promise<Readable>;
  /** Size + mtime, or null when the object does not exist. */
  stat(key: string): Promise<ObjectStat | null>;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** All objects whose key starts with `prefix` ('' = everything). */
  list(prefix: string): AsyncIterable<ObjectInfo>;
}

/** Thrown when an object does not exist. `code` matches the S3 error code. */
export class ObjectNotFoundError extends Error {
  readonly code = 'NoSuchKey';
  constructor(readonly key: string) {
    super(`NoSuchKey: object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

/** Thrown for keys that are not safe relative paths (traversal, NUL, …). */
export class InvalidObjectKeyError extends Error {
  readonly code = 'InvalidObjectKey';
  constructor(readonly key: string, reason: string) {
    super(`invalid object key ${JSON.stringify(key)}: ${reason}`);
    this.name = 'InvalidObjectKeyError';
  }
}

export class ObjectStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStorageConfigError';
  }
}

export function isNotFound(err: unknown): boolean {
  if (err instanceof ObjectNotFoundError) return true;
  const code = (err as { code?: string } | null)?.code;
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'ENOENT';
}
