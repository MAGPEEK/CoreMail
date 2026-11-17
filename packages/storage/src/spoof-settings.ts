/**
 * Local-domain anti-spoofing settings (9.4): BCP → Protection → Spoofing
 * (SecuritySettings.localSpoofAction / localSpoofAllow / arcTrustedSealers).
 *
 * The 9.0 environment variables stay: a variable that is set (non-empty) overrides its
 * column — deployments that configured LOCAL_SPOOF_* keep their behaviour, and the BCP
 * shows the field as set by the environment. Used by the security filter (enforcement)
 * and the api-gateway (BCP display + validation).
 */
import { isIP } from 'node:net';

export type LocalSpoofAction = 'policy' | 'junk' | 'reject';
export const LOCAL_SPOOF_ACTIONS: readonly LocalSpoofAction[] = ['policy', 'junk', 'reject'];

export type SpoofSettingField = 'localSpoofAction' | 'localSpoofAllow' | 'arcTrustedSealers';

/** The environment variable that overrides each column. */
export const SPOOF_ENV_VARS: Readonly<Record<SpoofSettingField, string>> = {
  localSpoofAction: 'LOCAL_SPOOF_ACTION',
  localSpoofAllow: 'LOCAL_SPOOF_ALLOW',
  arcTrustedSealers: 'ARC_TRUSTED_SEALERS',
};

export interface SpoofSettings {
  action: LocalSpoofAction;
  /** IPs / CIDRs / domains, lower-case, without trailing dot. */
  allow: string[];
  arcTrustedSealers: string[];
}

export interface ResolvedSpoofSettings extends SpoofSettings {
  /** Fields whose environment variable is set (and therefore wins over the BCP value). */
  envOverrides: SpoofSettingField[];
  /** Unknown action values (environment or column) that fell back to `policy`. */
  invalidAction: string | null;
}

/** The SecuritySettings columns (all optional: rows/fakes without them keep the defaults). */
export interface SpoofSettingsRow {
  localSpoofAction?: string | null;
  localSpoofAllow?: unknown;
  arcTrustedSealers?: unknown;
}

export type SpoofAllowEntry =
  | { kind: 'ip'; addr: string; prefix: number; family: 'ipv4' | 'ipv6' }
  | { kind: 'domain'; domain: string };

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Pure: an allow-list entry as IP / CIDR or domain; null when it is neither. */
export function parseSpoofAllowEntry(raw: string): SpoofAllowEntry | null {
  const entry = raw.trim().toLowerCase().replace(/\.$/, '');
  const slash = entry.indexOf('/');
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(addr);
  if (family !== 0) {
    const max = family === 4 ? 32 : 128;
    const prefixText = slash === -1 ? String(max) : entry.slice(slash + 1);
    const prefix = Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText) || prefix > max) return null;
    return { kind: 'ip', addr, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
  }
  return DOMAIN_RE.test(entry) ? { kind: 'domain', domain: entry } : null;
}

/** Pure: is the value a syntactically valid domain name, not an IP literal (ARC sealer entries)? */
export function isSpoofDomain(raw: string): boolean {
  const v = raw.trim().toLowerCase().replace(/\.$/, '');
  return isIP(v) === 0 && DOMAIN_RE.test(v);
}

/** Pure: comma/whitespace separated text → normalised list entries. */
export function splitSpoofList(text: string): string[] {
  return text.split(/[\s,]+/).map((e) => e.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
}

/** Pure: a JSON column value → normalised list entries (non-strings dropped). */
export function normalizeSpoofList(value: unknown): string[] {
  return Array.isArray(value) ? splitSpoofList(value.filter((v): v is string => typeof v === 'string').join(',')) : [];
}

const envValue = (env: Record<string, string | undefined>, name: string): string | null => {
  const v = (env[name] ?? '').trim();
  return v === '' ? null : v;
};

/** Pure: effective settings — environment variable (when set) > column > default. */
export function resolveSpoofSettings(
  row: SpoofSettingsRow | null,
  env: Record<string, string | undefined> = process.env,
): ResolvedSpoofSettings {
  const envOverrides: SpoofSettingField[] = [];
  const pick = (field: SpoofSettingField): string | null => {
    const v = envValue(env, SPOOF_ENV_VARS[field]);
    if (v !== null) envOverrides.push(field);
    return v;
  };

  const actionText = (pick('localSpoofAction') ?? row?.localSpoofAction ?? 'policy').trim().toLowerCase();
  const valid = (LOCAL_SPOOF_ACTIONS as readonly string[]).includes(actionText);
  const allowEnv = pick('localSpoofAllow');
  const sealersEnv = pick('arcTrustedSealers');
  return {
    action: valid ? actionText as LocalSpoofAction : 'policy',
    allow: allowEnv !== null ? splitSpoofList(allowEnv) : normalizeSpoofList(row?.localSpoofAllow),
    arcTrustedSealers: sealersEnv !== null ? splitSpoofList(sealersEnv) : normalizeSpoofList(row?.arcTrustedSealers),
    envOverrides,
    invalidAction: valid ? null : actionText,
  };
}
