/**
 * Recommended client auto-setup DNS records (v8.1) shown in the domain DNS panel.
 * They come from GET /admin/domains/:id/dns-check → `clientSetup` and are kept apart
 * from the required records (`records`, counted via VISIBLE_DNS_KEYS): a missing
 * recommended record is yellow ("recommended"), never red, and does not change the
 * required-records status. Plain-text IMAP 143 / POP3 110 are `optional`: grey when
 * missing and not counted in the summary. No imports — unit-tested with `node --test`.
 */

export interface SrvParts { priority: number; weight: number; port: number; target: string }

export interface ClientSetupRec {
  type: string; name: string; expected: string; ok: boolean; found: string | null;
  warning?: string; recommended?: boolean; optional?: boolean;
  /** SRV only (9.1+): the record split into its fields, target without trailing dot. */
  srv?: SrvParts;
}

/** Display order; the label key is `domain_dns_rec_<labelKey>`. */
export const CLIENT_SETUP_KEYS = [
  ['submissions',     'submissions'],
  ['submission',      'submission'],
  ['imaps',           'imaps'],
  ['imap',            'imap'],
  ['pop3s',           'pop3s'],
  ['pop3',            'pop3'],
  ['autodiscoverSrv', 'autodiscover_srv'],
  ['autoconfig',      'autoconfig'],
  ['caldavs',         'caldavs'],
  ['caldavsPath',     'caldavs_path'],
  ['carddavs',        'carddavs'],
  ['carddavsPath',    'carddavs_path'],
] as const;

export type ClientSetupKey = typeof CLIENT_SETUP_KEYS[number][0];
export type ClientSetupLabelKey = `domain_dns_rec_${typeof CLIENT_SETUP_KEYS[number][1]}`;

/** ok → green, optional + missing → grey, anything else → amber (never "error"). */
export type RecStatus = 'ok' | 'warning' | 'recommended' | 'optional';

export function clientSetupStatus(r: Pick<ClientSetupRec, 'ok' | 'warning' | 'optional'>): RecStatus {
  if (r.ok) return 'ok';
  if (r.warning) return 'warning';
  return r.optional ? 'optional' : 'recommended';
}

export interface ClientSetupRow {
  key: ClientSetupKey; labelKey: ClientSetupLabelKey; record: ClientSetupRec; status: RecStatus; optional: boolean;
}

/** Rows in display order (records the server did not send are skipped). */
export function clientSetupRows(clientSetup: Partial<Record<string, ClientSetupRec>> | undefined): ClientSetupRow[] {
  if (!clientSetup) return [];
  const rows: ClientSetupRow[] = [];
  for (const [key, label] of CLIENT_SETUP_KEYS) {
    const record = clientSetup[key];
    if (record) {
      rows.push({
        key, labelKey: `domain_dns_rec_${label}` as ClientSetupLabelKey, record,
        status: clientSetupStatus(record), optional: record.optional === true,
      });
    }
  }
  return rows;
}

/** "x / y" summary of the recommended records; optional records are not counted. */
export function clientSetupSummary(rows: { status: RecStatus; optional?: boolean }[]): { ok: number; total: number } {
  const counted = rows.filter((r) => !r.optional);
  return { ok: counted.filter((r) => r.status === 'ok').length, total: counted.length };
}

/**
 * The SRV record split into priority / weight / port / target, as DNS providers with
 * separate input fields (e.g. netcup) want it. Uses the server's `srv` fields and falls
 * back to parsing the zone-file form "0 1 993 mail.example.com." (older servers).
 * The target never carries the trailing dot. null for non-SRV or unparsable records.
 */
export function srvParts(r: Pick<ClientSetupRec, 'type' | 'expected' | 'srv'>): SrvParts | null {
  if (r.type !== 'SRV') return null;
  const clean = (t: string): string => t.trim().replace(/\.$/, '');
  if (r.srv) return { ...r.srv, target: clean(r.srv.target) };
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(r.expected);
  if (!m) return null;
  return { priority: Number(m[1]), weight: Number(m[2]), port: Number(m[3]), target: clean(m[4] ?? '') };
}

/**
 * Copyable zone-file line, e.g. `_imaps._tcp.example.com. 3600 IN SRV 0 1 993 mail.example.com.`
 * (`name` is relative to the domain, as the server sends it).
 */
export function srvZoneLine(name: string, domain: string, p: SrvParts, ttl = 3600): string {
  const d = domain.replace(/\.$/, '');
  const owner = name === '@' || name === '' ? `${d}.` : `${name.replace(/\.$/, '')}.${d}.`;
  const target = p.target === '' || p.target === '.' ? '.' : `${p.target}.`;
  return `${owner} ${ttl} IN SRV ${p.priority} ${p.weight} ${p.port} ${target}`;
}
