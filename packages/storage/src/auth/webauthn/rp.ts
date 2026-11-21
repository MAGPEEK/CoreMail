/**
 * 10.6: the WebAuthn Relying Party (docs/passkeys.md).
 *
 * RP ID: WEBAUTHN_RP_ID, else the frozen ServerSettings.passkeyRpId (set at the
 * first passkey registration), else the public host name. Freezing keeps the
 * passkeys usable when the host name changes later (the BCP warns about it).
 *
 * Allowed origins come only from configuration — never from the Host header:
 * WEBAUTHN_ORIGIN (comma-separated) or the public base URL (COREMAIL_PUBLIC_URL,
 * else scheme + public host name + the external port, so 8443 setups work —
 * G6), plus ServerSettings.passkeyRelatedOrigins (Related Origin Requests,
 * §5.11, announced in /.well-known/webauthn). Cached 60 s; dropped by the
 * passkey policy reload.
 */
import { isIP } from 'node:net';
import { prisma } from '../../prisma/index.js';
import { onPasskeyPolicyInvalidation } from '../passkey-policy.js';

export interface RpConfig {
  rpID: string;
  rpName: string;
  /** Every origin a response may come from (primary first). */
  origins: string[];
  primaryOrigin: string;
  /** passkeyRpId is set (or WEBAUTHN_RP_ID pins it). */
  frozen: boolean;
  source: 'env' | 'frozen' | 'host';
  /** The RP ID the current host name would give (differs from rpID after a host name change). */
  hostRpId: string;
  relatedOrigins: string[];
}

let cache: { value: RpConfig; expires: number } | null = null;

export function invalidateRpConfigCache(): void {
  cache = null;
}
onPasskeyPolicyInvalidation(invalidateRpConfigCache);

function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Public base URL from settings (same rule as the api-gateway's publicBaseUrl()). */
export function baseUrlOf(s: { publicHostname?: string | null; useHttps?: boolean | null; httpPort?: number | null }): string {
  const env = process.env['COREMAIL_PUBLIC_URL']?.trim();
  if (env) return env.replace(/\/+$/, '');
  const host = (s.publicHostname || 'localhost').trim().toLowerCase();
  const https = s.useHttps !== false;
  const port = typeof s.httpPort === 'number' ? s.httpPort : 443;
  const standard = (https && port === 443) || (!https && port === 80);
  return `${https ? 'https' : 'http'}://${host}${standard ? '' : `:${port}`}`;
}

export async function getRpConfig(): Promise<RpConfig> {
  if (cache && cache.expires > Date.now()) return cache.value;
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true, useHttps: true, httpPort: true, passkeyRpId: true, passkeyRelatedOrigins: true },
  });
  const hostRpId = (s?.publicHostname || 'localhost').trim().toLowerCase();
  const envId = process.env['WEBAUTHN_RP_ID']?.trim().toLowerCase();
  const frozen = typeof s?.passkeyRpId === 'string' && s.passkeyRpId ? s.passkeyRpId.toLowerCase() : null;
  const rpID = envId || frozen || hostRpId;
  const envOrigins = (process.env['WEBAUTHN_ORIGIN'] ?? '').split(',').map(normalizeOrigin).filter((o): o is string => !!o);
  const base = normalizeOrigin(baseUrlOf(s ?? {})) ?? `https://${hostRpId}`;
  const related = (Array.isArray(s?.passkeyRelatedOrigins) ? s.passkeyRelatedOrigins : [])
    .map((o) => normalizeOrigin(String(o))).filter((o): o is string => !!o);
  const primary = envOrigins[0] ?? base;
  const origins = [...new Set([primary, ...envOrigins, ...related])];
  const value: RpConfig = {
    rpID,
    rpName: process.env['WEBAUTHN_RP_NAME']?.trim() || 'CoreMail',
    origins,
    primaryOrigin: primary,
    frozen: !!envId || !!frozen,
    source: envId ? 'env' : frozen ? 'frozen' : 'host',
    hostRpId,
    relatedOrigins: related,
  };
  cache = { value, expires: Date.now() + 60_000 };
  return value;
}

/** Freezes the RP ID at the first passkey registration (no-op once set). */
export async function freezeRpId(rpID: string): Promise<void> {
  const r = await prisma.serverSettings.updateMany({ where: { id: 'singleton', passkeyRpId: null }, data: { passkeyRpId: rpID } });
  if (r.count > 0) invalidateRpConfigCache();
}

/** host is rpID or a sub-domain of it (§5.1.4 — the RP ID must be a registrable suffix of the origin's host). */
export function hostMatchesRpId(host: string, rpID: string): boolean {
  const h = host.toLowerCase();
  const r = rpID.toLowerCase();
  return h === r || h.endsWith(`.${r}`);
}

export interface PasskeyReadiness {
  https: boolean;
  dnsName: boolean;
  rpMatchesHost: boolean;
  ready: boolean;
  problems: Array<'not_https' | 'ip_address' | 'rp_id_mismatch'>;
}

/**
 * Can browsers use passkeys with this configuration? WebAuthn needs a secure
 * context (HTTPS; plain HTTP only on localhost) and a DNS name as RP ID (an IP
 * address cannot be one), and the RP ID must cover the origin's host.
 */
export function passkeyReadiness(rp: Pick<RpConfig, 'rpID' | 'primaryOrigin'>): PasskeyReadiness {
  const problems: PasskeyReadiness['problems'] = [];
  let host = '';
  let https = false;
  try {
    const u = new URL(rp.primaryOrigin);
    host = u.hostname.replace(/^\[|\]$/g, '');
    https = u.protocol === 'https:' || host === 'localhost';
  } catch { /* invalid → not https */ }
  if (!https) problems.push('not_https');
  const dnsName = isIP(rp.rpID) === 0 && isIP(host) === 0 && rp.rpID.length > 0;
  if (!dnsName) problems.push('ip_address');
  const rpMatchesHost = !!host && hostMatchesRpId(host, rp.rpID);
  if (!rpMatchesHost) problems.push('rp_id_mismatch');
  return { https, dnsName, rpMatchesHost, ready: problems.length === 0, problems };
}
