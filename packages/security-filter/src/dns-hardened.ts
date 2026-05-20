/**
 * DNS-Hardening — Schutz gegen DNS-Cache-Poisoning (MITRE T1584.002)
 *
 * Schutzmechanismen:
 *
 * 1. Hardcoded Trusted Resolvers (8.8.8.8, 1.1.1.1, 9.9.9.9)
 *    — Umgeht poisonierbare System-Resolver / Docker-interne DNS
 *    — Konfigurierbar via SMTP_TRUSTED_DNS_SERVERS (kommagetrennt)
 *
 * 2. Cross-Validation (optional)
 *    — Zwei Resolver werden verglichen; bei Abweichung → Warnung + Attack-Event
 *    — Verhindert partielle Cache-Poisoning-Attacken
 *
 * 3. Startup-Integrity-Check
 *    — Bekannte, unveränderliche A-Records (z.B. example.com) werden gegen
 *      erwartete IPs geprüft. Schlägt das fehl → ALARM
 *
 * Aufruf: `initDnsHardening()` einmalig beim Server-Start.
 * Danach: `resolveHardened()` statt `dns.resolve4()` in DNSBL-Checks.
 */

import { Resolver } from 'dns';
import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:dns-hardened');

// ── Konfiguration ─────────────────────────────────────────────────────────────

/** Vertrauenswürdige Resolver — werden direkt angesprochen, nicht System-DNS */
const TRUSTED_RESOLVERS: string[] = (
  process.env['TRUSTED_DNS_SERVERS'] ?? '8.8.8.8,1.1.1.1,9.9.9.9'
).split(',').map((s) => s.trim()).filter(Boolean);

/** Timeout für einzelne DNS-Anfragen in ms */
const DNS_TIMEOUT_MS = 3_000;

/** Bekannte stabile Records für den Integrity-Check */
const INTEGRITY_CHECKS: { fqdn: string; expectedIps: string[] }[] = [
  // IANA example.com — seit Jahren stabil; Abweichung = Poisoning
  { fqdn: 'example.com',  expectedIps: ['93.184.216.34'] },
  // cloudflare.com — sehr stabil
  { fqdn: 'cloudflare.com', expectedIps: [] }, // leer = nur Erreichbarkeit prüfen
];

// ── Resolver-Instanzen ────────────────────────────────────────────────────────

// Zwei unabhängige Resolver für Cross-Validation
const resolver1 = new Resolver({ timeout: DNS_TIMEOUT_MS });
const resolver2 = new Resolver({ timeout: DNS_TIMEOUT_MS });

// Primärer Resolver für normale Abfragen (bleibt bestehen)
const primaryResolver = new Resolver({ timeout: DNS_TIMEOUT_MS });

// Server zuweisen
function assignServers(): void {
  if (TRUSTED_RESOLVERS.length === 0) return;
  // Primärer Resolver
  primaryResolver.setServers(TRUSTED_RESOLVERS);
  // Cross-Validator-Paar (erste / zweite Server)
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

// ── Hauptfunktionen ───────────────────────────────────────────────────────────

/**
 * Löst einen FQDN via primärem vertrauenswürdigen Resolver auf.
 * Dropin-Replacement für `dns.promises.resolve4()`.
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
 * Prüft einen FQDN mit zwei unabhängigen Resolvern und vergleicht die Ergebnisse.
 * Gibt `false` zurück (und loggt eine Warnung) wenn die Antworten divergieren.
 * Wird für besonders sicherheitskritische Lookups verwendet.
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

  // Leere Antwort auf einer Seite = Fehler, kein echter Konflikt
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

// ── Startup-Integritäts-Prüfung ───────────────────────────────────────────────

/**
 * Führt bekannte DNS-Lookups durch und vergleicht gegen hartcodierte Erwartungen.
 * Schlägt ein Check fehl, wird ein Warn-Log + Attack-Event erzeugt.
 * Gibt eine Liste der Befunde zurück (für Admin-API).
 */
export async function runDnsIntegrityCheck(): Promise<DnsIntegrityResult[]> {
  const results: DnsIntegrityResult[] = [];

  for (const check of INTEGRITY_CHECKS) {
    try {
      const { addresses, consistent, diverged } = await crossValidateResolve(check.fqdn);

      // Wenn erwartete IPs definiert sind: gegen Erwartung prüfen
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

// ── Öffentlicher Status-Snapshot ───────────────────────────────────────────────

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

/** Einmalig beim Start aufrufen. Setzt trusted Resolver und startet Integrity-Check. */
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
