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
  // v3.18.24 E4: Lifecycle-Policies setzen damit temporäre Objekte automatisch
  // gelöscht werden — verhindert dass der MinIO-Bucket über Jahre vollläuft.
  await ensureLifecyclePolicies();
}

/**
 * v3.18.24 E4: MinIO-Lifecycle-Policies — automatisches Cleanup für temporäre
 * Objekte nach festen Aufbewahrungsfristen.
 *
 * Prefix-basierte Regeln (per Konvention in den Object-Keys, siehe Helper unten):
 *  - `outbound-queue/`  → expire 7 Tage (BullMQ-Outbound-Anhänge,
 *                         werden nach Send-Erfolg ohnehin gelöscht,
 *                         Lifecycle ist Sicherheitsnetz für tote Jobs)
 *  - `quarantine/`       → expire 90 Tage (rspamd-quarantäne)
 *  - `backups/`          → expire 365 Tage (Backup-Retention)
 *
 * NICHT in Lifecycle: `attachments/` und `raw/` (E-Mail-Anhänge + Raw-Messages),
 * weil die direkt zu Messages gehören und beim Message-Delete einzeln entfernt
 * werden.
 *
 * Idempotent: setBucketLifecycle() überschreibt die Policy jedes Mal — bei jedem
 * Container-Start wird der aktuelle State garantiert.
 */
async function ensureLifecyclePolicies(): Promise<void> {
  const client = getMinioClient();
  const bucket = config.MINIO_BUCKET_ATTACHMENTS;
  try {
    // MinIO SDK akzeptiert Object oder XML-String — wir nutzen Object-Form.
    // Format laut MinIO Node-SDK: { Rule: [{ ID, Status, Filter, Expiration }] }
    const policy = {
      Rule: [
        {
          ID: 'coremail-outbound-queue-7d',
          Status: 'Enabled',
          Filter: { Prefix: 'outbound-queue/' },
          Expiration: { Days: 7 },
        },
        {
          ID: 'coremail-quarantine-90d',
          Status: 'Enabled',
          Filter: { Prefix: 'quarantine/' },
          Expiration: { Days: 90 },
        },
        {
          ID: 'coremail-backups-365d',
          Status: 'Enabled',
          Filter: { Prefix: 'backups/' },
          Expiration: { Days: 365 },
        },
      ],
    };
    // setBucketLifecycle ist erst seit MinIO Node SDK v7.1 stabil — eslint-disable
    // für any cast falls Typdefinition nicht vorhanden ist.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).setBucketLifecycle(bucket, policy);
    log.info({ bucket, rules: policy.Rule.length }, 'Lifecycle policy applied');
  } catch (err) {
    // Bei älteren MinIO-Versionen oder Permission-Problemen → nur WARN, kein Throw
    // (Bucket-Existenz und normale Operationen sollen nicht blockieren).
    log.warn({ err, bucket }, 'Failed to set bucket lifecycle policy — continuing without');
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

/**
 * MinIO-Pfad für Anhänge eines ausgehenden Queue-Jobs.
 * Diese Objekte werden beim Aufbau der MIME-Nachricht im Worker heruntergeladen
 * und nach erfolgreicher Zustellung bereinigt.
 */
export function outboundAttachKey(jobId: string, filename: string): string {
  return `outbound-queue/${jobId}/${filename}`;
}
