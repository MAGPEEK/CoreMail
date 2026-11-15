/**
 * Object storage entry point: driver selection by OBJECT_STORAGE (see config.ts).
 *
 *   getObjectStore()        the configured store (singleton per process)
 *   createObjectStore(cfg)  a store for an explicit configuration (migration)
 *
 * Test seams: `globalThis.__objectStore` replaces the store entirely;
 * `globalThis.__minioClient` replaces only the MinIO client of the s3 driver.
 */
import { createLogger } from '@coremail/core/logger';
import { parseObjectStorageConfig, type ObjectStorageConfig } from './config.js';
import { FilesystemObjectStore } from './filesystem.js';
import { S3ObjectStore } from './s3.js';
import type { ObjectStore, ObjectStorageDriver } from './types.js';

export * from './types.js';
export * from './keys.js';
export * from './config.js';
export { FilesystemObjectStore, type FilesystemStoreOptions } from './filesystem.js';
export { S3ObjectStore, EXPIRY_RULES, minioClientOptions } from './s3.js';
export * from './cleaner.js';
export * from './health.js';
export * from './migrate.js';

const log = createLogger('object-store');

declare global {
  // eslint-disable-next-line no-var
  var __objectStore: ObjectStore | undefined;
}

let _store: ObjectStore | null = null;

export function createObjectStore(cfg: ObjectStorageConfig): ObjectStore {
  return cfg.driver === 'filesystem' ? new FilesystemObjectStore(cfg.root) : new S3ObjectStore(cfg);
}

/** The configured object store (OBJECT_STORAGE, default minio). */
export function getObjectStore(): ObjectStore {
  if (globalThis.__objectStore) return globalThis.__objectStore;
  if (!_store) {
    const cfg = parseObjectStorageConfig(process.env);
    _store = createObjectStore(cfg);
    log.info({ driver: _store.driver, location: _store.location }, 'Object storage driver selected');
  }
  return _store;
}

/** A store for `driver` built from the same environment (migration source/target). */
export function objectStoreFor(driver: ObjectStorageDriver, env: Record<string, string | undefined> = process.env): ObjectStore {
  const current = getObjectStore();
  if (current.driver === driver && !globalThis.__objectStore) return current;
  return createObjectStore(parseObjectStorageConfig(env, driver));
}

/** Tests only: forget the cached store. */
export function resetObjectStoreForTests(): void {
  _store = null;
}
