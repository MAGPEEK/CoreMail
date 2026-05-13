import { PrismaClient } from '@prisma/client';
import { createLogger } from '@coremail/core/logger';

const log = createLogger('prisma');

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ],
  });
}

// Singleton — reuse in development (hot reload), create fresh in production
export const prisma: PrismaClient =
  globalThis.__prisma ?? createPrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__prisma = prisma;
}

prisma.$on('error' as never, (e: unknown) => log.error(e, 'Prisma error'));
prisma.$on('warn' as never, (e: unknown) => log.warn(e, 'Prisma warning'));

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  log.info('Database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  log.info('Database disconnected');
}
