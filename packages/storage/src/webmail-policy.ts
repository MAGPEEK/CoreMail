/**
 * Webmail policies (9.4) — which webmail modules a user may use, and how the
 * webmail treats attachments and external images. See docs/webmail-policies.md.
 *
 * Levels: server → domain → user (policy-levels.ts, the same resolution as the
 * protocol switches). Feature switches are `inherit | on | off`; the server
 * level is two-state (`on | off`, a never-written switch is the built-in
 * default: on — nothing changes for existing installations). Content values are
 * `null` = inherit; the server level always has a value (never written = the
 * built-in default). The max. upload size of a domain / user is capped by the
 * server value.
 *
 * Storage: one WebmailPolicy row per level (id 'global', or domainId /
 * userId). Changes go through updateWebmailPolicy(): the row is written, the
 * caches in every service are dropped (CHANNEL_SETTINGS_RELOAD
 * `{type:'webmail-policy'}`) and every user in scope gets the user event
 * `settings` / `policies`, so open webmail tabs re-read GET /user/features.
 * Accounts whose module "App-Passwörter" goes from on to off also get the auth
 * event APP_PASSWORDS_DISABLED_REASON: their app passwords stop working on the
 * mail protocols (verifyMailCredentials, mail-auth.ts) and live connections
 * that logged in with one end.
 *
 * Cache: effective policy per user (30 s), dropped on the reload signal
 * (invalidateWebmailPolicyCache) and on every auth invalidation of the user.
 */
import { createLogger, getRedisClient, onAuthInvalidation, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma/index.js';
import { authRedis } from './auth/redis.js';
import { publishUserAuthChange } from './auth/invalidation.js';
import { announceUserEvent } from './realtime/announce.js';
import { normalizeExtensionList } from './file-types.js';
import {
  SWITCH_SETTINGS, SERVER_SWITCH_SETTINGS, inheritAllSwitches, mapKeys, resolveSwitch, resolveValue,
  switchFromColumn, switchToColumn,
  type PolicyScope, type SwitchColumn, type SwitchSetting, type ValueSource,
} from './policy-levels.js';

const log = createLogger('webmail-policy');

// ─── Model (pure) ─────────────────────────────────────────────────────────────

/** Every switchable webmail module. */
export const WEBMAIL_FEATURES = [
  'calendar', 'contacts', 'tasks', 'notes', 'rules', 'signatures', 'categories', 'recoverItems',
  'changePassword', 'themes', 'externalClients', 'appPasswords', 'sharedMailboxes',
] as const;
export type WebmailFeature = typeof WEBMAIL_FEATURES[number];
export type FeatureSettings = Record<WebmailFeature, SwitchSetting>;
export type WebmailFeatures = Record<WebmailFeature, boolean>;

/** Built-in defaults: every module on (the behaviour before 9.4). */
export const FEATURE_DEFAULTS: Readonly<WebmailFeatures> = Object.freeze(mapKeys(WEBMAIL_FEATURES, () => true));

/** Error code of every refusal caused by a webmail module switch (403). */
export const FEATURE_DISABLED_CODE = 'FEATURE_DISABLED';

/** JSON body of the 403 answer for a module that is off. */
export function featureDisabledBody(feature: WebmailFeature): { error: string; code: string; feature: WebmailFeature } {
  return { error: `${feature} is disabled for this account`, code: FEATURE_DISABLED_CODE, feature };
}

export function isWebmailFeature(v: unknown): v is WebmailFeature {
  return typeof v === 'string' && (WEBMAIL_FEATURES as readonly string[]).includes(v);
}

export const EXTERNAL_IMAGE_MODES = ['ask', 'contacts', 'block'] as const;
export type ExternalImageMode = typeof EXTERNAL_IMAGE_MODES[number];

export const CONTENT_KEYS = ['blockedExtensions', 'downloadOnlyExtensions', 'maxUploadMb', 'externalImages'] as const;
export type ContentKey = typeof CONTENT_KEYS[number];

/** Attachment / content values of one level (`null` = inherit; server level: see SERVER_CONTENT). */
export interface ContentSettings {
  blockedExtensions: string[] | null;
  downloadOnlyExtensions: string[] | null;
  maxUploadMb: number | null;
  externalImages: ExternalImageMode | null;
}

/** Effective attachment / content policy. `maxUploadMb: null` = no own limit (the message size limit applies). */
export interface ContentPolicy {
  blockedExtensions: string[];
  downloadOnlyExtensions: string[];
  maxUploadMb: number | null;
  externalImages: ExternalImageMode;
}

/** Built-in defaults: nothing blocked, no own upload limit, external images on request. */
export const CONTENT_DEFAULTS: Readonly<ContentPolicy> = Object.freeze({
  blockedExtensions: [], downloadOnlyExtensions: [], maxUploadMb: null, externalImages: 'ask',
});

/** Largest accepted upload limit (MB). */
export const MAX_UPLOAD_MB_LIMIT = 10_240;

export interface WebmailPolicyLevel {
  features: FeatureSettings;
  content: ContentSettings;
}

export interface WebmailPolicy {
  features: WebmailFeatures;
  content: ContentPolicy;
}

/** The level that decided every effective value ('default' = built-in). */
export interface WebmailPolicySources {
  features: Record<WebmailFeature, ValueSource>;
  content: Record<ContentKey, ValueSource>;
}

const INHERIT_CONTENT: Readonly<ContentSettings> = Object.freeze({
  blockedExtensions: null, downloadOnlyExtensions: null, maxUploadMb: null, externalImages: null,
});

export function inheritAllPolicy(): WebmailPolicyLevel {
  return { features: inheritAllSwitches(WEBMAIL_FEATURES), content: { ...INHERIT_CONTENT } };
}

/**
 * Effective policy from `levels` (server first, then domain, then user) plus
 * the deciding level of each value. The upload limit of a domain / user is
 * capped by the server value (the server decides then).
 */
export function resolveWebmailPolicy(levels: readonly WebmailPolicyLevel[]): { effective: WebmailPolicy; sources: WebmailPolicySources } {
  const feature = (f: WebmailFeature) => resolveSwitch(levels.map((l) => l.features[f]), FEATURE_DEFAULTS[f]);
  const value = <K extends ContentKey>(k: K) =>
    resolveValue(levels.map((l) => l.content[k]), CONTENT_DEFAULTS[k] as ContentPolicy[K]);
  const blocked = value('blockedExtensions');
  const downloadOnly = value('downloadOnlyExtensions');
  const images = value('externalImages');
  let upload = value('maxUploadMb');
  const ceiling = levels[0]?.content.maxUploadMb ?? null;
  if (ceiling !== null && (upload.value === null || upload.value > ceiling)) upload = { value: ceiling, source: 'global' };
  return {
    effective: {
      features: mapKeys(WEBMAIL_FEATURES, (f) => feature(f).value),
      content: {
        blockedExtensions: [...(blocked.value as string[])],
        downloadOnlyExtensions: [...(downloadOnly.value as string[])],
        maxUploadMb: upload.value as number | null,
        externalImages: images.value as ExternalImageMode,
      },
    },
    sources: {
      features: mapKeys(WEBMAIL_FEATURES, (f) => feature(f).source),
      content: { blockedExtensions: blocked.source, downloadOnlyExtensions: downloadOnly.source, maxUploadMb: upload.source, externalImages: images.source },
    },
  };
}

/** Max. upload size in bytes (`null` = only the message size limit). */
export function maxUploadBytes(policy: Pick<ContentPolicy, 'maxUploadMb'>): number | null {
  return policy.maxUploadMb === null ? null : policy.maxUploadMb * 1024 * 1024;
}

// ─── Validation of a change (pure) ────────────────────────────────────────────

export interface WebmailPolicyPatch {
  features?: Partial<FeatureSettings>;
  content?: Partial<ContentSettings>;
}

/**
 * Throws a RangeError for a value the level does not accept: `inherit` / null
 * on the server level (except maxUploadMb null = no own limit), an unknown
 * setting or mode, an upload limit outside 1..MAX_UPLOAD_MB_LIMIT.
 */
export function assertPolicyPatch(level: PolicyScope['level'], patch: WebmailPolicyPatch): void {
  const switches: readonly string[] = level === 'global' ? SERVER_SWITCH_SETTINGS : SWITCH_SETTINGS;
  for (const [f, s] of Object.entries(patch.features ?? {})) {
    if (!isWebmailFeature(f)) throw new RangeError(`unknown feature '${f}'`);
    if (s !== undefined && !switches.includes(s)) throw new RangeError(`${f}: '${s}' is not a ${level} level setting (${switches.join(', ')})`);
  }
  const c = patch.content ?? {};
  for (const key of Object.keys(c)) if (!(CONTENT_KEYS as readonly string[]).includes(key)) throw new RangeError(`unknown policy value '${key}'`);
  for (const key of ['blockedExtensions', 'downloadOnlyExtensions'] as const) {
    const v = c[key];
    if (v === null && level === 'global') throw new RangeError(`${key}: the server level needs a list`);
    if (v !== undefined && v !== null && !Array.isArray(v)) throw new RangeError(`${key}: a list of file extensions is required`);
  }
  if (c.maxUploadMb !== undefined && c.maxUploadMb !== null
    && (!Number.isInteger(c.maxUploadMb) || c.maxUploadMb < 1 || c.maxUploadMb > MAX_UPLOAD_MB_LIMIT)) {
    throw new RangeError(`maxUploadMb: 1..${MAX_UPLOAD_MB_LIMIT} MB`);
  }
  if (c.externalImages === null && level === 'global') throw new RangeError('externalImages: the server level needs a mode');
  if (c.externalImages !== undefined && c.externalImages !== null && !(EXTERNAL_IMAGE_MODES as readonly string[]).includes(c.externalImages)) {
    throw new RangeError(`externalImages: one of ${EXTERNAL_IMAGE_MODES.join(', ')}`);
  }
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export const GLOBAL_WEBMAIL_POLICY_ID = 'global';

type ImageColumn = 'ASK' | 'CONTACTS' | 'BLOCK';
type PolicyRow = { id: string; domainId: string | null; userId: string | null }
  & Record<WebmailFeature, SwitchColumn>
  & { blockedExtensions: unknown; downloadOnlyExtensions: unknown; maxUploadMb: number | null; externalImages: ImageColumn | null };

function listOf(v: unknown): string[] | null {
  return Array.isArray(v) ? normalizeExtensionList(v.filter((x): x is string => typeof x === 'string')) : null;
}

function levelOf(row: PolicyRow | undefined): WebmailPolicyLevel {
  if (!row) return inheritAllPolicy();
  return {
    features: mapKeys(WEBMAIL_FEATURES, (f) => switchFromColumn(row[f])),
    content: {
      blockedExtensions: listOf(row.blockedExtensions),
      downloadOnlyExtensions: listOf(row.downloadOnlyExtensions),
      maxUploadMb: typeof row.maxUploadMb === 'number' ? row.maxUploadMb : null,
      externalImages: row.externalImages ? row.externalImages.toLowerCase() as ExternalImageMode : null,
    },
  };
}

/** The server level as the admin sees it: two-state switches, concrete values (a never-written value is its default). */
function concreteServerLevel(effective: WebmailPolicy): WebmailPolicyLevel {
  return {
    features: mapKeys(WEBMAIL_FEATURES, (f) => (effective.features[f] ? 'on' : 'off')),
    content: { ...effective.content },
  };
}

/** Server, domain and user level of one account from loaded rows (missing rows / values = inherit). */
function levelsFromRows(rows: readonly PolicyRow[], domainId: string | null, userId: string | null): WebmailPolicyLevel[] {
  return [
    levelOf(rows.find((r) => r.id === GLOBAL_WEBMAIL_POLICY_ID)),
    levelOf(domainId ? rows.find((r) => r.domainId === domainId && !r.userId) : undefined),
    levelOf(userId ? rows.find((r) => r.userId === userId) : undefined),
  ];
}

/** Above this many users every policy row is loaded instead of an IN list. */
const LOAD_ALL_ROWS_ABOVE = 500;

/** The rows that decide the policy of `accounts` (the server row, their domains, their own rows). */
async function loadRows(accounts: ReadonlyArray<{ id: string | null; domainId: string | null }>): Promise<PolicyRow[]> {
  if (accounts.length > LOAD_ALL_ROWS_ABOVE) return await prisma.webmailPolicy.findMany() as unknown as PolicyRow[];
  const domainIds = [...new Set(accounts.map((a) => a.domainId).filter((d): d is string => !!d))];
  const userIds = accounts.map((a) => a.id).filter((u): u is string => !!u);
  return await prisma.webmailPolicy.findMany({
    where: {
      OR: [
        { id: GLOBAL_WEBMAIL_POLICY_ID },
        ...(domainIds.length ? [{ domainId: { in: domainIds } }] : []),
        ...(userIds.length ? [{ userId: { in: userIds } }] : []),
      ],
    },
  }) as unknown as PolicyRow[];
}

/** Server, domain and user level as stored (missing rows / values = inherit). */
async function loadLevels(domainId: string | null, userId: string | null): Promise<WebmailPolicyLevel[]> {
  return levelsFromRows(await loadRows([{ id: userId, domainId }]), domainId, userId);
}

/** Effective policy of many accounts with one query (policy changes). */
async function effectiveForUsers(users: ReadonlyArray<{ id: string; domainId: string }>): Promise<Map<string, WebmailPolicy>> {
  const rows = await loadRows(users);
  return new Map(users.map((u) => [u.id, resolveWebmailPolicy(levelsFromRows(rows, u.domainId, u.id)).effective]));
}

// ─── Effective policy (cached) ────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;
const cache = new Map<string, { policy: WebmailPolicy; expires: number }>();
let generation = 0;

/** Drops every cached policy (reload signal, tests). */
export function invalidateWebmailPolicyCache(): void {
  cache.clear();
  generation++;
}

// A load that is in flight while a user is invalidated must not be cached
// either (it may predate the change): bumping the generation skips that write.
onAuthInvalidation((e) => { cache.delete(e.userId); generation++; });

/** Reload signal of a webmail policy change on CHANNEL_SETTINGS_RELOAD. */
export const WEBMAIL_POLICY_RELOAD = 'webmail-policy';

/** True for a CHANNEL_SETTINGS_RELOAD message about webmail policies (pure). */
export function isWebmailPolicyReload(message: string): boolean {
  try {
    return (JSON.parse(message) as { type?: unknown } | null)?.type === WEBMAIL_POLICY_RELOAD;
  } catch {
    return false;
  }
}

let reloadSubscribed = false;

/**
 * Drops the cache of this process on every webmail policy change of any
 * instance (CHANNEL_SETTINGS_RELOAD). Idempotent; call once at service start.
 * Without Redis the 30 s TTL applies.
 */
export function startWebmailPolicySubscriber(): void {
  if (reloadSubscribed) return;
  reloadSubscribed = true;
  try {
    const sub = getRedisClient().duplicate();
    sub.on('error', (err) => log.warn({ err }, 'Webmail policy subscriber error'));
    sub.on('message', (_channel: string, message: string) => {
      if (isWebmailPolicyReload(message)) invalidateWebmailPolicyCache();
    });
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD).catch((err: unknown) => log.warn({ err }, 'Webmail policy subscribe failed'));
  } catch (err) {
    log.warn({ err }, 'Webmail policy subscriber not started — the 30 s cache TTL applies');
  }
}

const NO_FEATURES: Readonly<WebmailFeatures> = Object.freeze(mapKeys(WEBMAIL_FEATURES, () => false));

/** A user id, or the user with its domain when the caller already has it (saves a lookup). */
export type PolicySubject = string | { id: string; domainId: string };

/**
 * Effective webmail policy of a user. An unknown user gets no module. Throws
 * on database errors (callers answer with a temporary failure).
 */
export async function effectiveWebmailPolicy(subject: PolicySubject): Promise<WebmailPolicy> {
  const userId = typeof subject === 'string' ? subject : subject.id;
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.policy;
  const startGeneration = generation;
  const domainId = typeof subject === 'string'
    ? (await prisma.user.findUnique({ where: { id: userId }, select: { domainId: true } }))?.domainId
    : subject.domainId;
  const policy: WebmailPolicy = domainId === undefined
    ? { features: { ...NO_FEATURES }, content: { ...CONTENT_DEFAULTS, blockedExtensions: [], downloadOnlyExtensions: [] } }
    : resolveWebmailPolicy(await loadLevels(domainId, userId)).effective;
  // A load that raced with an invalidation is not cached (it may be stale).
  if (startGeneration === generation) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(userId, { policy, expires: Date.now() + CACHE_TTL_MS });
  }
  return policy;
}

export async function isWebmailFeatureEnabled(subject: PolicySubject, feature: WebmailFeature): Promise<boolean> {
  return (await effectiveWebmailPolicy(subject)).features[feature];
}

// ─── Admin view + changes ─────────────────────────────────────────────────────

export interface WebmailPolicyView {
  /** The values of this level (server level: always concrete). */
  settings: WebmailPolicyLevel;
  /** What `inherit` resolves to on this level (server level: the built-in defaults). */
  inherited: WebmailPolicy;
  /** The effective policy of this level. */
  effective: WebmailPolicy;
  /** The level that decided each effective value. */
  sources: WebmailPolicySources;
}

async function scopeIds(scope: PolicyScope): Promise<{ domainId: string | null; userId: string | null } | null> {
  if (scope.level === 'global') return { domainId: null, userId: null };
  if (scope.level === 'domain') {
    const d = await prisma.domain.findUnique({ where: { id: scope.domainId }, select: { id: true } });
    return d ? { domainId: d.id, userId: null } : null;
  }
  const u = await prisma.user.findUnique({ where: { id: scope.userId }, select: { id: true, domainId: true } });
  return u ? { domainId: u.domainId, userId: u.id } : null;
}

const DEFAULT_POLICY: WebmailPolicy = { features: { ...FEATURE_DEFAULTS }, content: { ...CONTENT_DEFAULTS } };

/** The values of one level plus what they resolve to; null when the domain / user does not exist. */
export async function readWebmailPolicyLevel(scope: PolicyScope): Promise<WebmailPolicyView | null> {
  const ids = await scopeIds(scope);
  if (!ids) return null;
  // The stored server level (unwritten = inherit) resolves to the same values as
  // its concrete view, and names the built-in default as the source.
  const [server, domain, user] = await loadLevels(ids.domainId, ids.userId);
  if (scope.level === 'global') {
    const { effective, sources } = resolveWebmailPolicy([server!]);
    return { settings: concreteServerLevel(effective), inherited: DEFAULT_POLICY, effective, sources };
  }
  const broader = scope.level === 'domain' ? [server!] : [server!, domain!];
  const settings = scope.level === 'domain' ? domain! : user!;
  const resolved = resolveWebmailPolicy([...broader, settings]);
  return {
    settings,
    inherited: resolveWebmailPolicy(broader).effective,
    effective: resolved.effective,
    sources: resolved.sources,
  };
}

async function usersInScope(scope: PolicyScope): Promise<Array<{ id: string; domainId: string }>> {
  const where = scope.level === 'global' ? {} : scope.level === 'domain' ? { domainId: scope.domainId } : { id: scope.userId };
  return prisma.user.findMany({ where, select: { id: true, domainId: true } });
}

/**
 * Reason of the auth event sent to an account whose module "App-Passwörter"
 * was switched off: live mail-protocol connections that logged in with an app
 * password end (core connectionAffected: no `appPasswordId` = every app
 * password of the user), credential caches drop the account. Password and
 * web-session connections are not affected.
 */
export const APP_PASSWORDS_DISABLED_REASON = 'app-password-revoked';

/** The accounts of `users` for which the app-password module went from on to off (pure). */
export function appPasswordsSwitchedOff(
  users: ReadonlyArray<{ id: string }>,
  before: ReadonlyMap<string, WebmailPolicy>,
  after: ReadonlyMap<string, WebmailPolicy>,
): string[] {
  return users
    .filter((u) => before.get(u.id)?.features.appPasswords === true && after.get(u.id)?.features.appPasswords === false)
    .map((u) => u.id);
}

function jsonColumn(v: string[] | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === null ? Prisma.DbNull : normalizeExtensionList(v);
}

/** Prisma data of a patch. */
function rowData(patch: WebmailPolicyPatch): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [f, s] of Object.entries(patch.features ?? {})) if (s !== undefined) data[f] = switchToColumn(s);
  const c = patch.content ?? {};
  if (c.blockedExtensions !== undefined) data['blockedExtensions'] = jsonColumn(c.blockedExtensions);
  if (c.downloadOnlyExtensions !== undefined) data['downloadOnlyExtensions'] = jsonColumn(c.downloadOnlyExtensions);
  if (c.maxUploadMb !== undefined) data['maxUploadMb'] = c.maxUploadMb;
  if (c.externalImages !== undefined) data['externalImages'] = c.externalImages === null ? null : c.externalImages.toUpperCase();
  return data;
}

async function publishPolicyReload(): Promise<void> {
  try {
    const r = authRedis() as unknown as { publish?: (channel: string, message: string) => Promise<unknown> };
    if (typeof r.publish === 'function') await r.publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: WEBMAIL_POLICY_RELOAD }));
  } catch (err) {
    log.warn({ err }, 'Could not publish the webmail policy reload signal — caches expire on their TTL');
  }
}

export interface WebmailPolicyUpdateResult {
  before: WebmailPolicyLevel;
  after: WebmailPolicyView;
  /** Users in scope (each got the `settings` / `policies` event). */
  users: number;
  /** Users whose app passwords stopped working (module "App-Passwörter" switched off for them). */
  appPasswordsDisabled: number;
}

/**
 * Changes values of one level (values missing in `patch` keep theirs). Returns
 * null when the domain / user does not exist; throws a RangeError for a value
 * the level does not accept (assertPolicyPatch). An account for which the
 * app-password module goes from on to off gets APP_PASSWORDS_DISABLED_REASON
 * (its live app-password connections end).
 */
export async function updateWebmailPolicy(scope: PolicyScope, patch: WebmailPolicyPatch): Promise<WebmailPolicyUpdateResult | null> {
  assertPolicyPatch(scope.level, patch);
  const current = await readWebmailPolicyLevel(scope);
  if (!current) return null;
  const users = await usersInScope(scope);
  const tracksAppPasswords = patch.features?.appPasswords !== undefined;
  const before = tracksAppPasswords ? await effectiveForUsers(users) : null;
  const data = rowData(patch);
  if (Object.keys(data).length > 0) {
    const key = scope.level === 'domain' ? { domainId: scope.domainId }
      : scope.level === 'user' ? { userId: scope.userId } : { id: GLOBAL_WEBMAIL_POLICY_ID };
    await prisma.webmailPolicy.upsert({ where: key, create: { ...key, ...data } as never, update: data as never });
  }
  invalidateWebmailPolicyCache();
  const switchedOff = before ? appPasswordsSwitchedOff(users, before, await effectiveForUsers(users)) : [];
  for (const userId of switchedOff) await publishUserAuthChange(userId, APP_PASSWORDS_DISABLED_REASON);
  await publishPolicyReload();
  if (users.length > 0) announceUserEvent(users.map((u) => u.id), { type: 'settings', section: 'policies' });
  const after = await readWebmailPolicyLevel(scope);
  if (!after) return null;
  log.info({ scope, users: users.length, appPasswordsDisabled: switchedOff.length }, 'Webmail policy changed');
  return { before: current.settings, after, users: users.length, appPasswordsDisabled: switchedOff.length };
}

// ─── External images: trusted senders ────────────────────────────────────────

/** Max. trusted senders per user. */
export const MAX_TRUSTED_SENDERS = 500;

/**
 * A trusted sender entry: a lower-case address, or "@domain" for a whole
 * domain ("domain" alone is accepted as "@domain"). null when invalid.
 */
export function normalizeTrustedSender(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 254 || /[\s<>()[\]\\,;:"]/.test(s)) return null;
  const domainRe = /^(?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+[a-z0-9¡-￿-]{2,63}$/;
  const at = s.lastIndexOf('@');
  if (at < 0) return domainRe.test(s) ? `@${s}` : null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!domainRe.test(domain)) return null;
  if (at === 0) return `@${domain}`;
  return local.length <= 64 && !local.includes('@') ? `${local}@${domain}` : null;
}

/** True when `address` matches an entry (exact address, or its domain as "@domain"). */
export function matchesTrustedSender(entries: Iterable<string>, address: string): boolean {
  const a = address.trim().toLowerCase();
  const domain = a.slice(a.lastIndexOf('@') + 1);
  for (const e of entries) if (e === a || e === `@${domain}`) return true;
  return false;
}

/** What the webmail does with the external images of one mail. */
export type ExternalImageDecision = 'load' | 'ask' | 'block';

/** Pure decision: block mode blocks; a trusted sender loads; contacts mode loads for known senders; else ask. */
export function decideExternalImages(mode: ExternalImageMode, trusted: boolean, inContacts: boolean): ExternalImageDecision {
  if (mode === 'block') return 'block';
  if (trusted) return 'load';
  return mode === 'contacts' && inContacts ? 'load' : 'ask';
}

export async function listTrustedSenders(userId: string): Promise<string[]> {
  const rows = await prisma.trustedImageSender.findMany({ where: { userId }, select: { sender: true }, orderBy: { sender: 'asc' } });
  return rows.map((r) => r.sender);
}

export type TrustedSenderAddResult = { ok: true; sender: string } | { ok: false; reason: 'invalid' | 'limit' };

export async function addTrustedSender(userId: string, raw: string): Promise<TrustedSenderAddResult> {
  const sender = normalizeTrustedSender(raw);
  if (!sender) return { ok: false, reason: 'invalid' };
  const existing = await prisma.trustedImageSender.findFirst({ where: { userId, sender }, select: { id: true } });
  if (existing) return { ok: true, sender };
  if (await prisma.trustedImageSender.count({ where: { userId } }) >= MAX_TRUSTED_SENDERS) return { ok: false, reason: 'limit' };
  await prisma.trustedImageSender.create({ data: { userId, sender } });
  return { ok: true, sender };
}

/** Removes an entry; false when it did not exist. */
export async function removeTrustedSender(userId: string, raw: string): Promise<boolean> {
  const sender = normalizeTrustedSender(raw);
  if (!sender) return false;
  const { count } = await prisma.trustedImageSender.deleteMany({ where: { userId, sender } });
  return count > 0;
}

/** The decision for a mail from `fromAddr` read by `userId` under the user's policy. */
export async function externalImageDecisionFor(subject: PolicySubject, fromAddr: string): Promise<ExternalImageDecision> {
  const userId = typeof subject === 'string' ? subject : subject.id;
  const policy = await effectiveWebmailPolicy(subject);
  const mode = policy.content.externalImages;
  if (mode === 'block') return 'block';
  const address = fromAddr.trim().toLowerCase();
  if (!address) return 'ask';
  const trusted = matchesTrustedSender(await listTrustedSenders(userId), address);
  const inContacts = !trusted && mode === 'contacts' && policy.features.contacts
    && (await prisma.contact.count({
      where: { userId, OR: [{ email: { equals: address, mode: 'insensitive' } }, { email2: { equals: address, mode: 'insensitive' } }] },
    })) > 0;
  return decideExternalImages(mode, trusted, inContacts);
}
