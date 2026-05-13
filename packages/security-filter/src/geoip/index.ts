import * as maxmind from '@maxmind/geoip2-node';
import { createLogger } from '@coremail/core';
import { existsSync } from 'fs';

const log = createLogger('security-filter:geoip');

const DB_PATH = process.env['GEOIP_DB_PATH'] ?? '/usr/share/GeoIP/GeoLite2-Country.mmdb';

let _reader: maxmind.ReaderModel | null = null;

async function getReader(): Promise<maxmind.ReaderModel | null> {
  if (_reader) return _reader;
  if (!existsSync(DB_PATH)) {
    log.warn({ path: DB_PATH }, 'GeoIP database not found — country filtering disabled');
    return null;
  }
  _reader = await maxmind.Reader.open(DB_PATH);
  log.info({ path: DB_PATH }, 'GeoIP database loaded');
  return _reader;
}

export interface CountryConfig {
  mode: 'whitelist' | 'blacklist';
  countries: string[]; // ISO 3166-1 alpha-2
}

export interface GeoipResult {
  allowed: boolean;
  countryCode?: string;
  reason?: string;
}

export async function checkCountry(
  ip: string,
  config: CountryConfig | null,
): Promise<GeoipResult> {
  if (!config || config.countries.length === 0) {
    return { allowed: true };
  }

  const reader = await getReader();
  if (!reader) {
    return { allowed: true }; // fail open if no DB
  }

  let countryCode: string | undefined;
  try {
    const response = reader.country(ip);
    countryCode = response.country?.isoCode ?? undefined;
  } catch {
    // IP not in database (private/loopback) — allow
    return { allowed: true };
  }

  if (!countryCode) {
    return { allowed: true };
  }

  const inList = config.countries.includes(countryCode);

  if (config.mode === 'whitelist') {
    const allowed = inList;
    if (!allowed) {
      log.info({ ip, countryCode }, 'GeoIP: country not in whitelist, blocking');
    }
    return {
      allowed,
      countryCode,
      ...(allowed ? {} : { reason: `Country ${countryCode} is not allowed` }),
    };
  } else {
    const allowed = !inList;
    if (!allowed) {
      log.info({ ip, countryCode }, 'GeoIP: country in blacklist, blocking');
    }
    return {
      allowed,
      countryCode,
      ...(allowed ? {} : { reason: `Country ${countryCode} is blocked` }),
    };
  }
}
