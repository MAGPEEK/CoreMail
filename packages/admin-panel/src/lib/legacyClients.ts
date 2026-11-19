/**
 * BCP: settings for old mail clients (pure helpers).
 *  - Dienste: "Zusätzlich veraltete TLS-Versionen 1.0/1.1 zulassen (optional)" per listener and for HTTPS
 *  - SMTP-Konfiguration → Geräte-Relay: lists entered one per line
 */

/**
 * 9.5.1: worded as an optional extra on top of TLS 1.2/1.3 — the old label
 * ("Ältere Clients erlauben") was read as the switch that turns HTTPS on.
 */
export const LEGACY_TLS_LABEL = 'Zusätzlich veraltete TLS-Versionen 1.0/1.1 zulassen (optional)';

/** Shown under the switch while it is off. */
export const LEGACY_TLS_HINT = 'Nur für sehr alte Geräte nötig. Moderne Clients und Outlook brauchen das nicht.';

export const LEGACY_TLS_WARNING =
  'Optionaler Kompatibilitätsmodus aktiv: TLS 1.0 und 1.1 gelten als unsicher und veraltet. Nur eingeschaltet lassen, '
  + 'wenn ältere Mailprogramme oder Geräte kein TLS 1.2 beherrschen — und so bald wie möglich wieder ausschalten. '
  + 'Unsichere Verfahren (RC4, 3DES, NULL, EXPORT) bleiben auch dann gesperrt.';

/** Status line of the HTTPS card: whether HTTPS runs, with which TLS versions, and that nothing else must be switched on. */
export function httpsStatusText(active: boolean, allowLegacyTls: boolean): string {
  if (!active) return 'HTTPS ist nicht aktiv — Zertifikat unter SSL/TLS zuweisen.';
  const versions = allowLegacyTls ? 'TLS 1.2 und 1.3 (zusätzlich 1.0/1.1)' : 'TLS 1.2 und 1.3';
  return `HTTPS ist aktiv mit ${versions} — für Webmail, ActiveSync, MAPI usw. ist kein weiterer Schalter nötig.`;
}

export interface ListenerForm {
  address: string;
  port: string;
  ssl: boolean;
  active: boolean;
  allowLegacyTls: boolean;
}

/** Request body for POST/PUT /admin/services/listeners. */
export function listenerPayload(form: ListenerForm): {
  address: string; port: number; ssl: boolean; active: boolean; allowLegacyTls: boolean;
} {
  return {
    address: form.address.trim(),
    port: Number(form.port),
    ssl: form.ssl,
    active: form.active,
    allowLegacyTls: form.allowLegacyTls,
  };
}

/** Splits a textarea (one entry per line, commas and spaces also separate) into entries. */
export function parseEntryList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))];
}

/** One entry per line for a textarea. */
export function formatEntryList(entries: readonly string[]): string {
  return entries.join('\n');
}

export interface DeviceRelayForm {
  enabled: boolean;
  networks: string;
  senderDomains: string;
  port: string;
  maxMessagesPerMinute: string;
}

export interface DeviceRelayPayload {
  enabled: boolean;
  allowedNetworks: string[];
  senderDomains: string[];
  port: number;
  maxMessagesPerMinute: number;
}

/** Request body for PUT /admin/smtp-config/device-relay, or a German error. */
export function deviceRelayPayload(form: DeviceRelayForm): { ok: true; value: DeviceRelayPayload } | { ok: false; error: string } {
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Bitte einen gültigen Port (1–65535) eingeben' };
  const rate = Number(form.maxMessagesPerMinute);
  if (!Number.isInteger(rate) || rate < 1 || rate > 1000) return { ok: false, error: 'Nachrichten pro Minute: 1–1000' };
  const allowedNetworks = parseEntryList(form.networks);
  const senderDomains = parseEntryList(form.senderDomains).map((d) => d.toLowerCase());
  if (form.enabled && (allowedNetworks.length === 0 || senderDomains.length === 0)) {
    return { ok: false, error: 'Zum Aktivieren mindestens ein Netz und eine Absender-Domain angeben' };
  }
  return { ok: true, value: { enabled: form.enabled, allowedNetworks, senderDomains, port, maxMessagesPerMinute: rate } };
}
