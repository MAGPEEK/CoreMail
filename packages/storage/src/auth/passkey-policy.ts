/**
 * 10.6: the passkey policy (docs/passkeys.md).
 *
 * Levels: server (ServerSettings.passkeysEnabled, two-state, default OFF) →
 * domain → user (PasskeyPolicy rows, `inherit | on | off`); the most specific
 * non-inherit switch wins. `passkeyPasswordlessEnabled` (server only) decides
 * whether passkeys may be used for the usernameless sign-in at all.
 *
 * What the switch governs: registering passkeys, the usernameless passkey
 * sign-in and recovery links. Credentials that already exist always count as an
 * enrolled factor (auth-factors.ts) and keep working as a second factor after a
 * password and for re-authentication — switching passkeys off never locks an
 * account out of its MFA.
 *
 * Caches: server policy 15 s, per-user decision 15 s; every change publishes
 * CHANNEL_SETTINGS_RELOAD {type:'passkeys'} (startPasskeyPolicySubscriber drops
 * the caches of the other services) and every auth invalidation of a user
 * drops that user's entry.
 *
 * TODO(10.6 auth-policy): unify the domain / user switch with the per-user MFA
 * policy model of the auth-policy branch once it is merged.
 */
import { createLogger, getRedisClient, onAuthInvalidation, peekRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { prisma } from '../prisma/index.js';

const log = createLogger('auth:passkey-policy');

export type PasskeySetting = 'inherit' | 'on' | 'off';
export const PASSKEY_SETTINGS: readonly ['inherit', 'on', 'off'] = ['inherit', 'on', 'off'];

export interface PasskeyServerPolicy {
  enabled: boolean;
  passwordless: boolean;
  /** Frozen RP ID (null = not frozen yet). */
  rpId: string | null;
  relatedOrigins: string[];
}

export const PASSKEY_POLICY_OFF: PasskeyServerPolicy = Object.freeze({
  enabled: false, passwordless: true, rpId: null, relatedOrigins: [],
}) as PasskeyServerPolicy;

/** Reload signal on CHANNEL_SETTINGS_RELOAD. */
export const PASSKEY_POLICY_RELOAD = 'passkeys';

const CACHE_TTL_MS = 15_000;
let serverCache: { value: PasskeyServerPolicy; expires: number } | null = null;
const userCache = new Map<string, { allowed: boolean; expires: number }>();

onAuthInvalidation((e) => { userCache.delete(e.userId); });

const invalidationListeners: Array<() => void> = [];

/** Other passkey caches (the RP configuration) that must drop with the policy. */
export function onPasskeyPolicyInvalidation(fn: () => void): void {
  invalidationListeners.push(fn);
}

/** Drops the cached policy of this process (settings change, tests). */
export function invalidatePasskeyPolicyCache(): void {
  serverCache = null;
  userCache.clear();
  for (const fn of invalidationListeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

type SwitchValue = 'INHERIT' | 'ON' | 'OFF';
const toSetting = (v: unknown): PasskeySetting => (v === 'ON' ? 'on' : v === 'OFF' ? 'off' : 'inherit');
const toColumn = (s: PasskeySetting): SwitchValue => (s === 'on' ? 'ON' : s === 'off' ? 'OFF' : 'INHERIT');

/** Pure: server value, then domain, then user — the most specific non-inherit wins. */
export function resolvePasskeySwitch(server: boolean, domain: PasskeySetting, user: PasskeySetting): boolean {
  if (user !== 'inherit') return user === 'on';
  if (domain !== 'inherit') return domain === 'on';
  return server;
}

/** The server level (cached 15 s). Throws on database errors. */
export async function loadPasskeyServerPolicy(): Promise<PasskeyServerPolicy> {
  const now = Date.now();
  if (serverCache && serverCache.expires > now) return serverCache.value;
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { passkeysEnabled: true, passkeyPasswordlessEnabled: true, passkeyRpId: true, passkeyRelatedOrigins: true },
  });
  const value: PasskeyServerPolicy = {
    enabled: s?.passkeysEnabled === true,
    passwordless: s?.passkeyPasswordlessEnabled !== false,
    rpId: typeof s?.passkeyRpId === 'string' && s.passkeyRpId ? s.passkeyRpId : null,
    relatedOrigins: Array.isArray(s?.passkeyRelatedOrigins) ? s.passkeyRelatedOrigins.filter((o): o is string => typeof o === 'string') : [],
  };
  serverCache = { value, expires: now + CACHE_TTL_MS };
  return value;
}

/** May the user register passkeys / sign in with them / redeem a recovery link? Throws on database errors. */
export async function passkeysAllowedFor(user: { id: string; domainId: string }): Promise<boolean> {
  const now = Date.now();
  const hit = userCache.get(user.id);
  if (hit && hit.expires > now) return hit.allowed;
  const server = await loadPasskeyServerPolicy();
  const rows = await prisma.passkeyPolicy.findMany({
    where: { OR: [{ domainId: user.domainId }, { userId: user.id }] },
    select: { domainId: true, userId: true, passkeys: true },
  });
  const domain = toSetting(rows.find((r) => r.domainId === user.domainId)?.passkeys);
  const own = toSetting(rows.find((r) => r.userId === user.id)?.passkeys);
  const allowed = resolvePasskeySwitch(server.enabled, domain, own);
  if (userCache.size > 10_000) userCache.clear();
  userCache.set(user.id, { allowed, expires: now + CACHE_TTL_MS });
  return allowed;
}

/** Passkeys switched on anywhere (server, or any domain / user override) — the login page shows the button. */
export async function passkeysEnabledAnywhere(): Promise<boolean> {
  const server = await loadPasskeyServerPolicy();
  if (server.enabled) return true;
  return (await prisma.passkeyPolicy.count({ where: { passkeys: 'ON' } })) > 0;
}

// ── Levels (admin API) ────────────────────────────────────────────────────────

export type PasskeyScope = { level: 'domain'; domainId: string } | { level: 'user'; userId: string };

export interface PasskeyLevelView {
  setting: PasskeySetting;
  /** What `inherit` resolves to on this level. */
  inherited: boolean;
  inheritedFrom: 'server' | 'domain';
  effective: boolean;
}

/** One level with its inherited / effective value; null for an unknown domain / user. */
export async function readPasskeyLevel(scope: PasskeyScope): Promise<PasskeyLevelView | null> {
  const server = await loadPasskeyServerPolicy();
  if (scope.level === 'domain') {
    const d = await prisma.domain.findUnique({ where: { id: scope.domainId }, select: { id: true } });
    if (!d) return null;
    const row = await prisma.passkeyPolicy.findUnique({ where: { domainId: scope.domainId }, select: { passkeys: true } });
    const setting = toSetting(row?.passkeys);
    return { setting, inherited: server.enabled, inheritedFrom: 'server', effective: resolvePasskeySwitch(server.enabled, setting, 'inherit') };
  }
  const u = await prisma.user.findUnique({ where: { id: scope.userId }, select: { id: true, domainId: true } });
  if (!u) return null;
  const rows = await prisma.passkeyPolicy.findMany({
    where: { OR: [{ domainId: u.domainId }, { userId: u.id }] },
    select: { domainId: true, userId: true, passkeys: true },
  });
  const domain = toSetting(rows.find((r) => r.domainId === u.domainId)?.passkeys);
  const setting = toSetting(rows.find((r) => r.userId === u.id)?.passkeys);
  const inherited = resolvePasskeySwitch(server.enabled, domain, 'inherit');
  return { setting, inherited, inheritedFrom: domain !== 'inherit' ? 'domain' : 'server', effective: resolvePasskeySwitch(server.enabled, domain, setting) };
}

/** Writes one level (inherit deletes the row). Returns the previous setting. */
export async function writePasskeyLevel(scope: PasskeyScope, setting: PasskeySetting): Promise<PasskeySetting> {
  const where = scope.level === 'domain' ? { domainId: scope.domainId } : { userId: scope.userId };
  const before = toSetting((await prisma.passkeyPolicy.findUnique({ where, select: { passkeys: true } }))?.passkeys);
  if (setting === 'inherit') {
    await prisma.passkeyPolicy.deleteMany({ where });
  } else {
    await prisma.passkeyPolicy.upsert({
      where,
      create: { ...where, passkeys: toColumn(setting) },
      update: { passkeys: toColumn(setting) },
    });
  }
  await publishPasskeyPolicyReload();
  return before;
}

/** Server level: switch + passwordless + related origins. Returns before/after for the audit log. */
export async function writePasskeyServerPolicy(patch: { enabled?: boolean; passwordless?: boolean; relatedOrigins?: string[] }): Promise<{ before: PasskeyServerPolicy; after: PasskeyServerPolicy }> {
  invalidatePasskeyPolicyCache();
  const before = await loadPasskeyServerPolicy();
  const data = {
    ...(patch.enabled !== undefined ? { passkeysEnabled: patch.enabled } : {}),
    ...(patch.passwordless !== undefined ? { passkeyPasswordlessEnabled: patch.passwordless } : {}),
    ...(patch.relatedOrigins !== undefined ? { passkeyRelatedOrigins: patch.relatedOrigins } : {}),
  };
  await prisma.serverSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...data }, update: data });
  await publishPasskeyPolicyReload();
  return { before, after: await loadPasskeyServerPolicy() };
}

/** Drops this process's caches and tells the other services (CHANNEL_SETTINGS_RELOAD). */
export async function publishPasskeyPolicyReload(): Promise<void> {
  invalidatePasskeyPolicyCache();
  try {
    const r = peekRedisClient();
    if (r) void r.publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: PASSKEY_POLICY_RELOAD }))
      .catch((err: unknown) => log.warn({ err }, 'Could not publish the passkey policy reload — services reload within 15 s'));
  } catch (err) {
    log.warn({ err }, 'Could not publish the passkey policy reload — services reload within 15 s');
  }
}

let subscribed = false;

/** Drops the caches on every passkey policy change of any instance. Idempotent; call at service start. */
export function startPasskeyPolicySubscriber(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    const sub = getRedisClient().duplicate();
    sub.on('error', (err) => log.warn({ err }, 'Passkey policy subscriber error'));
    sub.on('message', (_channel: string, message: string) => {
      try {
        if ((JSON.parse(message) as { type?: unknown } | null)?.type === PASSKEY_POLICY_RELOAD) invalidatePasskeyPolicyCache();
      } catch { /* other messages */ }
    });
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD).catch((err: unknown) => log.warn({ err }, 'Passkey policy subscribe failed'));
  } catch (err) {
    log.warn({ err }, 'Passkey policy subscriber not started — changes apply within 15 s');
  }
}
