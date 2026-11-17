/**
 * BCP → Protection → Overview: "active protections" matrix (pure).
 * Before, the rows for greylisting, DNSBL and the attachment filter were
 * hard-coded as active (and named two fixed DNSBL zones) whatever the settings
 * said; rspamd/ClamAV ignored their on/off switches.
 */

export interface ProtectionSettingsLike {
  greylistEnabled: boolean;
  greylistWaitSec: number;
  dnsblEnabled: boolean;
  geoipMode: 'DISABLED' | 'WHITELIST' | 'BLACKLIST';
  geoipCountries: string[];
  attachmentEnabled: boolean;
  attachmentBlockedExt: string[];
  rspamdEnabled: boolean;
  clamavEnabled: boolean;
}

export interface FeatureRow { label: string; ok: boolean; note: string }

export function protectionFeatureMatrix(
  s: ProtectionSettingsLike,
  online: { rspamd: boolean | undefined; clamav: boolean | undefined },
  activeDnsblZones: readonly string[] | undefined,
  /** 9.3: scanners not deployed in this installation — their rows are left out. */
  absent: { rspamd?: boolean; clamav?: boolean } = {},
): FeatureRow[] {
  const off = 'In den Einstellungen deaktiviert';
  const scanner = (enabled: boolean, up: boolean | undefined, onNote: string): Pick<FeatureRow, 'ok' | 'note'> =>
    !enabled ? { ok: false, note: off }
      : up === undefined ? { ok: false, note: 'Status wird geladen …' }
      : up ? { ok: true, note: onNote }
      : { ok: false, note: 'Container nicht erreichbar' };
  const zones = activeDnsblZones ?? [];
  const waitMin = Math.max(1, Math.round(s.greylistWaitSec / 60));
  const countries = s.geoipCountries.length;
  const rows: FeatureRow[] = [
    { label: 'SPF-Prüfung',       ok: true, note: 'Sender Policy Framework' },
    { label: 'DKIM-Validierung',  ok: true, note: 'DomainKeys Identified Mail' },
    { label: 'DMARC-Auswertung',  ok: true, note: 'Domain-based Message Authentication' },
    { label: 'ARC-Validierung',   ok: true, note: 'Authenticated Received Chain' },
    { label: 'Anti-Spam (Rspamd)', ...scanner(s.rspamdEnabled, online.rspamd, 'Aktiv') },
    { label: 'Antivirus (ClamAV)', ...scanner(s.clamavEnabled, online.clamav, 'Aktiv') },
    { label: 'Greylisting', ok: s.greylistEnabled, note: s.greylistEnabled ? `${waitMin} min Wartezeit für Erstverbindungen` : off },
    {
      label: 'DNSBL',
      ok: s.dnsblEnabled && zones.length > 0,
      note: !s.dnsblEnabled ? off : zones.length === 0 ? 'Keine aktive Zone' : zones.join(', '),
    },
    {
      label: 'Länderfilter',
      ok: s.geoipMode !== 'DISABLED' && countries > 0,
      note: s.geoipMode === 'DISABLED' ? off
        : countries === 0 ? 'Keine Länder ausgewählt — ohne Wirkung'
        : `${s.geoipMode === 'WHITELIST' ? 'Nur' : 'Blockiert:'} ${countries} ${countries === 1 ? 'Land' : 'Länder'}`,
    },
    {
      label: 'Anhang-Filter',
      ok: s.attachmentEnabled,
      note: s.attachmentEnabled ? `${s.attachmentBlockedExt.length} blockierte Dateiendungen` : off,
    },
  ];
  return rows.filter((r) => !(absent.rspamd && r.label === 'Anti-Spam (Rspamd)') && !(absent.clamav && r.label === 'Antivirus (ClamAV)'));
}
