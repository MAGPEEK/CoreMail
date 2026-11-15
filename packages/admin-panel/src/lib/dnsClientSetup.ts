/**
 * Recommended client auto-setup DNS records (v8.1) shown in the domain DNS panel.
 * They come from GET /admin/domains/:id/dns-check → `clientSetup` and are kept apart
 * from the required records (`records`, counted via VISIBLE_DNS_KEYS): a missing
 * recommended record is yellow ("recommended"), never red, and does not change the
 * required-records status. No imports — unit-tested with `node --test`.
 */

export interface ClientSetupRec {
  type: string; name: string; expected: string; ok: boolean; found: string | null;
  warning?: string; recommended?: boolean;
}

/** Display order; the label key is `domain_dns_rec_<labelKey>`. */
export const CLIENT_SETUP_KEYS = [
  ['submissions',     'submissions'],
  ['submission',      'submission'],
  ['imaps',           'imaps'],
  ['imap',            'imap'],
  ['pop3s',           'pop3s'],
  ['autodiscoverSrv', 'autodiscover_srv'],
  ['autoconfig',      'autoconfig'],
  ['caldavs',         'caldavs'],
  ['caldavsPath',     'caldavs_path'],
  ['carddavs',        'carddavs'],
  ['carddavsPath',    'carddavs_path'],
] as const;

export type ClientSetupKey = typeof CLIENT_SETUP_KEYS[number][0];
export type ClientSetupLabelKey = `domain_dns_rec_${typeof CLIENT_SETUP_KEYS[number][1]}`;

/** ok → green, anything else → amber (recommended records are never "error"). */
export type RecStatus = 'ok' | 'warning' | 'recommended';

export function clientSetupStatus(r: Pick<ClientSetupRec, 'ok' | 'warning'>): RecStatus {
  if (r.ok) return 'ok';
  return r.warning ? 'warning' : 'recommended';
}

/** Rows in display order (records the server did not send are skipped). */
export function clientSetupRows(
  clientSetup: Partial<Record<string, ClientSetupRec>> | undefined,
): { key: ClientSetupKey; labelKey: ClientSetupLabelKey; record: ClientSetupRec; status: RecStatus }[] {
  if (!clientSetup) return [];
  const rows: { key: ClientSetupKey; labelKey: ClientSetupLabelKey; record: ClientSetupRec; status: RecStatus }[] = [];
  for (const [key, label] of CLIENT_SETUP_KEYS) {
    const record = clientSetup[key];
    if (record) rows.push({ key, labelKey: `domain_dns_rec_${label}` as ClientSetupLabelKey, record, status: clientSetupStatus(record) });
  }
  return rows;
}

/** "x / y" summary of the recommended records. */
export function clientSetupSummary(rows: { status: RecStatus }[]): { ok: number; total: number } {
  return { ok: rows.filter((r) => r.status === 'ok').length, total: rows.length };
}
