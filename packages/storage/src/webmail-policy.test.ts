/**
 * Webmail policies (9.4): resolution server → domain → user, the upload cap,
 * validation, admin view with sources, change events + cache, trusted senders
 * and the external-image decision. Infra-free (globalThis.__prisma / __authRedis).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const { createFakePrisma, createFakeRedis } = await import('./auth/testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
const published: Array<[string, string]> = [];
Object.assign(redis, { publish: async (channel: string, message: string) => { published.push([channel, message]); return 1; } });
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const core = await import('@coremail/core');
const wp = await import('./webmail-policy.js');

beforeEach(async () => {
  for (const t of ['user', 'domain', 'webmailPolicy', 'trustedImageSender', 'contact'] as const) db[t].rows = [];
  wp.invalidateWebmailPolicyCache();
  published.length = 0;
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  await db.domain.create({ data: { id: 'd2', name: 'two.test' } });
  await db.user.create({ data: { id: 'u1', email: 'a@one.test', domainId: 'd1' } });
  await db.user.create({ data: { id: 'u2', email: 'b@two.test', domainId: 'd2' } });
});

const level = (features: Partial<Record<string, string>> = {}, content: Record<string, unknown> = {}) => {
  const l = wp.inheritAllPolicy();
  return { features: { ...l.features, ...features }, content: { ...l.content, ...content } } as never;
};

// ── Pure resolution ───────────────────────────────────────────────────────────

test('defaults: every module on, nothing blocked, images on request', () => {
  const { effective, sources } = wp.resolveWebmailPolicy([]);
  assert.ok(wp.WEBMAIL_FEATURES.every((f) => effective.features[f]));
  assert.deepEqual(effective.content, { blockedExtensions: [], downloadOnlyExtensions: [], maxUploadMb: null, externalImages: 'ask' });
  assert.equal(sources.features.calendar, 'default');
  assert.equal(sources.content.externalImages, 'default');
});

test('the most specific level wins — switches and values, with the deciding level', () => {
  const r = wp.resolveWebmailPolicy([
    level({ calendar: 'off', notes: 'off' }, { blockedExtensions: ['exe'], externalImages: 'block' }),
    level({ calendar: 'on' }, { blockedExtensions: ['js'] }),
    level({ notes: 'inherit', tasks: 'off' }, { externalImages: 'contacts' }),
  ]);
  assert.equal(r.effective.features.calendar, true);
  assert.equal(r.sources.features.calendar, 'domain');
  assert.equal(r.effective.features.notes, false);
  assert.equal(r.sources.features.notes, 'global');
  assert.equal(r.effective.features.tasks, false);
  assert.equal(r.sources.features.tasks, 'user');
  assert.deepEqual(r.effective.content.blockedExtensions, ['js']);
  assert.equal(r.effective.content.externalImages, 'contacts');
  assert.equal(r.sources.content.externalImages, 'user');
});

test('upload limit: a domain / user value is capped by the server value', () => {
  const capped = wp.resolveWebmailPolicy([level({}, { maxUploadMb: 10 }), level({}, { maxUploadMb: 50 })]);
  assert.equal(capped.effective.content.maxUploadMb, 10);
  assert.equal(capped.sources.content.maxUploadMb, 'global');
  const lower = wp.resolveWebmailPolicy([level({}, { maxUploadMb: 10 }), level(), level({}, { maxUploadMb: 3 })]);
  assert.equal(lower.effective.content.maxUploadMb, 3);
  assert.equal(lower.sources.content.maxUploadMb, 'user');
  assert.equal(wp.maxUploadBytes({ maxUploadMb: 3 }), 3 * 1024 * 1024);
  assert.equal(wp.maxUploadBytes({ maxUploadMb: null }), null);
});

test('validation: the server level is two-state and needs concrete values', () => {
  assert.throws(() => wp.assertPolicyPatch('global', { features: { calendar: 'inherit' } }), RangeError);
  assert.throws(() => wp.assertPolicyPatch('global', { content: { blockedExtensions: null } }), RangeError);
  assert.throws(() => wp.assertPolicyPatch('global', { content: { externalImages: null } }), RangeError);
  assert.doesNotThrow(() => wp.assertPolicyPatch('global', { content: { maxUploadMb: null } }));
  assert.doesNotThrow(() => wp.assertPolicyPatch('domain', { features: { calendar: 'inherit' }, content: { blockedExtensions: null } }));
  assert.throws(() => wp.assertPolicyPatch('user', { features: { bogus: 'on' } as never }), RangeError);
  assert.throws(() => wp.assertPolicyPatch('user', { content: { maxUploadMb: 0 } }), RangeError);
  assert.throws(() => wp.assertPolicyPatch('user', { content: { externalImages: 'sometimes' as never } }), RangeError);
});

// ── Storage, cache, events ────────────────────────────────────────────────────

test('effective policy per user over server, domain and user rows', async () => {
  await wp.updateWebmailPolicy({ level: 'global' }, { features: { calendar: 'off' }, content: { blockedExtensions: ['EXE', '.js'] } });
  await wp.updateWebmailPolicy({ level: 'domain', domainId: 'd1' }, { features: { calendar: 'on' } });
  await wp.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { content: { downloadOnlyExtensions: ['pdf'] } });
  const u1 = await wp.effectiveWebmailPolicy('u1');
  const u2 = await wp.effectiveWebmailPolicy({ id: 'u2', domainId: 'd2' });
  assert.equal(u1.features.calendar, true);
  assert.equal(u2.features.calendar, false);
  assert.deepEqual(u1.content.blockedExtensions, ['exe', 'js']);
  assert.deepEqual(u1.content.downloadOnlyExtensions, ['pdf']);
  assert.deepEqual(u2.content.downloadOnlyExtensions, []);
  assert.equal(await wp.isWebmailFeatureEnabled('u2', 'calendar'), false);
});

test('unknown users get no module', async () => {
  const p = await wp.effectiveWebmailPolicy('nobody');
  assert.ok(wp.WEBMAIL_FEATURES.every((f) => !p.features[f]));
});

test('a change drops the cache, signals every service and announces policies to the users in scope', async () => {
  const events: unknown[] = [];
  const restore = (globalThis as Record<string, unknown>)['__realtimeRedis'];
  (globalThis as Record<string, unknown>)['__realtimeRedis'] = {
    publish: async (channel: string, message: string) => { events.push([channel, JSON.parse(message)]); return 1; },
  };
  try {
    assert.equal((await wp.effectiveWebmailPolicy('u1')).features.rules, true);
    const r = await wp.updateWebmailPolicy({ level: 'domain', domainId: 'd1' }, { features: { rules: 'off' } });
    assert.equal(r?.users, 1);
    assert.equal((await wp.effectiveWebmailPolicy('u1')).features.rules, false); // not the cached value
    assert.ok(published.some(([c, m]) => c === core.CHANNEL_SETTINGS_RELOAD && wp.isWebmailPolicyReload(m)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(events, [['user:u1:events', { type: 'settings', section: 'policies' }]]);
  } finally {
    (globalThis as Record<string, unknown>)['__realtimeRedis'] = restore;
  }
});

test('admin view: settings, inherited, effective and sources per level', async () => {
  const server = await wp.readWebmailPolicyLevel({ level: 'global' });
  assert.equal(server?.settings.features.calendar, 'on'); // never written = default, two-state
  assert.equal(server?.sources.features.calendar, 'default');
  assert.deepEqual(server?.settings.content.blockedExtensions, []);
  await wp.updateWebmailPolicy({ level: 'global' }, { content: { externalImages: 'block' } });
  const user = await wp.readWebmailPolicyLevel({ level: 'user', userId: 'u1' });
  assert.equal(user?.settings.content.externalImages, null);
  assert.equal(user?.inherited.content.externalImages, 'block');
  assert.equal(user?.sources.content.externalImages, 'global');
  const changed = await wp.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { content: { externalImages: 'ask' } });
  assert.equal(changed?.before.content.externalImages, null);
  assert.equal(changed?.after.effective.content.externalImages, 'ask');
  assert.equal(changed?.after.sources.content.externalImages, 'user');
  assert.equal(await wp.readWebmailPolicyLevel({ level: 'domain', domainId: 'missing' }), null);
  assert.equal(await wp.updateWebmailPolicy({ level: 'user', userId: 'missing' }, { features: { notes: 'off' } }), null);
});

test('inherit resets a value (null in the row)', async () => {
  await wp.updateWebmailPolicy({ level: 'domain', domainId: 'd1' }, { content: { blockedExtensions: ['exe'], maxUploadMb: 5 } });
  await wp.updateWebmailPolicy({ level: 'domain', domainId: 'd1' }, { content: { blockedExtensions: null, maxUploadMb: null } });
  const view = await wp.readWebmailPolicyLevel({ level: 'domain', domainId: 'd1' });
  assert.equal(view?.settings.content.blockedExtensions, null);
  assert.equal(view?.settings.content.maxUploadMb, null);
  assert.equal(view?.sources.content.blockedExtensions, 'default');
});

// ── External images ───────────────────────────────────────────────────────────

test('trusted senders: addresses and domains, normalised, limited', async () => {
  assert.equal(wp.normalizeTrustedSender(' News@Example.ORG '), 'news@example.org');
  assert.equal(wp.normalizeTrustedSender('@example.org'), '@example.org');
  assert.equal(wp.normalizeTrustedSender('example.org'), '@example.org');
  assert.equal(wp.normalizeTrustedSender('bad address'), null);
  assert.equal(wp.normalizeTrustedSender('a@b'), null);
  assert.deepEqual(await wp.addTrustedSender('u1', 'News@Example.org'), { ok: true, sender: 'news@example.org' });
  assert.deepEqual(await wp.addTrustedSender('u1', 'news@example.org'), { ok: true, sender: 'news@example.org' });
  assert.deepEqual(await wp.addTrustedSender('u1', '<script>'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await wp.listTrustedSenders('u1'), ['news@example.org']);
  assert.equal(wp.matchesTrustedSender(['@example.org'], 'Someone@EXAMPLE.org'), true);
  assert.equal(wp.matchesTrustedSender(['@example.org'], 'someone@sub.example.org'), false);
  assert.equal(await wp.removeTrustedSender('u1', 'NEWS@example.org'), true);
  assert.equal(await wp.removeTrustedSender('u1', 'news@example.org'), false);
});

test('external images: block > trusted > contacts mode > ask', async () => {
  assert.equal(wp.decideExternalImages('block', true, true), 'block');
  assert.equal(wp.decideExternalImages('ask', true, false), 'load');
  assert.equal(wp.decideExternalImages('ask', false, true), 'ask');
  assert.equal(wp.decideExternalImages('contacts', false, true), 'load');
  await db.contact.create({ data: { userId: 'u1', email: 'Friend@Example.org', displayName: 'F' } });
  assert.equal(await wp.externalImageDecisionFor('u1', 'friend@example.org'), 'ask');
  await wp.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { content: { externalImages: 'contacts' } });
  assert.equal(await wp.externalImageDecisionFor('u1', 'friend@example.org'), 'load');
  assert.equal(await wp.externalImageDecisionFor('u1', 'stranger@example.org'), 'ask');
  await wp.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { features: { contacts: 'off' } });
  assert.equal(await wp.externalImageDecisionFor('u1', 'friend@example.org'), 'ask'); // contacts module off
  await wp.addTrustedSender('u1', '@example.org');
  assert.equal(await wp.externalImageDecisionFor('u1', 'stranger@example.org'), 'load');
  await wp.updateWebmailPolicy({ level: 'global' }, { content: { externalImages: 'block' } });
  await wp.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { content: { externalImages: null } });
  assert.equal(await wp.externalImageDecisionFor('u1', 'stranger@example.org'), 'block');
});
