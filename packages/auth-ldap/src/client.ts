/**
 * LDAP connection layer: config → ldapts client with TLS settings. Tests swap
 * the client via `setLdapClientFactory()` (fake directory, no network).
 */
import type { ConnectionOptions } from 'node:tls';
import { Client } from 'ldapts';

export type LdapAttrValue = string | string[] | Buffer | Buffer[];
export interface LdapEntry {
  dn: string;
  [attr: string]: LdapAttrValue;
}

export interface LdapSearchOptions {
  scope: 'base' | 'one' | 'sub';
  filter: string;
  attributes: string[];
  sizeLimit?: number;
  paged?: boolean | { pageSize: number };
  explicitBufferAttributes?: string[];
}

/** The subset of the ldapts Client used by CoreMail. */
export interface LdapClientLike {
  startTLS(options: ConnectionOptions): Promise<void>;
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: LdapSearchOptions): Promise<{ searchEntries: LdapEntry[] }>;
  unbind(): Promise<void>;
}

export interface LdapAttributeMap {
  email?: string;
  displayName?: string;
  uid?: string;
}

/** Normalized LdapConfig row. */
export interface LdapSettings {
  domainId: string;
  host: string;
  port: number;
  ssl: boolean;
  startTls: boolean;
  tlsVerify: boolean;
  tlsCaCert: string | null;
  baseDN: string;
  userDN: string;
  bindDN: string;
  bindPassword: string;
  userFilter: string;
  groupFilter: string | null;
  attributeMap: LdapAttributeMap;
  enabled: boolean;
  syncEnabled: boolean;
  allowLocalTakeover: boolean;
  syncIntervalMinutes: number;
}

export interface LdapConfigRow {
  domainId: string;
  host: string;
  port: number;
  ssl: boolean;
  baseDN: string;
  bindDN: string;
  bindPassword: string;
  userFilter: string;
  userDN: string;
  groupFilter?: string | null;
  attributeMap?: unknown;
  syncEnabled: boolean;
  enabled?: boolean;
  startTls?: boolean;
  tlsVerify?: boolean;
  tlsCaCert?: string | null;
  allowLocalTakeover?: boolean;
  syncIntervalMinutes?: number;
}

export function toLdapSettings(row: LdapConfigRow): LdapSettings {
  const map = (row.attributeMap && typeof row.attributeMap === 'object' ? row.attributeMap : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const attributeMap: LdapAttributeMap = {};
  const e = str(map['email']) ?? str(map['mail']); if (e) attributeMap.email = e; // 'mail' = pre-v6.1 BCP key
  const d = str(map['displayName']); if (d) attributeMap.displayName = d;
  const u = str(map['uid']); if (u) attributeMap.uid = u;
  return {
    domainId: row.domainId,
    host: row.host,
    port: row.port,
    ssl: row.ssl,
    startTls: row.startTls ?? false,
    tlsVerify: row.tlsVerify ?? true,
    tlsCaCert: row.tlsCaCert ?? null,
    baseDN: row.baseDN,
    userDN: row.userDN || row.baseDN,
    bindDN: row.bindDN,
    bindPassword: row.bindPassword,
    userFilter: row.userFilter || '(sAMAccountName={{username}})',
    groupFilter: row.groupFilter ?? null,
    attributeMap,
    enabled: row.enabled ?? true,
    syncEnabled: row.syncEnabled,
    allowLocalTakeover: row.allowLocalTakeover ?? false,
    syncIntervalMinutes: row.syncIntervalMinutes ?? 1440,
  };
}

export const mailAttr = (s: LdapSettings) => s.attributeMap.email ?? 'mail';
export const nameAttr = (s: LdapSettings) => s.attributeMap.displayName ?? 'displayName';
export const uidAttr = (s: LdapSettings) => s.attributeMap.uid ?? 'objectGUID';

export function tlsOptions(s: LdapSettings): ConnectionOptions {
  const o: ConnectionOptions = { rejectUnauthorized: s.tlsVerify, servername: s.host };
  if (s.tlsCaCert) o.ca = [s.tlsCaCert];
  return o;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * Passwords must not cross the network in clear text: ldaps or StartTLS is
 * required, except for a loopback directory or LDAP_ALLOW_INSECURE=true.
 */
export function transportSecurityError(s: LdapSettings): string | null {
  if (s.ssl || s.startTls) return null;
  if (isLoopback(s.host) || process.env['LDAP_ALLOW_INSECURE'] === 'true') return null;
  return 'LDAP without TLS is refused — enable LDAPS or StartTLS (or set LDAP_ALLOW_INSECURE=true for a trusted network)';
}

export type LdapClientFactory = (s: LdapSettings) => LdapClientLike;

const defaultFactory: LdapClientFactory = (s) => {
  const opts: ConstructorParameters<typeof Client>[0] = {
    url: `${s.ssl ? 'ldaps' : 'ldap'}://${s.host}:${s.port}`,
    timeout: 10_000,
    connectTimeout: 5_000,
  };
  if (s.ssl) opts.tlsOptions = tlsOptions(s);
  return new Client(opts) as unknown as LdapClientLike;
};

let factory: LdapClientFactory = defaultFactory;

/** Test hook: replace the ldapts client (pass null to restore). */
export function setLdapClientFactory(f: LdapClientFactory | null): void {
  factory = f ?? defaultFactory;
}

/** Opens a client and applies StartTLS when configured (ldap:// only). */
export async function openClient(s: LdapSettings): Promise<LdapClientLike> {
  const insecure = transportSecurityError(s);
  if (insecure) throw new Error(insecure);
  const c = factory(s);
  if (!s.ssl && s.startTls) await c.startTLS(tlsOptions(s));
  return c;
}

/** Opens a client and binds with the configured service account. */
export async function serviceBind(s: LdapSettings): Promise<LdapClientLike> {
  const c = await openClient(s);
  try {
    await c.bind(s.bindDN, s.bindPassword);
  } catch (err) {
    await c.unbind().catch(() => undefined);
    throw err;
  }
  return c;
}

// ── Attribute helpers ─────────────────────────────────────────────────────────

export function attrValues(v: LdapAttrValue | undefined): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)));
}

export function attrFirst(v: LdapAttrValue | undefined): string | undefined {
  return attrValues(v)[0];
}

/** Stable directory id (objectGUID is binary in AD → hex). */
export function attrId(v: LdapAttrValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  const first = Array.isArray(v) ? v[0] : v;
  if (first === undefined) return undefined;
  const s = Buffer.isBuffer(first) ? first.toString('hex') : String(first);
  return s ? s : undefined;
}

export function isSizeLimitError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  const code = (err as { code?: number } | null)?.code;
  return name === 'SizeLimitExceededError' || code === 4;
}
