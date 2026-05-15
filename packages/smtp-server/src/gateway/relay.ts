/**
 * SMTP Gateway Mode — Phase 10
 *
 * When GATEWAY_MODE is enabled, CoreMail acts as a relay/gateway
 * in front of an existing mail server (e.g. Exchange, Postfix, Dovecot).
 *
 * Flow:
 *   Incoming SMTP → CoreMail security pipeline (spam/virus filter) → Upstream MTA
 *
 * Configuration (ENV or DB via GatewaySettings):
 *   GATEWAY_MODE=true                    — enable gateway mode
 *   GATEWAY_UPSTREAM_HOST=smtp.corp.com  — upstream MTA hostname
 *   GATEWAY_UPSTREAM_PORT=25             — upstream SMTP port
 *   GATEWAY_UPSTREAM_TLS=false           — use STARTTLS to upstream
 *   GATEWAY_UPSTREAM_USER=relay_user     — optional SMTP AUTH user
 *   GATEWAY_UPSTREAM_PASS=relay_pass     — optional SMTP AUTH password
 *   GATEWAY_FILTER=true                  — run spam/virus filter before relay (default true)
 *   GATEWAY_DOMAINS=corp.com,example.com — domains to relay (empty = all)
 */

import nodemailer from 'nodemailer';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';

const log = createLogger('smtp:gateway');

export interface GatewayConfig {
  enabled: boolean;
  upstreamHost: string;
  upstreamPort: number;
  upstreamTls: boolean;
  upstreamUsername?: string;
  upstreamPassword?: string;
  relayDomains: string[];   // empty = all accepted domains
  filterBeforeRelay: boolean;
}

let cachedConfig: GatewayConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000; // refresh config every 60 seconds

/**
 * Get gateway configuration — prefers DB (GatewaySettings), falls back to ENV.
 */
export async function getGatewayConfig(): Promise<GatewayConfig> {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiry) return cachedConfig;

  // Try DB first
  const dbConfig = await prisma.gatewaySettings.findUnique({ where: { id: 'singleton' } }).catch(() => null);

  if (dbConfig) {
    cachedConfig = {
      enabled: dbConfig.enabled,
      upstreamHost: dbConfig.upstreamHost,
      upstreamPort: dbConfig.upstreamPort,
      upstreamTls: dbConfig.upstreamTls,
      ...(dbConfig.upstreamUsername ? { upstreamUsername: dbConfig.upstreamUsername } : {}),
      ...(dbConfig.upstreamPassword ? { upstreamPassword: dbConfig.upstreamPassword } : {}),
      relayDomains: dbConfig.relayDomains,
      filterBeforeRelay: dbConfig.filterBeforeRelay,
    };
  } else {
    // Fall back to ENV
    cachedConfig = {
      enabled: process.env['GATEWAY_MODE'] === 'true',
      upstreamHost: process.env['GATEWAY_UPSTREAM_HOST'] ?? '',
      upstreamPort: parseInt(process.env['GATEWAY_UPSTREAM_PORT'] ?? '25', 10),
      upstreamTls: process.env['GATEWAY_UPSTREAM_TLS'] === 'true',
      ...(process.env['GATEWAY_UPSTREAM_USER'] ? { upstreamUsername: process.env['GATEWAY_UPSTREAM_USER'] } : {}),
      ...(process.env['GATEWAY_UPSTREAM_PASS'] ? { upstreamPassword: process.env['GATEWAY_UPSTREAM_PASS'] } : {}),
      relayDomains: process.env['GATEWAY_DOMAINS']
        ? process.env['GATEWAY_DOMAINS'].split(',').map((d) => d.trim())
        : [],
      filterBeforeRelay: process.env['GATEWAY_FILTER'] !== 'false',
    };
  }

  cacheExpiry = now + CACHE_TTL_MS;
  return cachedConfig;
}

/**
 * Check if gateway mode is active and should handle this recipient.
 */
export async function shouldRelayToGateway(recipientEmail: string): Promise<boolean> {
  const config = await getGatewayConfig();
  if (!config.enabled || !config.upstreamHost) return false;
  if (config.relayDomains.length === 0) return true;

  const domain = recipientEmail.split('@')[1]?.toLowerCase() ?? '';
  return config.relayDomains.some((d) => d.toLowerCase() === domain);
}

/**
 * Relay a raw message to the upstream MTA.
 * Called instead of (or in addition to) local delivery.
 */
export async function relayToUpstream(
  rawMessage: Buffer,
  from: string,
  to: string[],
): Promise<void> {
  const config = await getGatewayConfig();

  if (!config.upstreamHost) {
    throw new Error('Gateway mode: no upstream host configured');
  }

  const transport = nodemailer.createTransport({
    host: config.upstreamHost,
    port: config.upstreamPort,
    secure: config.upstreamPort === 465,
    ...(config.upstreamTls && config.upstreamPort !== 465 ? { requireTLS: true } : {}),
    tls: { rejectUnauthorized: false },
    ...(config.upstreamUsername && config.upstreamPassword
      ? {
          auth: {
            user: config.upstreamUsername,
            pass: config.upstreamPassword,
          },
        }
      : {}),
  });

  await transport.sendMail({
    envelope: { from, to },
    raw: rawMessage,
  });

  log.info(
    { upstream: `${config.upstreamHost}:${config.upstreamPort}`, from, to },
    'Message relayed to upstream MTA',
  );
}
