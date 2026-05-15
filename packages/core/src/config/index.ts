import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://redis:6379'),
  MINIO_ENDPOINT: z.string().default('minio'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET_ATTACHMENTS: z.string().default('coremail-attachments'),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.coerce.number().default(900),        // 15 minutes
  JWT_REFRESH_TTL: z.coerce.number().default(2592000),   // 30 days
  PEPPER: z.string().min(32),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  PORT: z.coerce.number().default(3000),
});

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
