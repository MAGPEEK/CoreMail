/** Backup S3 target from the environment (pure, unit-testable — no CoreMail imports). */

export class BackupStorageConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupStorageConfigError'; }
}

export interface BackupS3Options {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  forcePathStyle: boolean;
}

/**
 * S3_ENDPOINT (default http://minio:9000), S3_REGION (default us-east-1),
 * S3_ACCESS_KEY + S3_SECRET_KEY (required). Fails closed — no fallback
 * to the well-known minioadmin/minioadmin credentials.
 */
export function backupS3Options(env: Record<string, string | undefined> = process.env): BackupS3Options {
  const accessKeyId = (env['S3_ACCESS_KEY'] ?? '').trim();
  const secretAccessKey = env['S3_SECRET_KEY'] ?? '';
  if (!accessKeyId || !secretAccessKey.trim()) {
    throw new BackupStorageConfigError('Backup storage needs S3_ACCESS_KEY and S3_SECRET_KEY (no default credentials; '
      + 'bundled MinIO: S3_ACCESS_KEY=$MINIO_ROOT_USER, S3_SECRET_KEY=$MINIO_ROOT_PASSWORD)');
  }
  return {
    endpoint: (env['S3_ENDPOINT'] ?? '').trim() || 'http://minio:9000',
    region: (env['S3_REGION'] ?? '').trim() || 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // Required for MinIO
  };
}
