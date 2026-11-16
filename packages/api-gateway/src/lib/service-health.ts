/**
 * BCP → Server → "Health & Status" (9.1.x review): real reachability checks
 * instead of a hard-coded "Online" list.
 *
 *  - internal HTTP services: TCP connect to the host:port of their *_URL env
 *    (same defaults as server.ts),
 *  - SMTP / IMAP / POP3: TCP connect to every ACTIVE listener port from
 *    ServiceListener (the protocol servers bind 0.0.0.0, probed on loopback),
 *  - PostgreSQL (`SELECT 1`), Redis (`PING`) and the object storage
 *    (last startup/periodic check of the gateway, see /healthz).
 *
 * Every probe is bounded by a timeout; the probe functions are injectable so
 * the aggregation is unit-tested without sockets.
 */
import { Socket } from 'node:net';

export type HealthState = 'up' | 'down' | 'unknown';

export interface ServiceHealth {
  name: string;
  /** e.g. "3003" or "25/465/587" */
  ports: string;
  description: string;
  status: HealthState;
  detail?: string;
}

export interface DependencyHealth {
  name: string;
  status: HealthState;
  detail?: string;
}

export interface HealthReport {
  checkedAt: string;
  services: ServiceHealth[];
  dependencies: DependencyHealth[];
}

export interface HttpServiceDef { name: string; description: string; url: string }

/** Internal HTTP services of the app container (defaults = server.ts). */
export function httpServiceDefs(env: NodeJS.ProcessEnv = process.env): HttpServiceDef[] {
  return [
    { name: 'auth-service',    description: 'Authentication + MFA',     url: env['AUTH_SERVICE_URL'] ?? 'http://localhost:3003' },
    { name: 'security-filter', description: 'Spam/virus filter, SPF/DKIM/DMARC', url: env['SECURITY_FILTER_URL'] ?? 'http://localhost:3002' },
    { name: 'backup-service',  description: 'Backups + retention',      url: env['BACKUP_SERVICE_URL'] ?? 'http://localhost:3004' },
    { name: 'activesync',      description: 'ActiveSync (mobile)',      url: env['EAS_SERVICE_URL'] ?? 'http://localhost:3005' },
    { name: 'jmap-server',     description: 'JMAP',                     url: env['JMAP_SERVICE_URL'] ?? 'http://localhost:3006' },
    { name: 'autodiscover',    description: 'Autodiscover v1 + v2',     url: env['AUTODISCOVER_SERVICE_URL'] ?? 'http://localhost:8081' },
    { name: 'caldav-server',   description: 'CalDAV + CardDAV',         url: env['CALDAV_SERVICE_URL'] ?? 'http://localhost:8082' },
  ];
}

/** host + port of an http(s) URL (default ports 80/443); null when unparsable. */
export function hostPort(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    return null;
  }
}

/** Resolves true when a TCP connection to host:port opens within `timeoutMs`. */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

export interface HealthDeps {
  /** Active listener ports per protocol service (from ServiceListener). */
  listenerPorts: () => Promise<Record<'SMTP_RECEIVE' | 'IMAP' | 'POP3', Array<{ port: number; address: string }>>>;
  probe: (host: string, port: number) => Promise<boolean>;
  db: () => Promise<void>;
  redis: () => Promise<void>;
  /** null = no storage check result yet */
  storage: () => { driver: string; status: string; blocking: boolean } | null;
  env?: NodeJS.ProcessEnv;
  /** Host the protocol listeners are probed on (default 127.0.0.1). */
  protocolHost?: string;
}

const PROTOCOLS: Array<{ key: 'SMTP_RECEIVE' | 'IMAP' | 'POP3'; name: string; description: string }> = [
  { key: 'SMTP_RECEIVE', name: 'smtp-server', description: 'SMTP inbound + submission' },
  { key: 'IMAP',         name: 'imap-server', description: 'IMAP' },
  { key: 'POP3',         name: 'pop3-server', description: 'POP3' },
];

/** Wildcard / empty bind address → probe host; a concrete address is probed directly. */
export function probeHost(address: string | undefined, fallback: string): string {
  const a = (address ?? '').trim();
  return !a || a === '0.0.0.0' || a === '::' ? fallback : a;
}

async function settle(fn: () => Promise<void>): Promise<DependencyHealth['status'] | Error> {
  try { await fn(); return 'up'; } catch (err) { return err instanceof Error ? err : new Error(String(err)); }
}

export async function collectHealth(deps: HealthDeps): Promise<HealthReport> {
  const protoHost = deps.protocolHost ?? '127.0.0.1';
  const ports = await deps.listenerPorts().catch(() => null);

  const protocolChecks = PROTOCOLS.map(async (p): Promise<ServiceHealth> => {
    const raw = ports ? ports[p.key] : null;
    const list = raw ? [...new Set(raw.map((l) => l.port))].sort((a, b) => a - b) : null;
    if (!list) return { name: p.name, ports: '—', description: p.description, status: 'unknown', detail: 'listener configuration unavailable' };
    if (list.length === 0) return { name: p.name, ports: '—', description: p.description, status: 'unknown', detail: 'no active listener' };
    const results = await Promise.all(list.map((port) => deps.probe(probeHost(raw!.find((l) => l.port === port)?.address, protoHost), port)));
    const down = list.filter((_, i) => !results[i]);
    return {
      name: p.name, ports: list.join('/'), description: p.description,
      status: down.length === 0 ? 'up' : 'down',
      ...(down.length ? { detail: `not reachable: ${down.join(', ')}` } : {}),
    };
  });

  const httpChecks = httpServiceDefs(deps.env).map(async (s): Promise<ServiceHealth> => {
    const hp = hostPort(s.url);
    if (!hp) return { name: s.name, ports: '—', description: s.description, status: 'unknown', detail: 'invalid service URL' };
    const ok = await deps.probe(hp.host, hp.port);
    return { name: s.name, ports: String(hp.port), description: s.description, status: ok ? 'up' : 'down' };
  });

  const [db, redis] = await Promise.all([settle(deps.db), settle(deps.redis)]);
  const st = deps.storage();
  const dependencies: DependencyHealth[] = [
    db === 'up' ? { name: 'PostgreSQL', status: 'up' } : { name: 'PostgreSQL', status: 'down', detail: 'query failed' },
    redis === 'up' ? { name: 'Redis', status: 'up' } : { name: 'Redis', status: 'down', detail: 'ping failed' },
    st
      ? { name: 'Object storage', status: st.blocking ? 'down' : st.status === 'pending' ? 'unknown' : 'up', detail: `${st.driver}: ${st.status}` }
      : { name: 'Object storage', status: 'unknown', detail: 'not checked yet' },
  ];

  return {
    checkedAt: new Date().toISOString(),
    services: [
      { name: 'api-gateway', ports: '3000', description: 'REST API + web frontends', status: 'up' },
      ...(await Promise.all([...protocolChecks, ...httpChecks])),
    ],
    dependencies,
  };
}
