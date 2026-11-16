/**
 * Per-service runtime log levels (BCP → System logs). Mirror of the service
 * names + aliases each service passes to initRuntimeLogLevel() and of the key
 * matching in @coremail/core resolveServiceLogLevel(): exact name, then an
 * alias, then the wildcard keys "*" / "all". Pure, unit-tested.
 */
export const LOG_LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export const LOG_LEVEL_SERVICES: ReadonlyArray<{ key: string; aliases: readonly string[] }> = [
  { key: 'api-gateway',     aliases: ['api'] },
  { key: 'auth-service',    aliases: ['auth'] },
  { key: 'smtp-server',     aliases: ['smtp'] },
  { key: 'imap-server',     aliases: ['imap'] },
  { key: 'pop3-server',     aliases: ['pop3'] },
  { key: 'jmap-server',     aliases: ['jmap'] },
  { key: 'activesync',      aliases: ['eas'] },
  { key: 'caldav-server',   aliases: ['caldav', 'carddav', 'dav'] },
  { key: 'autodiscover',    aliases: [] },
  { key: 'security-filter', aliases: [] },
  { key: 'backup-service',  aliases: ['backup'] },
];

function asLevel(v: unknown): LogLevel | null {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (LOG_LEVELS as readonly string[]).includes(s) ? s as LogLevel : null;
}

/** The level a service runs with from the stored map, or null (= env LOG_LEVEL). */
export function effectiveLogLevel(levels: Record<string, unknown>, service: string, aliases: readonly string[] = []): LogLevel | null {
  const lower = new Map(Object.entries(levels).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const key of [service, ...aliases, '*', 'all']) {
    const lvl = asLevel(lower.get(key.toLowerCase()));
    if (lvl) return lvl;
  }
  return null;
}
