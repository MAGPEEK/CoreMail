/**
 * Admin MCP interface (10.3) — the switch and the IP allowlist
 * (ServerSettings.mcpEnabled / mcpAllowedIps) with a short cache.
 *
 * Every /mcp request reads the cached settings; a change (routes/admin/mcp.ts)
 * drops the cache in this process and publishes CHANNEL_SETTINGS_RELOAD
 * `{type:'mcp'}` so every other gateway instance drops it too. Whenever the
 * switch is found off, all open MCP sessions of the instance end
 * (sessions.ts endAllSessions) — the endpoint answers 404 from then on.
 */
import { CHANNEL_SETTINGS_RELOAD, createLogger, getRedisClient } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { endAllSessions } from './sessions.js';
import { parseOriginList } from './net.js';

const log = createLogger('mcp:settings');

export interface McpSettings {
  enabled: boolean;
  allowedIps: string[];
  /** Lower-case public host name (Origin check, endpoint URL). */
  publicHostname: string;
  useHttps: boolean;
  httpPort: number;
}

/** Fallback lifetime of the cache (lost reload messages). */
const CACHE_TTL_MS = 10_000;
let cache: { value: McpSettings; expires: number } | null = null;

export function invalidateMcpSettings(): void {
  cache = null;
}

/** The current settings (cached). Throws on database errors — callers fail closed. */
export async function getMcpSettings(): Promise<McpSettings> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;
  const row = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { mcpEnabled: true, mcpAllowedIps: true, publicHostname: true, useHttps: true, httpPort: true },
  });
  const value: McpSettings = {
    enabled: row?.mcpEnabled === true,
    allowedIps: Array.isArray(row?.mcpAllowedIps) ? row.mcpAllowedIps.filter((s): s is string => typeof s === 'string') : [],
    publicHostname: (row?.publicHostname ?? '').trim().toLowerCase(),
    useHttps: row?.useHttps === true,
    httpPort: typeof row?.httpPort === 'number' ? row.httpPort : 443,
  };
  cache = { value, expires: now + CACHE_TTL_MS };
  if (!value.enabled) endAllSessions('disabled');
  return value;
}

/** Host names an Origin header may name: the public host name + MCP_ALLOWED_ORIGINS. */
export function allowedOrigins(): string[] {
  return parseOriginList(process.env['MCP_ALLOWED_ORIGINS']);
}

/** The endpoint URL shown in the BCP (from the public host name, like the other derived URLs). */
export function endpointUrl(s: Pick<McpSettings, 'publicHostname' | 'useHttps' | 'httpPort'>): string {
  const host = s.publicHostname || 'localhost';
  // The integrated HTTPS proxy (443) serves /mcp as well; a configured HTTP port
  // other than 80/443 is kept (reverse proxy / Synology setups).
  const proto = s.useHttps ? 'https' : 'http';
  const port = (s.useHttps && s.httpPort === 443) || (!s.useHttps && s.httpPort === 80) ? '' : `:${s.httpPort}`;
  return `${proto}://${host}${port}/mcp`;
}

/** True for a CHANNEL_SETTINGS_RELOAD payload that concerns the MCP settings. */
export function isMcpReload(message: string): boolean {
  try {
    return (JSON.parse(message) as { type?: unknown })?.type === 'mcp';
  } catch {
    return false;
  }
}

/**
 * Applies a settings change in this process right away (drop the cache, re-read;
 * the switch found off ends every session) and tells the other instances.
 */
export async function mcpSettingsChanged(): Promise<void> {
  invalidateMcpSettings();
  await getMcpSettings().catch((err: unknown) => log.warn({ err }, 'Re-reading the MCP settings failed'));
  const seam = (globalThis as { __mcpSettingsPublish?: (channel: string, message: string) => void }).__mcpSettingsPublish;
  if (seam) { seam(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'mcp' })); return; }
  try {
    await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'mcp' }));
  } catch (err) {
    log.warn({ err }, 'Could not publish the MCP settings reload — other instances use their 10 s cache');
  }
}

/** Handles a reload message (other instance changed the settings). */
export function handleMcpReload(message: string): void {
  if (!isMcpReload(message)) return;
  invalidateMcpSettings();
  void getMcpSettings().catch((err: unknown) => log.warn({ err }, 'Re-reading the MCP settings failed'));
}

let subscribed = false;

/** Subscribes to CHANNEL_SETTINGS_RELOAD (idempotent). Call once at startup. */
export function startMcpSettingsSubscriber(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    const sub = getRedisClient().duplicate();
    sub.on('error', (err) => log.warn({ err }, 'MCP settings subscriber error'));
    sub.on('message', (_channel: string, message: string) => handleMcpReload(message));
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD).catch((err: unknown) => log.warn({ err }, 'MCP settings subscribe failed'));
  } catch (err) {
    log.warn({ err }, 'MCP settings subscriber not started — the 10 s cache TTL applies');
  }
}
