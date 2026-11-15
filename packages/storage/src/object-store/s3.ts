/**
 * S3-compatible object store (OBJECT_STORAGE=minio|s3) on the MinIO client.
 * Works with MinIO, AWS S3, Backblaze B2, Wasabi, Hetzner Object Storage and
 * Cloudflare R2 (TLS via MINIO_USE_SSL, custom CA via MINIO_CA_FILE, region and
 * path/virtual-host style configurable — see config.ts).
 *
 * Test seam: `globalThis.__minioClient` replaces the client (fakes implement
 * getObject/putObject/statObject[/removeObject/listObjectsV2]).
 */
import { readFileSync } from 'node:fs';
import { Agent as HttpsAgent } from 'node:https';
import { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';
import { createLogger } from '@coremail/core/logger';
import { describeConfig, type S3StorageConfig } from './config.js';
import { ObjectNotFoundError, isNotFound, type InitResult, type ObjectInfo, type ObjectStat, type ObjectStore, type PutOptions } from './types.js';
import { validateObjectKey } from './keys.js';

const log = createLogger('object-store');

declare global {
  // Test seam (like globalThis.__prisma): an object-store fake used instead of MinIO.
  // eslint-disable-next-line no-var
  var __minioClient: MinioClient | undefined;
}

/** Lifecycle rules of the temporary prefixes (the filesystem driver's cleaner uses the same table). */
export const EXPIRY_RULES: ReadonlyArray<{ id: string; prefix: string; days: number }> = [
  { id: 'coremail-outbound-queue-7d', prefix: 'outbound-queue/', days: 7 },
  { id: 'coremail-quarantine-90d', prefix: 'quarantine/', days: 90 },
  // JMAP blob uploads (RFC 8620 §6.1) — clients must reference the blob promptly.
  { id: 'coremail-jmap-upload-7d', prefix: 'jmap-upload/', days: 7 },
  { id: 'coremail-backups-365d', prefix: 'backups/', days: 365 },
];

/** MinIO client options for a configuration (exported for tests). */
export function minioClientOptions(cfg: S3StorageConfig, readCa: (path: string) => Buffer = (p) => readFileSync(p)): ConstructorParameters<typeof MinioClient>[0] {
  return {
    endPoint: cfg.endPoint,
    port: cfg.port,
    useSSL: cfg.useSSL,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    ...(cfg.region ? { region: cfg.region } : {}),
    ...(cfg.pathStyle !== undefined ? { pathStyle: cfg.pathStyle } : {}),
    ...(cfg.caFile ? { transportAgent: new HttpsAgent({ keepAlive: true, ca: readCa(cfg.caFile) }) } : {}),
  };
}

export class S3ObjectStore implements ObjectStore {
  readonly driver: 'minio' | 's3';
  readonly location: string;
  readonly bucket: string;
  private _client: MinioClient | null;

  constructor(private readonly cfg: S3StorageConfig, client?: MinioClient) {
    this.driver = cfg.driver;
    this.bucket = cfg.bucket;
    this.location = describeConfig(cfg);
    this._client = client ?? null;
  }

  get client(): MinioClient {
    if (globalThis.__minioClient) return globalThis.__minioClient;
    if (!this._client) this._client = new MinioClient(minioClientOptions(this.cfg));
    return this._client;
  }

  async init(): Promise<InitResult> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      const region = this.cfg.region ?? (this.driver === 'minio' ? 'eu-central-1' : 'us-east-1');
      try {
        await this.client.makeBucket(this.bucket, region);
        log.info({ bucket: this.bucket }, 'Bucket created');
      } catch (err) {
        throw new Error(`bucket ${this.bucket} does not exist at ${this.location} and could not be created: ${(err as Error).message}`);
      }
    }
    return { lifecycle: await this.applyLifecycle() };
  }

  /** Sets prefix expiry rules; false when the provider refuses (→ the periodic cleaner takes over). */
  private async applyLifecycle(): Promise<boolean> {
    try {
      const policy = {
        Rule: EXPIRY_RULES.map((r) => ({ ID: r.id, Status: 'Enabled', Filter: { Prefix: r.prefix }, Expiration: { Days: r.days } })),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.client as any).setBucketLifecycle(this.bucket, policy);
      log.info({ bucket: this.bucket, rules: policy.Rule.length }, 'Lifecycle policy applied');
      return true;
    } catch (err) {
      log.warn({ err, bucket: this.bucket }, 'Bucket lifecycle policy not supported — the periodic cleaner expires temporary objects instead');
      return false;
    }
  }

  async put(key: string, data: Buffer, opts: PutOptions = {}): Promise<void> {
    validateObjectKey(key, { platform: 'linux' });
    await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': opts.contentType ?? 'application/octet-stream' });
  }

  async putStream(key: string, stream: Readable, opts: PutOptions = {}): Promise<void> {
    validateObjectKey(key, { platform: 'linux' });
    await this.client.putObject(this.bucket, key, stream, opts.size, { 'Content-Type': opts.contentType ?? 'application/octet-stream' });
  }

  async get(key: string): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<Readable> {
    try {
      return (await this.client.getObject(this.bucket, key)) as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const st = await this.client.statObject(this.bucket, key) as { size: number; lastModified?: Date };
      return { size: st.size, lastModified: st.lastModified ?? new Date(0) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const stream = this.client.listObjectsV2(this.bucket, prefix, true) as unknown as AsyncIterable<{ name?: string; size?: number; lastModified?: Date }>;
    for await (const o of stream) {
      if (!o.name) continue; // common prefixes
      yield { key: o.name, size: o.size ?? 0, lastModified: o.lastModified ?? new Date(0) };
    }
  }
}
