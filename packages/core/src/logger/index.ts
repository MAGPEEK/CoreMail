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

/** Secret-bearing keys (pino paths are case-sensitive: header spellings are listed separately). */
const SECRET_KEYS = [
  'password', 'currentPassword', 'newPassword', 'appPassword', 'pass', 'passwd',
  'token', 'accessToken', 'refreshToken', 'challengeToken', 'idToken', 'secret', 'clientSecret',
  'apiKey', 'privateKey', 'totpSecret', 'mfaCode', 'backupCode', 'code_verifier',
] as const;
const HEADER_KEYS = [
  'authorization', 'Authorization', 'cookie', 'Cookie', '["set-cookie"]', '["Set-Cookie"]',
  '["x-internal-token"]', '["X-Internal-Token"]', '["proxy-authorization"]', '["Proxy-Authorization"]',
] as const;
const at = (prefix: string, key: string): string => (key.startsWith('[') ? `${prefix}${key}` : `${prefix}.${key}`);

/**
 * Secrets never reach the log. Paths are pino (fast-redact) paths: a bare name
 * matches a top-level key of the logged object, `*.x` one level below (e.g.
 * `{ body: { password } }`) and `*.*.x` two levels below (e.g.
 * `{ req: { body: { password } } }`, `{ user: { creds: { token } } }`). The
 * header paths cover `req`/`res` serializers, raw header objects logged as
 * `headers` and headers nested one level deeper (`{ request: { headers } }`) in
 * the lowercase (Node) and canonical (fetch/axios) spelling. `err.command.args`
 * / `*.command.args` hide the arguments of failed ioredis commands — an AUTH
 * error carries the Redis password there. Matching values become "[Redacted]".
 */
export const LOG_REDACT_PATHS: readonly string[] = [...new Set([
  ...HEADER_KEYS,
  ...SECRET_KEYS,
  ...HEADER_KEYS.map((k) => at('*', k)),
  ...SECRET_KEYS.map((k) => at('*', k)),
  ...SECRET_KEYS.map((k) => at('*.*', k)),
  ...['req.headers', 'res.headers', 'headers', '*.headers', 'request.headers', 'response.headers', 'config.headers']
    .flatMap((h) => HEADER_KEYS.map((k) => at(h, k))),
  // ioredis ReplyError/MaxRetriesPerRequestError: { command: { name: 'auth', args: [password] } }
  'err.command.args', 'error.command.args', 'command.args', '*.command.args', '*.*.command.args',
])];

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
