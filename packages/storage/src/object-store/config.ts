/**
 * Object storage configuration from the environment (pure, testable).
 *
 *   OBJECT_STORAGE   minio (default) | s3 | filesystem
 *   STORAGE_PATH     filesystem root (default /data/objects)
 *
 *   minio / s3 (same client, same variables):
 *   MINIO_ENDPOINT            host name (default minio); a URL such as
 *                             https://s3.eu-central-1.amazonaws.com sets host, SSL and port
 *   MINIO_PORT                default 9000, or 443 with MINIO_USE_SSL=true
 *   MINIO_USE_SSL             default false (unchanged pre-7.1 behaviour)
 *   MINIO_REGION              e.g. eu-central-1, auto (Cloudflare R2); default: auto-detected
 *   MINIO_CA_FILE             PEM bundle of a private CA for the S3 endpoint (needs SSL)
 *   MINIO_PATH_STYLE          true = https://host/bucket/key, false = https://bucket.host/key
 *                             (default: the client decides — path style except for AWS)
 *   MINIO_ACCESS_KEY / MINIO_SECRET_KEY (required, no default), MINIO_BUCKET_ATTACHMENTS (default coremail-attachments)
 *
 * `minio` and `s3` differ only in defaults: `minio` creates the bucket in
 * eu-central-1 (as before 7.1); `s3` expects an existing bucket and creates it
 * only if it is missing and the credentials allow it.
 */
import { isAbsolute, resolve } from 'node:path';
import { ObjectStorageConfigError, OBJECT_STORAGE_DRIVERS, type ObjectStorageDriver } from './types.js';

export const DEFAULT_STORAGE_PATH = '/data/objects';
export const DEFAULT_BUCKET = 'coremail-attachments';

export interface FilesystemStorageConfig {
  driver: 'filesystem';
  root: string;
}

export interface S3StorageConfig {
  driver: 'minio' | 's3';
  endPoint: string;
  port: number;
  useSSL: boolean;
  region?: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  pathStyle?: boolean;
  caFile?: string;
}

export type ObjectStorageConfig = FilesystemStorageConfig | S3StorageConfig;

type Env = Record<string, string | undefined>;

export function parseBool(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ObjectStorageConfigError(`${name} must be true or false (got ${JSON.stringify(raw)})`);
}

/** Driver named by OBJECT_STORAGE (unset/empty → minio, the pre-7.1 behaviour). */
export function parseDriver(raw: string | undefined): ObjectStorageDriver {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'minio';
  if ((OBJECT_STORAGE_DRIVERS as readonly string[]).includes(v)) return v as ObjectStorageDriver;
  throw new ObjectStorageConfigError(`OBJECT_STORAGE must be one of ${OBJECT_STORAGE_DRIVERS.join(', ')} (got ${JSON.stringify(raw)})`);
}

/**
 * Configuration of `driver` (default: OBJECT_STORAGE). The migration builds the
 * source and target stores with an explicit driver from the same environment.
 */
export function parseObjectStorageConfig(env: Env = process.env, driver: ObjectStorageDriver = parseDriver(env['OBJECT_STORAGE'])): ObjectStorageConfig {
  if (driver === 'filesystem') {
    const raw = (env['STORAGE_PATH'] ?? '').trim() || DEFAULT_STORAGE_PATH;
    if (!isAbsolute(raw)) throw new ObjectStorageConfigError(`STORAGE_PATH must be an absolute path (got ${JSON.stringify(raw)})`);
    const root = resolve(raw);
    if (resolve(root, '..') === root) throw new ObjectStorageConfigError('STORAGE_PATH must not be the filesystem root');
    return { driver, root };
  }

  let endPoint = (env['MINIO_ENDPOINT'] ?? '').trim() || 'minio';
  let useSSL = parseBool('MINIO_USE_SSL', env['MINIO_USE_SSL']);
  let urlPort: number | undefined;
  if (/^https?:\/\//i.test(endPoint)) {
    let u: URL;
    try { u = new URL(endPoint); } catch { throw new ObjectStorageConfigError(`MINIO_ENDPOINT is not a valid URL: ${endPoint}`); }
    if (u.pathname !== '/' && u.pathname !== '') throw new ObjectStorageConfigError('MINIO_ENDPOINT must not contain a path (set the bucket via MINIO_BUCKET_ATTACHMENTS)');
    const scheme = u.protocol === 'https:';
    if (useSSL !== undefined && useSSL !== scheme) throw new ObjectStorageConfigError(`MINIO_USE_SSL=${useSSL} contradicts the scheme of MINIO_ENDPOINT (${u.protocol})`);
    useSSL = scheme;
    endPoint = u.hostname.replace(/^\[|\]$/g, '');
    if (u.port) urlPort = Number(u.port);
  } else if (/[/\s]/.test(endPoint)) {
    throw new ObjectStorageConfigError(`MINIO_ENDPOINT must be a host name or URL (got ${JSON.stringify(endPoint)})`);
  }
  const ssl = useSSL ?? false;

  let port: number;
  const rawPort = (env['MINIO_PORT'] ?? '').trim();
  if (rawPort !== '') {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ObjectStorageConfigError(`MINIO_PORT must be 1-65535 (got ${JSON.stringify(rawPort)})`);
    if (urlPort !== undefined && urlPort !== port) throw new ObjectStorageConfigError(`MINIO_PORT=${port} contradicts the port in MINIO_ENDPOINT (${urlPort})`);
  } else {
    port = urlPort ?? (ssl ? 443 : 9000);
  }

  const region = (env['MINIO_REGION'] ?? '').trim() || undefined;
  if (region !== undefined && !/^[a-z0-9-]{1,64}$/i.test(region)) throw new ObjectStorageConfigError(`MINIO_REGION is not a valid region name: ${region}`);

  const caFile = (env['MINIO_CA_FILE'] ?? '').trim() || undefined;
  if (caFile && !ssl) throw new ObjectStorageConfigError('MINIO_CA_FILE is set but MINIO_USE_SSL is not true — a CA only applies to TLS connections');

  const pathStyle = parseBool('MINIO_PATH_STYLE', env['MINIO_PATH_STYLE']);
  const bucket = (env['MINIO_BUCKET_ATTACHMENTS'] ?? '').trim() || DEFAULT_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new ObjectStorageConfigError(`MINIO_BUCKET_ATTACHMENTS is not a valid bucket name: ${bucket}`);

  // 8.0.1: fail closed — no silent fallback to the well-known minioadmin/minioadmin.
  const accessKey = (env['MINIO_ACCESS_KEY'] ?? '').trim();
  const secretKey = env['MINIO_SECRET_KEY'] ?? '';
  if (!accessKey || !secretKey.trim()) {
    throw new ObjectStorageConfigError(
      `OBJECT_STORAGE=${driver} needs MINIO_ACCESS_KEY and MINIO_SECRET_KEY (no default credentials). `
      + 'Bundled MinIO: MINIO_ACCESS_KEY=$MINIO_ROOT_USER, MINIO_SECRET_KEY=$MINIO_ROOT_PASSWORD (docker-compose.yml sets both).',
    );
  }

  return {
    driver,
    endPoint,
    port,
    useSSL: ssl,
    ...(region ? { region } : {}),
    accessKey,
    secretKey,
    bucket,
    ...(pathStyle !== undefined ? { pathStyle } : {}),
    ...(caFile ? { caFile } : {}),
  };
}

/** Location string without credentials (logs, health, admin API). */
export function describeConfig(cfg: ObjectStorageConfig): string {
  if (cfg.driver === 'filesystem') return cfg.root;
  const defaultPort = cfg.useSSL ? 443 : 80;
  return `${cfg.useSSL ? 'https' : 'http'}://${cfg.endPoint}${cfg.port === defaultPort ? '' : ':' + cfg.port}/${cfg.bucket}`;
}

/** True when two configurations address the same objects. */
export function sameLocation(a: ObjectStorageConfig, b: ObjectStorageConfig): boolean {
  return describeConfig(a) === describeConfig(b);
}
