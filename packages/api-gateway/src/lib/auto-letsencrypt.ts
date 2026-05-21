/**
 * Automatische Let's Encrypt-Anforderung beim Container-Start.
 *
 * Bedingungen (alle müssen erfüllt sein, sonst wird übersprungen):
 *  - ServerSettings.publicHostname ist gesetzt UND sieht wie ein echter Hostname aus
 *    (enthält einen Punkt — also kein "mail.local"/"localhost")
 *  - Es existiert noch kein aktives, von einer CA signiertes Zertifikat
 *    (LETSENCRYPT oder UPLOADED/CUSTOM) das den publicHostname abdeckt
 *  - settings.adminEmail ODER ein Fallback (admin@{registrierte Domain}) ist verfügbar
 *
 * Läuft asynchron — wirft niemals. Loggt das Ergebnis klar erkennbar.
 * Wird einmal pro Container-Start aufgerufen, nach 30 s Verzögerung
 * (Port-80-Binding stabil, andere Services hochgefahren).
 *
 * Hinweise:
 *  - Port 80 muss von außen erreichbar sein (HTTP-01 Challenge)
 *  - Bei Erfolg publiziert runAcmeIssuance() bereits CHANNEL_SETTINGS_RELOAD,
 *    sodass SMTP/IMAP/POP3 das neue Cert sofort übernehmen (kein Restart nötig)
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { runAcmeIssuance } from '../routes/admin/certificates.js';

const log = createLogger('api:auto-le');

// Services die das Zertifikat automatisch erhalten — deckt Protokoll-TLS
// (SMTP/IMAP/POP3) und den integrierten HTTPS-Reverse-Proxy ab.
const AUTO_LE_SERVICES = ['SMTP', 'IMAP', 'POP3', 'HTTPS'];

// CA-signierte Cert-Typen — Prisma-Enum CertType. SELF_SIGNED gehört NICHT dazu,
// denn ein selbstsigniertes Cert ist genau der Grund auto-LE zu starten.
const CA_SIGNED_TYPES = ['LETSENCRYPT', 'CUSTOM'] as const;

function looksLikeRealHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const h = hostname.trim().toLowerCase();
  if (!h.includes('.')) return false;
  // Bekannte Defaults / lokale Hostnames ausfiltern
  if (h === 'mail.local' || h === 'localhost' || h === 'localhost.localdomain') return false;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return false;
  return true;
}

export async function tryAutoLetsEncrypt(): Promise<void> {
  try {
    // 1) ServerSettings laden
    const settings = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { publicHostname: true, adminEmail: true },
    });

    const hostname = settings?.publicHostname?.trim() ?? '';
    if (!looksLikeRealHostname(hostname)) {
      log.info({ hostname }, 'AUTO-LE: skipped, no public hostname configured');
      return;
    }

    // 2) Existierende aktive CA-signierte Zertifikate prüfen
    const activeCerts = await prisma.certificate.findMany({
      where:  {
        status: { in: ['ACTIVE', 'EXPIRING'] },
        type:   { in: [...CA_SIGNED_TYPES] },
      },
      select: { id: true, domains: true, services: true },
    });

    const covered = activeCerts.find(c => c.domains.includes(hostname));
    if (covered) {
      log.info(
        { hostname, certId: covered.id },
        'AUTO-LE: skipped, valid CA-signed cert already exists',
      );
      return;
    }

    // 3) E-Mail bestimmen (adminEmail bevorzugt, sonst Fallback admin@<registered-domain>)
    const fromSettings = settings?.adminEmail?.trim() ?? '';
    const fallbackDomain = hostname.split('.').slice(-2).join('.');
    const email = fromSettings.length > 0
      ? fromSettings
      : `admin@${fallbackDomain}`;

    if (!email.includes('@') || email.endsWith('@')) {
      log.warn({ hostname, email }, 'AUTO-LE: skipped, no valid admin email available');
      return;
    }

    // 4) PENDING Certificate-Row anlegen (gleiche Form wie POST /letsencrypt)
    log.info({ hostname, email }, 'AUTO-LE: starting issuance for ' + hostname);

    const cert = await prisma.certificate.create({
      data: {
        name:      `Auto-LE ${hostname}`,
        domains:   [hostname],
        services:  AUTO_LE_SERVICES,
        type:      'LETSENCRYPT',
        status:    'PENDING',
        acmeEmail: email,
        autoRenew: true,
      },
      select: { id: true },
    });

    // 5) ACME-Prozess starten (Produktion, kein Staging)
    try {
      await runAcmeIssuance(cert.id, [hostname], email, true, false);

      // Erfolg loggen — neue expiresAt aus DB lesen
      const issued = await prisma.certificate.findUnique({
        where:  { id: cert.id },
        select: { expiresAt: true, status: true },
      });
      log.info(
        { certId: cert.id, expiresAt: issued?.expiresAt, status: issued?.status },
        `AUTO-LE: success — cert ACTIVE, expires ${issued?.expiresAt?.toISOString() ?? 'unknown'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { certId: cert.id, err: msg },
        `AUTO-LE: failed — ${msg}. Manual issuance via BCP → SSL/TLS still possible.`,
      );
    }
  } catch (err) {
    // Auch unerwartete Fehler nur loggen, niemals werfen
    log.warn({ err }, 'AUTO-LE: unexpected error during bootstrap — skipping');
  }
}
