/**
 * BCP settings → PipelineConfig mapping (pure) for the security filter.
 *
 * Sources:
 *  - SecuritySettings (BCP → Protection): DNSBL switch, GeoIP country filter,
 *    attachment filter, ClamAV switch/action/failure policy, rspamd switch +
 *    thresholds, local-domain anti-spoofing (9.4; LOCAL_SPOOF_* / ARC_TRUSTED_SEALERS
 *    override the columns when set — storage spoof-settings.ts).
 *  - SmtpSettings (BCP → SMTP → Greylisting): greylisting switch. Wait time,
 *    TTL and whitelist are read by greylisting/index.ts from the same row.
 *    SmtpSettings is the single source of truth for greylisting; the
 *    Protection page writes through to it (api-gateway admin/security.ts).
 *
 * Defaults equal the Prisma schema defaults, so an empty table and a missing
 * row behave the same.
 */
import type { PipelineConfig } from './pipeline/index.js';
import { resolveSpoofSettings } from '@coremail/storage';
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
  // 9.2 policy fields — optional so that rows/fakes without them keep the defaults
  clamavTimeoutSec?: number;
  clamavScanLimitMb?: number;
  clamavOversizeAction?: string;
  clamavHeuristicsAsVirus?: boolean;
  clamavPuaAsVirus?: boolean;
  clamavEncryptedAsVirus?: boolean;
  // 9.4 local-spoof columns — optional like the ClamAV policy fields
  localSpoofAction?: string;
  localSpoofAllow?: unknown;
  arcTrustedSealers?: unknown;
}

export interface SmtpGreylistRow {
  greylistingEnabled: boolean;
}

/** Schema defaults (packages/storage/prisma/schema.prisma). */
export const DEFAULT_PIPELINE_CONFIG: Readonly<Required<Pick<PipelineConfig,
  'greylistingEnabled' | 'dnsblEnabled' | 'rspamdEnabled' | 'clamavEnabled' | 'spamScoreJunk' | 'spamScoreReject'
  | 'clamavAction' | 'clamavBlockOnFailure' | 'attachmentEnabled' | 'maxAttachmentBytes' | 'blockedExtensions'
  | 'clamavTimeoutMs' | 'clamavScanLimitBytes' | 'clamavOversizeAction' | 'clamavHeuristicsAsVirus'
  | 'clamavPuaAsVirus' | 'clamavEncryptedAsVirus'>>
  & { countryFilter: null }> = {
  greylistingEnabled:   true,
  dnsblEnabled:         true,
  rspamdEnabled:        true,
  clamavEnabled:        true,
  spamScoreJunk:        6.0,
  spamScoreReject:      15.0,
  clamavAction:         'quarantine',
  clamavBlockOnFailure: false,
  clamavTimeoutMs:      20_000,
  clamavScanLimitBytes: 50 * 1024 * 1024,
  clamavOversizeAction: 'accept',
  clamavHeuristicsAsVirus: true,
  clamavPuaAsVirus:     true,
  clamavEncryptedAsVirus: true,
  attachmentEnabled:    true,
  maxAttachmentBytes:   50 * 1024 * 1024,
  blockedExtensions:    DEFAULT_BLOCKED_EXTENSIONS,
  countryFilter:        null,
};

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Bounds of the BCP fields (api-gateway validates the same ranges). */
export const CLAMAV_TIMEOUT_SEC_RANGE = [5, 25] as const;
export const CLAMAV_SCAN_LIMIT_MB_RANGE = [1, 50] as const;

function clampInt(v: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

export function normalizeClamavAction(v: unknown): ClamavAction {
  return v === 'reject' || v === 'pass' || v === 'quarantine' ? v : 'quarantine';
}

/**
 * Deployment switches that override the database: RSPAMD_ENABLED=false /
 * CLAMAV_ENABLED=false turn a scanner off when its container is not deployed
 * (docker-compose.minimal.yml). Anything else leaves the BCP setting in charge.
 */
/** An environment switch explicitly set to false/0/no/off (case-insensitive). */
export function isEnvOff(v: string | undefined): boolean {
  return v !== undefined && /^(false|0|no|off)$/i.test(v.trim());
}

export function applyScannerEnvOverrides(cfg: PipelineConfig, env: NodeJS.ProcessEnv = process.env): PipelineConfig {
  const off = isEnvOff;
  return {
    ...cfg,
    ...(off(env['RSPAMD_ENABLED']) ? { rspamdEnabled: false } : {}),
    ...(off(env['CLAMAV_ENABLED']) ? { clamavEnabled: false } : {}),
  };
}

/** Pure mapping of the two settings rows (either may be missing) to the pipeline config. */
export function buildPipelineConfig(
  sec: SecuritySettingsRow | null,
  smtp: SmtpGreylistRow | null,
  env: NodeJS.ProcessEnv = process.env,
): PipelineConfig {
  const d = DEFAULT_PIPELINE_CONFIG;
  const cfg: PipelineConfig = { ...d, blockedExtensions: [...d.blockedExtensions] };
  if (smtp) cfg.greylistingEnabled = smtp.greylistingEnabled;
  cfg.localSpoof = resolveSpoofSettings(sec, env);
  if (!sec) return applyScannerEnvOverrides(cfg, env);

  const mode = sec.geoipMode.toUpperCase();
  const countries = [...new Set(stringArray(sec.geoipCountries).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  const countryFilter = (mode === 'WHITELIST' || mode === 'BLACKLIST') && countries.length > 0
    ? { mode: mode === 'WHITELIST' ? 'whitelist' as const : 'blacklist' as const, countries }
    : null;

  return applyScannerEnvOverrides({
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
    clamavTimeoutMs:      clampInt(sec.clamavTimeoutSec, CLAMAV_TIMEOUT_SEC_RANGE, d.clamavTimeoutMs / 1000) * 1000,
    clamavScanLimitBytes: clampInt(sec.clamavScanLimitMb, CLAMAV_SCAN_LIMIT_MB_RANGE, d.clamavScanLimitBytes / 1048576) * 1024 * 1024,
    clamavOversizeAction: sec.clamavOversizeAction === 'reject' ? 'reject' : 'accept',
    clamavHeuristicsAsVirus: sec.clamavHeuristicsAsVirus ?? d.clamavHeuristicsAsVirus,
    clamavPuaAsVirus:     sec.clamavPuaAsVirus ?? d.clamavPuaAsVirus,
    clamavEncryptedAsVirus: sec.clamavEncryptedAsVirus ?? d.clamavEncryptedAsVirus,
  }, env);
}
