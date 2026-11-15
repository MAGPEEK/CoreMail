/**
 * Startup safety check of the object storage (pure — dependencies injected;
 * the Prisma/env wiring is in ../object-store-runtime.ts).
 *
 * The check prepares the store (directory/bucket, write probe) and looks up a
 * sample of the most recent object keys the database references
 * (Message.storagePath, Attachment.storagePath). When most of them are missing
 * — typically OBJECT_STORAGE was switched without migrating — the result is
 * `blocking`: the mail services refuse to start instead of serving mails whose
 * content cannot be read, and the log names the migration command.
 */
import type { ObjectStore, ObjectStorageDriver } from './types.js';

export type StorageStatus = 'ok' | 'degraded' | 'missing-objects' | 'unavailable' | 'ephemeral' | 'disabled' | 'pending';

export interface StorageCheckResult {
  driver: ObjectStorageDriver;
  location: string;
  status: StorageStatus;
  /** True when mail services must not start (see waitForObjectStorage). */
  blocking: boolean;
  sampled: number;
  missing: number;
  missingKeys: string[];
  /** Bucket lifecycle rules active (S3); false → periodic cleaner. */
  lifecycle?: boolean;
  error?: string;
  hint?: string;
  checkedAt: string;
}

export interface StorageCheckDeps {
  store: ObjectStore;
  /** Object keys referenced by the database (most recent first). */
  references: () => Promise<string[]>;
  /** Filesystem driver: true when the root is in the container's writable layer. */
  isEphemeral?: (root: string) => Promise<boolean>;
  allowEphemeral?: boolean;
  /** STORAGE_STARTUP_CHECK=off → status disabled, never blocking. */
  disabled?: boolean;
}

export function migrationHint(driver: ObjectStorageDriver): string {
  const from = driver === 'filesystem' ? 'minio' : 'filesystem';
  return `The database references objects that are not in the ${driver} store. If you switched OBJECT_STORAGE, `
    + `copy the objects first (the old store must still be reachable): `
    + `docker exec -it coremail coremail storage migrate --from ${from} --to ${driver}  — see docs/storage.md. `
    + `To go back, restore the previous OBJECT_STORAGE value and restart.`;
}

export async function checkObjectStorage(deps: StorageCheckDeps): Promise<StorageCheckResult> {
  const { store } = deps;
  const base = {
    driver: store.driver,
    location: store.location,
    sampled: 0,
    missing: 0,
    missingKeys: [] as string[],
    checkedAt: new Date().toISOString(),
  };
  if (deps.disabled) return { ...base, status: 'disabled', blocking: false };

  let lifecycle: boolean;
  try {
    lifecycle = (await store.init()).lifecycle;
  } catch (err) {
    return {
      ...base, status: 'unavailable', blocking: true,
      error: (err as Error).message,
      hint: store.driver === 'filesystem'
        ? 'STORAGE_PATH must be a writable directory on a persistent volume (compose: coremail-data:/data).'
        : 'Check MINIO_ENDPOINT/PORT/USE_SSL/CA_FILE, the credentials and that the bucket exists.',
    };
  }

  if (store.driver === 'filesystem' && deps.isEphemeral && !deps.allowEphemeral) {
    const root = store.location;
    if (await deps.isEphemeral(root).catch(() => false)) {
      return {
        ...base, status: 'ephemeral', blocking: true, lifecycle,
        error: `STORAGE_PATH ${root} is not on a mounted volume — mail data would be lost when the container is recreated`,
        hint: 'Mount a volume (docker-compose: "coremail-data:/data") or set STORAGE_ALLOW_EPHEMERAL=true for throw-away test setups.',
      };
    }
  }

  let keys: string[];
  try {
    keys = [...new Set((await deps.references()).filter((k) => typeof k === 'string' && k.length > 0))];
  } catch (err) {
    return { ...base, status: 'unavailable', blocking: true, lifecycle, error: `database not reachable: ${(err as Error).message}` };
  }

  const missingKeys: string[] = [];
  for (const key of keys) {
    let present = false;
    try { present = await store.exists(key); } catch { present = false; }
    if (!present) missingKeys.push(key);
  }
  const sampled = keys.length;
  const missing = missingKeys.length;
  const result = { ...base, sampled, missing, missingKeys: missingKeys.slice(0, 5), lifecycle };
  if (missing === 0) return { ...result, status: 'ok', blocking: false };
  // Majority missing → the store is the wrong one (switched without migration).
  // A single lost object must not take a working installation down.
  if (missing * 2 >= sampled) return { ...result, status: 'missing-objects', blocking: true, hint: migrationHint(store.driver) };
  return { ...result, status: 'degraded', blocking: false, hint: 'Some referenced objects are missing; run `coremail storage status` and check the storage backend.' };
}

/** Parses /proc/self/mountinfo: true when `path` lives on the overlay root of a container. */
export function isOnContainerRootFs(path: string, mountinfo: string): boolean {
  const unescape = (s: string): string => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
  let best = '';
  let bestType = '';
  let rootType = '';
  for (const line of mountinfo.split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length < 10) continue;
    const mountPoint = unescape(parts[4]!);
    const sepIdx = parts.indexOf('-');
    const fsType = sepIdx >= 0 ? parts[sepIdx + 1] ?? '' : '';
    if (mountPoint === '/') rootType = fsType;
    const covers = mountPoint === '/' || path === mountPoint || path.startsWith(mountPoint.endsWith('/') ? mountPoint : mountPoint + '/');
    if (covers && mountPoint.length >= best.length) { best = mountPoint; bestType = fsType; }
  }
  if (!best) return false;
  return best === '/' && ['overlay', 'aufs', 'overlayfs', 'fuse-overlayfs'].includes(bestType || rootType);
}
