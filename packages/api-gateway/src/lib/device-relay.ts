/**
 * Device relay configuration (BCP → SMTP → Geräte-Relay): validation rules.
 *
 * The SMTP server (smtp-server/src/inbound/device-relay.ts) relays only for
 * clients inside `allowedNetworks`, on listener `port`, for sender domains in
 * `senderDomains`. These rules keep a configuration from turning into an open
 * relay by mistake:
 *  - every network must be a valid IP/CIDR, and not broader than /8 (IPv4) or
 *    /32 (IPv6) — `0.0.0.0/0` would be "the whole internet"; an IPv4-mapped
 *    IPv6 range (`::ffff:0:0/96`) counts as the IPv4 range it denotes
 *    (@coremail/core cidr.ts, RELAY_NETWORK_MIN_PREFIX — the SMTP server
 *    applies the same limit when it loads the policy);
 *  - sender domains must be domains hosted by this server;
 *  - the port must not be a submission port (465/587 require SMTP AUTH).
 */
import { parseCidr, cidrTooBroad, RELAY_NETWORK_MIN_PREFIX } from '@coremail/core';

export const SUBMISSION_PORTS: readonly number[] = [465, 587];
export const MAX_NETWORKS = 64;
export const MAX_SENDER_DOMAINS = 64;

export interface DeviceRelayInput {
  enabled: boolean;
  allowedNetworks: string[];
  senderDomains: string[];
  port: number;
  maxMessagesPerMinute: number;
}

export type DeviceRelayValidation =
  | { ok: true; value: DeviceRelayInput }
  | { ok: false; error: string };

/** Pure: normalises the networks; returns the offending entries. */
export function normaliseNetworks(list: readonly string[]): { networks: string[]; invalid: string[]; tooBroad: string[] } {
  const networks: string[] = [];
  const invalid: string[] = [];
  const tooBroad: string[] = [];
  for (const entry of list.map((e) => e.trim()).filter(Boolean)) {
    const p = parseCidr(entry);
    if (!p) { invalid.push(entry); continue; }
    if (cidrTooBroad(p, RELAY_NETWORK_MIN_PREFIX)) { tooBroad.push(entry); continue; }
    if (!networks.includes(p.cidr)) networks.push(p.cidr);
  }
  return { networks, invalid, tooBroad };
}

/** Pure: lower-cased, de-duplicated sender domains. */
export function normaliseDomains(list: readonly string[]): string[] {
  return [...new Set(list.map((d) => d.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))];
}

/**
 * Pure: validates a configuration against the hosted domains. German error
 * texts (shown in the BCP).
 */
export function validateDeviceRelay(input: DeviceRelayInput, hostedDomains: readonly string[]): DeviceRelayValidation {
  if (input.allowedNetworks.length > MAX_NETWORKS) return { ok: false, error: `Höchstens ${MAX_NETWORKS} Netze` };
  if (input.senderDomains.length > MAX_SENDER_DOMAINS) return { ok: false, error: `Höchstens ${MAX_SENDER_DOMAINS} Absender-Domains` };
  const { networks, invalid, tooBroad } = normaliseNetworks(input.allowedNetworks);
  if (invalid.length > 0) return { ok: false, error: `Ungültige Netze: ${invalid.join(', ')}` };
  if (tooBroad.length > 0) {
    const { v4, v6 } = RELAY_NETWORK_MIN_PREFIX;
    return { ok: false, error: `Netze zu groß (mindestens /${v4} bzw. /${v6}): ${tooBroad.join(', ')}` };
  }
  const domains = normaliseDomains(input.senderDomains);
  const hosted = new Set(hostedDomains.map((d) => d.toLowerCase()));
  const unknown = domains.filter((d) => !hosted.has(d));
  if (unknown.length > 0) return { ok: false, error: `Keine Domain dieses Servers: ${unknown.join(', ')}` };
  if (SUBMISSION_PORTS.includes(input.port)) {
    return { ok: false, error: `Port ${input.port} ist ein Submission-Port (Anmeldung erforderlich) — bitte 25 oder einen eigenen Port wählen` };
  }
  if (input.enabled && (networks.length === 0 || domains.length === 0)) {
    return { ok: false, error: 'Zum Aktivieren mindestens ein Netz und eine Absender-Domain angeben' };
  }
  return { ok: true, value: { ...input, allowedNetworks: networks, senderDomains: domains } };
}
