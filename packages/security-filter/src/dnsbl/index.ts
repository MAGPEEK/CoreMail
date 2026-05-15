import { createLogger } from '@coremail/core';
import { promises as dns } from 'dns';

const log = createLogger('security-filter:dnsbl');

// Default DNSBL zones — configurable via DB, these are the defaults
export const DEFAULT_DNSBL_ZONES = [
  'zen.spamhaus.org',
  'bl.spamcop.net',
];

export interface DnsblResult {
  listed: boolean;
  zones: string[];
}

function reverseIp(ip: string): string {
  // IPv4 only for now — IPv6 support can be added later
  return ip.split('.').reverse().join('.');
}

async function checkZone(reversedIp: string, zone: string): Promise<boolean> {
  try {
    await dns.resolve4(`${reversedIp}.${zone}`);
    return true;
  } catch {
    return false;
  }
}

export async function checkDnsbl(
  ip: string,
  zones: string[] = DEFAULT_DNSBL_ZONES,
): Promise<DnsblResult> {
  // Skip private/loopback IPs
  if (isPrivateIp(ip)) {
    return { listed: false, zones: [] };
  }

  const reversed = reverseIp(ip);

  // Query all zones in parallel with 2s timeout each
  const results = await Promise.allSettled(
    zones.map(async (zone) => {
      const listed = await Promise.race([
        checkZone(reversed, zone),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      return { zone, listed };
    }),
  );

  const hitZones: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.listed) {
      hitZones.push(result.value.zone);
      log.warn({ ip, zone: result.value.zone }, 'DNSBL hit');
    }
  }

  return { listed: hitZones.length > 0, zones: hitZones };
}

function isPrivateIp(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
