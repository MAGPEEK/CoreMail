/**
 * Per-protocol access switches (9.4) — which client protocols a user may use.
 *
 * Levels: server → domain → user. Domain and user switches are
 * `inherit | on | off`; the server level is two-state (`on | off`) — it has no
 * broader level, a never-written server switch is the built-in default
 * (PROTOCOL_DEFAULTS: every protocol on, MAPI off). The effective value is the
 * most specific non-inherit one. Storage: one ProtocolPolicy row per level
 * (id 'global', or domainId / userId). The server level of JMAP is
 * ServerSettings.jmapEnabled (the legacy JMAP switch keeps working; the
 * 'global' row's jmap column is never written).
 *
 * Enforcement happens after a successful authentication, never before (a
 * wrong password always gets the protocol's normal "invalid credentials"):
 *   - mail protocols: verifyMailCredentials() → status `protocol_disabled`
 *   - Bearer tokens (JMAP, CalDAV) and web/API sessions: isProtocolAllowed()
 *
 * Changes go through updateProtocolSettings() / withProtocolAccessChange():
 * the effective access of every user in scope is compared before and after the
 * write; each user whose access changed gets a PROTOCOL_ACCESS_CHANGE event
 * (caches drop the user, live connections on now-disabled protocols end), then
 * CHANNEL_SETTINGS_RELOAD is published (JMAP service switch, Autodiscover).
 *
 * Cache: effective access per user (30 s); a user's entry is dropped on every
 * auth invalidation event of that user — services call
 * startAuthInvalidationSubscriber() at start. Anonymous lookups (Autodiscover
 * v2, autoconfig) resolve from an in-memory index of the server and domain
 * switches (60 s, dropped on CHANNEL_SETTINGS_RELOAD via
 * invalidateProtocolAccessCache()) — a request never costs a database query.
 */
import type { Prisma } from '@prisma/client';
import { createLogger, onAuthInvalidation, CHANNEL_SETTINGS_RELOAD, PROTOCOL_ACCESS_CHANGE } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { publishUserAuthChange } from './auth/invalidation.js';
import { authRedis } from './auth/redis.js';
import {
  SWITCH_SETTINGS, SERVER_SWITCH_SETTINGS, inheritAllSwitches, mapKeys, resolveSwitches, switchFromColumn, switchToColumn,
  type PolicyScope, type SwitchColumn, type SwitchSetting,
} from './policy-levels.js';

const log = createLogger('protocol-access');

// ─── Model (pure) ─────────────────────────────────────────────────────────────

/** Every switchable protocol. `dav` = CalDAV + CardDAV, `smtp` = authenticated submission. */
export const ACCESS_PROTOCOLS = ['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi'] as const;
export type AccessProtocol = typeof ACCESS_PROTOCOLS[number];

export const PROTOCOL_SETTINGS = SWITCH_SETTINGS;
export type ProtocolSetting = SwitchSetting;

/** The server level has no broader level to inherit from: only on / off. */
export const SERVER_PROTOCOL_SETTINGS = SERVER_SWITCH_SETTINGS;

/** The settings a level accepts (`inherit` only below the server level). */
export function settingsForLevel(level: ProtocolScope['level']): readonly ProtocolSetting[] {
  return level === 'global' ? SERVER_PROTOCOL_SETTINGS : PROTOCOL_SETTINGS;
}

/** The switches of one level. */
export type ProtocolSettings = Record<AccessProtocol, ProtocolSetting>;
/** Effective access: true = allowed. */
export type ProtocolAccess = Record<AccessProtocol, boolean>;

/** Built-in defaults below the server level: everything that existed before 9.4 on, MAPI off. */
export const PROTOCOL_DEFAULTS: Readonly<ProtocolAccess> = Object.freeze({
  imap: true, pop3: true, smtp: true, activesync: true, jmap: true, dav: true, webmail: true, mapi: false,
});

export type ProtocolScope = PolicyScope;

export function isAccessProtocol(v: unknown): v is AccessProtocol {
  return typeof v === 'string' && (ACCESS_PROTOCOLS as readonly string[]).includes(v);
}

export function isProtocolSetting(v: unknown): v is ProtocolSetting {
  return typeof v === 'string' && (PROTOCOL_SETTINGS as readonly string[]).includes(v);
}

function mapProtocols<T>(fn: (p: AccessProtocol) => T): Record<AccessProtocol, T> {
  return mapKeys(ACCESS_PROTOCOLS, fn);
}

export function inheritAll(): ProtocolSettings {
  return inheritAllSwitches(ACCESS_PROTOCOLS);
}

/** Effective access from `levels` (broadest first): the most specific non-inherit switch wins. */
export function resolveProtocolAccess(
  levels: readonly ProtocolSettings[],
  defaults: Readonly<ProtocolAccess> = PROTOCOL_DEFAULTS,
): ProtocolAccess {
  return resolveSwitches(ACCESS_PROTOCOLS, levels, defaults);
}

/** The protocols that are off. */
export function disabledProtocols(access: ProtocolAccess): AccessProtocol[] {
  return ACCESS_PROTOCOLS.filter((p) => !access[p]);
}

function sameAccess(a: ProtocolAccess | undefined, b: ProtocolAccess | undefined): boolean {
  return !!a && !!b && ACCESS_PROTOCOLS.every((p) => a[p] === b[p]);
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

type SwitchValue = SwitchColumn;
type PolicyRow = { id: string; domainId: string | null; userId: string | null } & Record<AccessProtocol, SwitchValue>;

export const GLOBAL_POLICY_ID = 'global';

const toSetting = switchFromColumn;
const toSwitch = switchToColumn;

function settingsOf(row: PolicyRow | undefined): ProtocolSettings {
  return mapProtocols((p) => toSetting(row?.[p]));
}

/** Server level: the 'global' row, JMAP from ServerSettings.jmapEnabled. */
function globalSettingsOf(row: PolicyRow | undefined, jmapEnabled: boolean): ProtocolSettings {
  return { ...settingsOf(row), jmap: jmapEnabled ? 'on' : 'off' };
}

interface PolicySnapshot {
  global: ProtocolSettings;
  byDomain: Map<string, ProtocolSettings>;
  byUser: Map<string, ProtocolSettings>;
}

function snapshotOf(rows: PolicyRow[], jmapEnabled: boolean): PolicySnapshot {
  const snap: PolicySnapshot = {
    global: globalSettingsOf(rows.find((r) => r.id === GLOBAL_POLICY_ID), jmapEnabled),
    byDomain: new Map(),
    byUser: new Map(),
  };
  for (const r of rows) {
    if (r.userId) snap.byUser.set(r.userId, settingsOf(r));
    else if (r.domainId) snap.byDomain.set(r.domainId, settingsOf(r));
  }
  return snap;
}

const inherit = inheritAll();

function accessFor(snap: PolicySnapshot, domainId: string | null, userId: string | null): ProtocolAccess {
  return resolveProtocolAccess([
    snap.global,
    (domainId && snap.byDomain.get(domainId)) || inherit,
    (userId && snap.byUser.get(userId)) || inherit,
  ]);
}

/** Above this many users the snapshot loads every policy row instead of an IN list. */
const LOAD_ALL_ROWS_ABOVE = 500;

async function loadSnapshot(users: ReadonlyArray<{ id: string; domainId: string | null }>): Promise<PolicySnapshot> {
  const domainIds = [...new Set(users.map((u) => u.domainId).filter((d): d is string => !!d))];
  const where: Prisma.ProtocolPolicyWhereInput | undefined = users.length > LOAD_ALL_ROWS_ABOVE ? undefined : {
    OR: [
      { id: GLOBAL_POLICY_ID },
      ...(domainIds.length ? [{ domainId: { in: domainIds } }] : []),
      ...(users.length ? [{ userId: { in: users.map((u) => u.id) } }] : []),
    ],
  };
  const [settings, rows] = await Promise.all([
    prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { jmapEnabled: true } }),
    where ? prisma.protocolPolicy.findMany({ where }) : prisma.protocolPolicy.findMany(),
  ]);
  return snapshotOf(rows as PolicyRow[], settings?.jmapEnabled ?? true);
}

async function effectiveForUsers(users: ReadonlyArray<{ id: string; domainId: string }>): Promise<Map<string, ProtocolAccess>> {
  const snap = await loadSnapshot(users);
  return new Map(users.map((u) => [u.id, accessFor(snap, u.domainId, u.id)]));
}

// ─── Effective access (cached) ────────────────────────────────────────────────

const USER_CACHE_TTL_MS = 30_000;
const DOMAIN_INDEX_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 10_000;
const userCache = new Map<string, { access: ProtocolAccess; expires: number }>();
const userInvalidatedAt = new Map<string, number>();

/** Server level + the switches of every domain that has any, by domain name (anonymous lookups). */
interface DomainIndex {
  global: ProtocolSettings;
  byName: Map<string, ProtocolSettings>;
  expires: number;
}
let domainIndex: DomainIndex | null = null;
let domainIndexLoad: Promise<DomainIndex> | null = null;
/** Bumped by every invalidation, so a load that started before it is not cached. */
let domainIndexGeneration = 0;

function dropDomainIndex(): void {
  domainIndex = null;
  domainIndexLoad = null;
  domainIndexGeneration++;
}

onAuthInvalidation((e) => {
  userCache.delete(e.userId);
  userInvalidatedAt.set(e.userId, Date.now());
  if (userInvalidatedAt.size > MAX_CACHE_ENTRIES) {
    const cutoff = Date.now() - USER_CACHE_TTL_MS;
    for (const [u, t] of userInvalidatedAt) if (t < cutoff) userInvalidatedAt.delete(u);
  }
});

/** Drops every cached result (settings reload signal, tests). */
export function invalidateProtocolAccessCache(): void {
  userCache.clear();
  userInvalidatedAt.clear();
  dropDomainIndex();
}

const NONE: Readonly<ProtocolAccess> = Object.freeze(mapProtocols(() => false));

/** A user id, or the user with its domain when the caller already has it (saves a lookup). */
export type ProtocolSubject = string | { id: string; domainId: string };

/**
 * Effective protocol access of a user. Unknown users get no protocol. Throws
 * on database errors (callers answer with a temporary failure).
 */
export async function effectiveProtocolAccess(subject: ProtocolSubject): Promise<ProtocolAccess> {
  const userId = typeof subject === 'string' ? subject : subject.id;
  const startedAt = Date.now();
  const hit = userCache.get(userId);
  if (hit && hit.expires > startedAt) return hit.access;
  const domainId = typeof subject === 'string'
    ? (await prisma.user.findUnique({ where: { id: userId }, select: { domainId: true } }))?.domainId
    : subject.domainId;
  const access = domainId !== undefined ? (await effectiveForUsers([{ id: userId, domainId }])).get(userId)! : { ...NONE };
  // A lookup that raced with an invalidation is not cached (it may be stale).
  if ((userInvalidatedAt.get(userId) ?? 0) < startedAt) {
    if (userCache.size >= MAX_CACHE_ENTRIES) userCache.clear();
    userCache.set(userId, { access, expires: Date.now() + USER_CACHE_TTL_MS });
  }
  return access;
}

export async function isProtocolAllowed(subject: ProtocolSubject, protocol: AccessProtocol): Promise<boolean> {
  return (await effectiveProtocolAccess(subject))[protocol];
}

const normalizeDomainName = (name: string): string => name.trim().toLowerCase();

/** The server row and every domain row (with the domain name) — two queries for all anonymous lookups. */
async function loadDomainIndex(now: number): Promise<DomainIndex> {
  const [settings, rows] = await Promise.all([
    prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { jmapEnabled: true } }),
    prisma.protocolPolicy.findMany({ where: { userId: null }, include: { domain: { select: { name: true } } } }),
  ]);
  const policies = rows as Array<PolicyRow & { domain?: { name: string } | null }>;
  const byName = new Map<string, ProtocolSettings>();
  for (const r of policies) {
    if (!r.userId && r.domain?.name) byName.set(normalizeDomainName(r.domain.name), settingsOf(r));
  }
  return {
    global: globalSettingsOf(policies.find((r) => r.id === GLOBAL_POLICY_ID), settings?.jmapEnabled ?? true),
    byName,
    expires: now + DOMAIN_INDEX_TTL_MS,
  };
}

/**
 * Effective access for an anonymous request about a mail domain (Autodiscover
 * v2, Thunderbird autoconfig): server + domain level, no user level — so the
 * answer never depends on (or reveals anything about) a single account.
 * A domain this server does not host (or without switches) gets the server
 * level. Resolved from the in-memory index: an anonymous request never causes
 * a database query of its own, whatever domain name it sends.
 */
export async function domainProtocolAccess(domainName: string): Promise<ProtocolAccess> {
  const index = await currentDomainIndex();
  const domainLevel = index.byName.get(normalizeDomainName(domainName)) ?? inherit;
  return resolveProtocolAccess([index.global, domainLevel]);
}

/** The cached index; concurrent misses share one load, a load raced by an invalidation is not kept. */
async function currentDomainIndex(): Promise<DomainIndex> {
  const now = Date.now();
  if (domainIndex && domainIndex.expires > now) return domainIndex;
  if (!domainIndexLoad) {
    const generation = domainIndexGeneration;
    domainIndexLoad = loadDomainIndex(now)
      .then((index) => {
        if (generation === domainIndexGeneration) domainIndex = index;
        return index;
      })
      .finally(() => { domainIndexLoad = null; });
  }
  return domainIndexLoad;
}

/** True when the protocol is on at the server level or switched on for any domain or user. */
export async function protocolEnabledAnywhere(protocol: AccessProtocol): Promise<boolean> {
  const snap = await loadSnapshot([]);
  if (resolveProtocolAccess([snap.global])[protocol]) return true;
  const where = { [protocol]: 'ON', NOT: { id: GLOBAL_POLICY_ID } } as Prisma.ProtocolPolicyWhereInput;
  return (await prisma.protocolPolicy.count({ where })) > 0;
}

// ─── Admin view + changes ─────────────────────────────────────────────────────

export interface ProtocolLevelView {
  /** The switches of this level (server level: always `on` / `off`). */
  settings: ProtocolSettings;
  /**
   * What `inherit` resolves to on this level (the broader levels); on the
   * server level the built-in defaults.
   */
  inherited: ProtocolAccess;
  /** The effective access of this level (settings over inherited). */
  effective: ProtocolAccess;
}

/** Server level view: two-state — a never-written switch shows its built-in default. */
function serverLevelView(global: ProtocolSettings): ProtocolLevelView {
  const effective = resolveProtocolAccess([global]);
  return { settings: mapProtocols((p) => (effective[p] ? 'on' : 'off')), inherited: { ...PROTOCOL_DEFAULTS }, effective };
}

/** The switches of one level plus what they resolve to; null when the domain / user does not exist. */
export async function readProtocolLevel(scope: ProtocolScope): Promise<ProtocolLevelView | null> {
  let domainId: string | null = null;
  let userId: string | null = null;
  if (scope.level === 'domain') {
    const d = await prisma.domain.findUnique({ where: { id: scope.domainId }, select: { id: true } });
    if (!d) return null;
    domainId = d.id;
  } else if (scope.level === 'user') {
    const u = await prisma.user.findUnique({ where: { id: scope.userId }, select: { id: true, domainId: true } });
    if (!u) return null;
    ({ domainId } = u);
    userId = u.id;
  }
  const snap = await loadSnapshot(userId ? [{ id: userId, domainId }] : domainId ? [{ id: '', domainId }] : []);
  if (scope.level === 'global') return serverLevelView(snap.global);
  const domainLevel = (domainId && snap.byDomain.get(domainId)) || inherit;
  const levels = scope.level === 'domain' ? [snap.global] : [snap.global, domainLevel];
  const settings = scope.level === 'domain' ? domainLevel : (userId && snap.byUser.get(userId)) || inheritAll();
  return {
    settings,
    inherited: resolveProtocolAccess(levels),
    effective: resolveProtocolAccess([...levels, settings]),
  };
}

async function usersInScope(scope: ProtocolScope): Promise<Array<{ id: string; domainId: string }>> {
  const select = { id: true, domainId: true } as const;
  if (scope.level === 'global') return prisma.user.findMany({ select });
  if (scope.level === 'domain') return prisma.user.findMany({ where: { domainId: scope.domainId }, select });
  return prisma.user.findMany({ where: { id: scope.userId }, select });
}

async function publishSettingsReload(): Promise<void> {
  try {
    const r = authRedis() as unknown as { publish?: (channel: string, message: string) => Promise<unknown> };
    if (typeof r.publish === 'function') await r.publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'protocol-access' }));
  } catch (err) {
    log.warn({ err }, 'Could not publish the settings reload signal — caches expire on their TTL');
  }
}

/**
 * Runs `write` (a change of protocol switches, or of ServerSettings.jmapEnabled)
 * and notifies every user in `scope` whose effective access changed:
 * PROTOCOL_ACCESS_CHANGE with the protocols that are now off.
 */
export async function withProtocolAccessChange<T>(
  scope: ProtocolScope,
  write: () => Promise<T>,
): Promise<{ result: T; changedUsers: number }> {
  const users = await usersInScope(scope);
  const before = await effectiveForUsers(users);
  const result = await write();
  const after = await effectiveForUsers(users);
  const changed = users.filter((u) => !sameAccess(before.get(u.id), after.get(u.id)));
  for (const u of changed) {
    await publishUserAuthChange(u.id, PROTOCOL_ACCESS_CHANGE, { disabledProtocols: disabledProtocols(after.get(u.id)!) });
  }
  if (scope.level !== 'user') dropDomainIndex();
  await publishSettingsReload();
  if (changed.length > 0) log.info({ scope, users: changed.length }, 'Protocol access changed');
  return { result, changedUsers: changed.length };
}

function policyKey(scope: ProtocolScope): Prisma.ProtocolPolicyWhereUniqueInput {
  if (scope.level === 'global') return { id: GLOBAL_POLICY_ID };
  return scope.level === 'domain' ? { domainId: scope.domainId } : { userId: scope.userId };
}

/** Throws a RangeError for a setting the level does not accept (`inherit` on the server level). */
export function assertSettingsForLevel(level: ProtocolScope['level'], patch: Partial<ProtocolSettings>): void {
  const allowed = settingsForLevel(level);
  for (const [p, s] of Object.entries(patch)) {
    if (s !== undefined && !allowed.includes(s)) throw new RangeError(`${p}: '${s}' is not a ${level} level setting (${allowed.join(', ')})`);
  }
}

async function writeSettings(scope: ProtocolScope, patch: Partial<ProtocolSettings>): Promise<void> {
  const { jmap, ...rest } = patch;
  const rowPatch: Partial<ProtocolSettings> = scope.level === 'global' ? rest : patch;
  if (scope.level === 'global' && jmap !== undefined) {
    // The server level of JMAP is the legacy switch.
    const jmapEnabled = jmap === 'on';
    await prisma.serverSettings.upsert({
      where: { id: 'singleton' }, create: { id: 'singleton', jmapEnabled }, update: { jmapEnabled },
    });
  }
  const data = Object.fromEntries(
    Object.entries(rowPatch).map(([p, s]) => [p, toSwitch(s as ProtocolSetting)]),
  ) as Partial<Record<AccessProtocol, SwitchValue>>;
  if (Object.keys(data).length === 0) return;
  const owner = scope.level === 'domain' ? { domainId: scope.domainId }
    : scope.level === 'user' ? { userId: scope.userId } : { id: GLOBAL_POLICY_ID };
  await prisma.protocolPolicy.upsert({ where: policyKey(scope), create: { ...owner, ...data }, update: data });
}

export interface ProtocolUpdateResult {
  before: ProtocolSettings;
  after: ProtocolLevelView;
  /** Users whose effective access changed. */
  changedUsers: number;
}

/**
 * Changes switches of one level (fields missing in `patch` keep their value).
 * Returns null when the domain / user does not exist; throws a RangeError for
 * `inherit` on the server level (assertSettingsForLevel).
 */
export async function updateProtocolSettings(
  scope: ProtocolScope,
  patch: Partial<ProtocolSettings>,
): Promise<ProtocolUpdateResult | null> {
  assertSettingsForLevel(scope.level, patch);
  const current = await readProtocolLevel(scope);
  if (!current) return null;
  const { changedUsers } = await withProtocolAccessChange(scope, () => writeSettings(scope, patch));
  const after = await readProtocolLevel(scope);
  return after ? { before: current.settings, after, changedUsers } : null;
}
