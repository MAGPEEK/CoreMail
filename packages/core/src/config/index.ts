import { z } from 'zod';

/**
 * A numeric env variable with a default. 8.0.0: an EMPTY value counts as unset — compose
 * passes `MINIO_PORT: ${MINIO_PORT:-}`, and `z.coerce.number()` alone turns "" into 0.
 */
const envNumber = (fallback: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().default(fallback));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://redis:6379'),
  MINIO_ENDPOINT: z.string().default('minio'),
  MINIO_PORT: envNumber(9000),
  // 8.0.1: no well-known default credentials. The object store reads and
  // validates these itself (`@coremail/storage` parseObjectStorageConfig fails
  // closed when the minio/s3 driver is selected without them).
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  MINIO_BUCKET_ATTACHMENTS: z.string().default('coremail-attachments'),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: envNumber(900),        // 15 minutes
  JWT_REFRESH_TTL: envNumber(2592000),   // 30 days
  PEPPER: z.string().min(32),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  PORT: envNumber(3000),
});

/** Parses an environment (exported for tests); `config` below is `process.env` parsed once. */
export function parseEnvConfig(env: Record<string, string | undefined>) {
  return EnvSchema.safeParse(env);
}

function loadConfig() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof EnvSchema>;
