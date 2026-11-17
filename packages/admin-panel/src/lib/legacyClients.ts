/**
 * BCP: settings for old mail clients (pure helpers).
 *  - Dienste: "Ältere Clients erlauben (TLS 1.0/1.1)" per listener and for HTTPS
 *  - SMTP-Konfiguration → Geräte-Relay: lists entered one per line
 */

export const LEGACY_TLS_LABEL = 'Ältere Clients erlauben (TLS 1.0/1.1)';

export const LEGACY_TLS_WARNING =
  'Unsicher: TLS 1.0 und 1.1 gelten als veraltet. Nur aktivieren, wenn ältere Mailprogramme oder Geräte '
  + 'kein TLS 1.2 beherrschen — und so bald wie möglich wieder ausschalten. Unsichere Verfahren '
  + '(RC4, 3DES, NULL, EXPORT) bleiben auch dann gesperrt.';

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
