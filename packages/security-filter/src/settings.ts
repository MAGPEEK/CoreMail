/**
 * BCP settings → PipelineConfig mapping (pure) for the security filter.
 *
 * Sources:
 *  - SecuritySettings (BCP → Protection): DNSBL switch, GeoIP country filter,
 *    attachment filter, ClamAV switch/action/failure policy, rspamd switch +
 *    thresholds.
 *  - SmtpSettings (BCP → SMTP → Greylisting): greylisting switch. Wait time,
 *    TTL and whitelist are read by greylisting/index.ts from the same row.
 *    SmtpSettings is the single source of truth for greylisting; the
 *    Protection page writes through to it (api-gateway admin/security.ts).
 *
 * Defaults equal the Prisma schema defaults, so an empty table and a missing
 * row behave the same.
 */
import type { PipelineConfig } from './pipeline/index.js';
import { DEFAULT_BLOCKED_EXTENSIONS } from './attachment/index.js';

export type ClamavAction = 'quarantine' | 'reject' | 'pass';

/** Subset of the SecuritySettings row that the filter uses. */
export interface SecuritySettingsRow {
  dnsblEnabled: boolean;
  geoipMode: string;
  geoipCountries: unknown;
  attachmentEnabled: boolean;
  attachmentMaxSizeMb: number;
  attachmentBlockedExt: unknown;
  rspamdEnabled: boolean;
  rspamdSpamScore: number;
  rspamdRejectScore: number;
  clamavEnabled: boolean;
  clamavAction: string;
  clamavBlockOnFailure: boolean;
}

export interface SmtpGreylistRow {
  greylistingEnabled: boolean;
}

/** Schema defaults (packages/storage/prisma/schema.prisma). */
export const DEFAULT_PIPELINE_CONFIG: Readonly<Required<Pick<PipelineConfig,
  'greylistingEnabled' | 'dnsblEnabled' | 'rspamdEnabled' | 'clamavEnabled' | 'spamScoreJunk' | 'spamScoreReject'
  | 'clamavAction' | 'clamavBlockOnFailure' | 'attachmentEnabled' | 'maxAttachmentBytes' | 'blockedExtensions'>>
  & { countryFilter: null }> = {
  greylistingEnabled:   true,
  dnsblEnabled:         true,
  rspamdEnabled:        true,
  clamavEnabled:        true,
  spamScoreJunk:        6.0,
  spamScoreReject:      15.0,
  clamavAction:         'quarantine',
  clamavBlockOnFailure: false,
  attachmentEnabled:    true,
  maxAttachmentBytes:   50 * 1024 * 1024,
  blockedExtensions:    DEFAULT_BLOCKED_EXTENSIONS,
  countryFilter:        null,
};

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function normalizeClamavAction(v: unknown): ClamavAction {
  return v === 'reject' || v === 'pass' || v === 'quarantine' ? v : 'quarantine';
}

/** Pure mapping of the two settings rows (either may be missing) to the pipeline config. */
export function buildPipelineConfig(
  sec: SecuritySettingsRow | null,
  smtp: SmtpGreylistRow | null,
): PipelineConfig {
  const d = DEFAULT_PIPELINE_CONFIG;
  const cfg: PipelineConfig = { ...d, blockedExtensions: [...d.blockedExtensions] };
  if (smtp) cfg.greylistingEnabled = smtp.greylistingEnabled;
  if (!sec) return cfg;

  const mode = sec.geoipMode.toUpperCase();
  const countries = [...new Set(stringArray(sec.geoipCountries).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  const countryFilter = (mode === 'WHITELIST' || mode === 'BLACKLIST') && countries.length > 0
    ? { mode: mode === 'WHITELIST' ? 'whitelist' as const : 'blacklist' as const, countries }
    : null;

  return {
    ...cfg,
    dnsblEnabled:         sec.dnsblEnabled,
    countryFilter,
    attachmentEnabled:    sec.attachmentEnabled,
    maxAttachmentBytes:   Math.max(1, sec.attachmentMaxSizeMb) * 1024 * 1024,
    blockedExtensions:    stringArray(sec.attachmentBlockedExt),
    rspamdEnabled:        sec.rspamdEnabled,
    spamScoreJunk:        sec.rspamdSpamScore,
    spamScoreReject:      sec.rspamdRejectScore,
    clamavEnabled:        sec.clamavEnabled,
    clamavAction:         normalizeClamavAction(sec.clamavAction),
    clamavBlockOnFailure: sec.clamavBlockOnFailure,
  };
}
