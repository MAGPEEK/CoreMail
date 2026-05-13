import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino(
  config.NODE_ENV === 'development'
    ? {
        level: config.LOG_LEVEL,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
      }
    : { level: config.LOG_LEVEL }
);

export function createLogger(service: string) {
  return logger.child({ service });
}
