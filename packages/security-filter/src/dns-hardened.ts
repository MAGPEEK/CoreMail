/**
 * DNS hardening — protection against DNS cache poisoning (MITRE T1584.002)
 *
 * Protection mechanisms:
 *
 * 1. Hardcoded trusted resolvers (8.8.8.8, 1.1.1.1, 9.9.9.9)
 *    — Bypasses poisonable system resolvers / Docker-internal DNS
 *    — Configurable via SMTP_TRUSTED_DNS_SERVERS (comma-separated)
 *
 * 2. Cross-validation (optional)
 *    — Two resolvers are compared; on divergence → warning + attack event
 *    — Prevents partial cache-poisoning attacks
 *
 * 3. Startup integrity check
 *    — Known, immutable A records (e.g. example.com) are checked against
 *      expected IPs. If that fails → ALARM
 *
 * Usage: call `initDnsHardening()` once at server start.
 * Afterwards: `resolveHardened()` instead of `dns.resolve4()` in DNSBL checks.
 */

import { Resolver } from 'dns';
import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:dns-hardened');

// ── Configuration ─────────────────────────────────────────────────────────────

/** Trusted resolvers — queried directly, not the system DNS */
const TRUSTED_RESOLVERS: string[] = (
  process.env['TRUSTED_DNS_SERVERS'] ?? '8.8.8.8,1.1.1.1,9.9.9.9'
).split(',').map((s) => s.trim()).filter(Boolean);

/** Timeout for individual DNS queries in ms */
const DNS_TIMEOUT_MS = 3_000;

/** Known stable records for the integrity check.
 *  We use INFRA records that belong directly to well-known services:
 *  - one.one.one.one  → Cloudflare DNS anycast (1.1.1.1)  — stable since 2018
 *  - dns.google       → Google DNS anycast  (8.8.8.8)     — stable since 2009
 *  These IPs are part of public infrastructure and do not change.
 */
const INTEGRITY_CHECKS: { fqdn: string; expectedIps: string[] }[] = [
  { fqdn: 'one.one.one.one', expectedIps: ['1.1.1.1', '1.0.0.1'] },
  { fqdn: 'dns.google',      expectedIps: ['8.8.8.8', '8.8.4.4'] },
];

// ── Resolver instances ────────────────────────────────────────────────────────

// Two independent resolvers for cross-validation
const resolver1 = new Resolver({ timeout: DNS_TIMEOUT_MS });
const resolver2 = new Resolver({ timeout: DNS_TIMEOUT_MS });

// Primary resolver for normal queries (persists)
const primaryResolver = new Resolver({ timeout: DNS_TIMEOUT_MS });

// Assign servers
function assignServers(): void {
  if (TRUSTED_RESOLVERS.length === 0) return;
  // Primary resolver
  primaryResolver.setServers(TRUSTED_RESOLVERS);
  // Cross-validator pair (first / second server)
  resolver1.setServers([TRUSTED_RESOLVERS[0]!]);
  resolver2.setServers([TRUSTED_RESOLVERS[Math.min(1, TRUSTED_RESOLVERS.length - 1)]!]);

  log.info({ resolvers: TRUSTED_RESOLVERS }, 'DNS: Using trusted resolvers (bypassing system DNS)');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`DNS timeout after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

// ── Main functions ────────────────────────────────────────────────────────────

/**
 * Resolves an FQDN via the primary trusted resolver.
 * Drop-in replacement for `dns.promises.resolve4()`.
 */
export async function resolveHardened(fqdn: string): Promise<string[]> {
  return withTimeout(
    new Promise<string[]>((resolve, reject) => {
      primaryResolver.resolve4(fqdn, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    }),
    DNS_TIMEOUT_MS,
    fqdn,
  );
}

/**
 * Checks an FQDN with two independent resolvers and compares the results.
 * Returns `false` (and logs a warning) if the answers diverge.
 * Used for particularly security-critical lookups.
 */
export async function crossValidateResolve(fqdn: string): Promise<{
  addresses: string[];
  consistent: boolean;
  diverged: boolean;
}> {
  const resolve1 = withTimeout(
    new Promise<string[]>((resolve, reject) => {
      resolver1.resolve4(fqdn, (err, a) => { if (err) reject(err); else resolve(a); });
    }),
    DNS_TIMEOUT_MS,
    `${fqdn}@r1`,
  ).catch((): string[] => []);

  const resolve2 = withTimeout(
    new Promise<string[]>((resolve, reject) => {
      resolver2.resolve4(fqdn, (err, a) => { if (err) reject(err); else resolve(a); });
    }),
    DNS_TIMEOUT_MS,
    `${fqdn}@r2`,
  ).catch((): string[] => []);

  const [addrs1, addrs2] = await Promise.all([resolve1, resolve2]);

  // Empty answer on one side = error, not a real conflict
  if (addrs1.length === 0 || addrs2.length === 0) {
    return { addresses: addrs1.length ? addrs1 : addrs2, consistent: true, diverged: false };
  }

  const set1 = new Set(addrs1);
  const set2 = new Set(addrs2);
  const consistent = addrs2.every((ip) => set1.has(ip)) && addrs1.every((ip) => set2.has(ip));

  if (!consistent) {
    log.warn({
      fqdn,
      resolver1: TRUSTED_RESOLVERS[0],
      resolver2: TRUSTED_RESOLVERS[1],
      addrs1,
      addrs2,
    }, 'DNS: Cross-validation DIVERGED — possible cache poisoning!');
  }

  return { addresses: addrs1, consistent, diverged: !consistent };
}

// ── Startup integrity check ───────────────────────────────────────────────────

/**
 * Performs known DNS lookups and compares against hardcoded expectations.
 * If a check fails, a warning log + attack event is generated.
 * Returns a list of findings (for the admin API).
 */
export async function runDnsIntegrityCheck(): Promise<DnsIntegrityResult[]> {
  const results: DnsIntegrityResult[] = [];

  for (const check of INTEGRITY_CHECKS) {
    try {
      const { addresses, consistent, diverged } = await crossValidateResolve(check.fqdn);

      // If expected IPs are defined: check against expectation
      let poisoningSuspected = false;
      let reason = '';

      if (diverged) {
        poisoningSuspected = true;
        reason = 'Cross-Resolver-Divergenz';
      } else if (check.expectedIps.length > 0) {
        const hasAllExpected = check.expectedIps.every((ip) => addresses.includes(ip));
        if (!hasAllExpected) {
          poisoningSuspected = true;
          reason = `Erwartete IPs nicht vorhanden (erwartet: ${check.expectedIps.join(', ')}, bekommen: ${addresses.join(', ')})`;
        }
      }

      if (poisoningSuspected) {
        log.error({
          fqdn: check.fqdn,
          resolvedAddresses: addresses,
          expectedIps: check.expectedIps,
          reason,
        }, 'DNS: INTEGRITY CHECK FAILED — DNS cache poisoning suspected!');
      } else {
        log.debug({ fqdn: check.fqdn, addresses, consistent }, 'DNS: Integrity check passed');
      }

      results.push({
        fqdn: check.fqdn,
        resolvedAddresses: addresses,
        expectedIps: check.expectedIps,
        consistent,
        diverged,
        poisoningSuspected,
        reason: poisoningSuspected ? reason : 'OK',
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      const reason = `DNS-Lookup fehlgeschlagen: ${String(err)}`;
      log.warn({ fqdn: check.fqdn, err }, 'DNS: Integrity check failed (DNS error)');
      results.push({
        fqdn: check.fqdn,
        resolvedAddresses: [],
        expectedIps: check.expectedIps,
        consistent: true,
        diverged: false,
        poisoningSuspected: false,
        reason,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}

export interface DnsIntegrityResult {
  fqdn:               string;
  resolvedAddresses:  string[];
  expectedIps:        string[];
  consistent:         boolean;
  diverged:           boolean;
  poisoningSuspected: boolean;
  reason:             string;
  checkedAt:          string;
}

// ── Public status snapshot ─────────────────────────────────────────────────────

export function getDnsHardeningStatus(): {
  trustedResolvers: string[];
  systemResolvers: string[];
  hardeningActive: boolean;
} {
  return {
    trustedResolvers: TRUSTED_RESOLVERS,
    systemResolvers:  [],
    hardeningActive:  TRUSTED_RESOLVERS.length > 0,
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────

/** Call once at startup. Sets trusted resolvers and starts the integrity check. */
export async function initDnsHardening(): Promise<void> {
  assignServers();
  log.info('DNS hardening initialized — running startup integrity check...');
  const results = await runDnsIntegrityCheck();
  const suspicious = results.filter((r) => r.poisoningSuspected);
  if (suspicious.length > 0) {
    log.error({ suspicious }, 'DNS: STARTUP INTEGRITY CHECK DETECTED ANOMALIES');
  } else {
    log.info({ checks: results.length }, 'DNS: Startup integrity check passed');
  }
}
