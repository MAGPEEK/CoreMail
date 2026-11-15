import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Every child logger (direct `createLogger()` children and nested
 * `log.child()` calls via pino's `onChild` hook) is tracked weakly so that
 * `setLogLevel()` can change the level of the whole process at runtime —
 * pino children copy the parent level at creation and do not follow later
 * changes of the parent.
 */
const trackedChildren = new Set<WeakRef<pino.Logger>>();

function track(child: pino.Logger): void {
  trackedChildren.add(new WeakRef(child));
}

/**
 * Secrets never reach the log. Paths are pino (fast-redact) paths: a bare name
 * matches a top-level key of the logged object, `*.x` one level below (e.g.
 * `{ body: { password } }`), and the header paths cover `req`/`res`
 * serializers as well as raw header objects logged as `headers`. Matching
 * values are replaced by "[Redacted]".
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'authorization', 'cookie', '["set-cookie"]',
  'password', 'currentPassword', 'newPassword', 'appPassword',
  'token', 'accessToken', 'refreshToken', 'challengeToken', 'secret', 'clientSecret',
  '*.authorization', '*.cookie', '*["set-cookie"]',
  '*.password', '*.currentPassword', '*.newPassword', '*.appPassword',
  '*.token', '*.accessToken', '*.refreshToken', '*.challengeToken', '*.secret', '*.clientSecret',
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization', 'headers.cookie', 'headers["x-internal-token"]',
];

export const LOG_REDACT = { paths: [...LOG_REDACT_PATHS], censor: '[Redacted]' } satisfies pino.LoggerOptions['redact'];

const baseOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  redact: LOG_REDACT,
  onChild: (child) => track(child as pino.Logger),
};

export const logger = pino(
  config.NODE_ENV === 'development'
    ? {
        ...baseOptions,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
      }
    : baseOptions
);

export function createLogger(service: string) {
  return logger.child({ service });
}

export type RuntimeLogLevel = 'error' | 'warn' | 'info' | 'debug';
const RUNTIME_LEVELS: readonly RuntimeLogLevel[] = ['error', 'warn', 'info', 'debug'];

/** 'ERROR' / 'warn' / ' Info ' → canonical pino level, anything else → null. */
export function normalizeLogLevel(value: unknown): RuntimeLogLevel | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return (RUNTIME_LEVELS as readonly string[]).includes(v) ? (v as RuntimeLogLevel) : null;
}

/** Current level of the root logger. */
export function getLogLevel(): string {
  return logger.level;
}

/**
 * Sets the level of the root logger and every live child logger.
 * Returns the number of loggers that were updated (root included).
 */
export function setLogLevel(level: RuntimeLogLevel): number {
  logger.level = level;
  let n = 1;
  for (const ref of trackedChildren) {
    const child = ref.deref();
    if (!child) { trackedChildren.delete(ref); continue; }
    child.level = level;
    n++;
  }
  return n;
}
