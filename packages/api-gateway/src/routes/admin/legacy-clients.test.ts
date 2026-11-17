/**
 * Legacy clients (w1): per-listener "Ältere Clients erlauben (TLS 1.0/1.1)",
 * the HTTPS proxy switch and the device relay configuration.
 *  - allowLegacyTls defaults to off, an absent field on PUT keeps it, every
 *    change is audited (settings.* → always audited) with before/after;
 *  - device relay: never an open relay by configuration (0.0.0.0/0, foreign
 *    sender domains, submission ports, enabling without lists → 400), audited,
 *    RBAC: only write roles of the servers area.
 * Prisma faked via globalThis.__prisma, loopback Express app.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/legacy-clients.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const listeners: Row[] = [
  { id: 'l25', service: 'SMTP_RECEIVE', address: '0.0.0.0', port: 25, ssl: false, active: true, allowLegacyTls: false },
  { id: 'l993', service: 'IMAP', address: '0.0.0.0', port: 993, ssl: true, active: true, allowLegacyTls: false },
];
const audits: Row[] = [];
const settings: Row = { id: 'singleton', requireMfaForAdmins: false, httpsAllowLegacyTls: false };
let relayRow: Row | null = null;

installFakePrisma({
  user: {
    findUnique: (a) => {
      const id = String((a as { where: Row }).where['id']);
      return id.startsWith('actor-') ? { id, role: id.slice(6), active: true } : null;
    },
  },
  serverSettings: {
    findUnique: () => ({ ...settings }),
    upsert: (a) => { Object.assign(settings, (a as { update: Row }).update); return settings; },
  },
  serviceListener: {
    count: () => 1,
    findFirst: (a) => {
      const w = (a as { where: Row }).where;
      return listeners.find((l) => l['service'] === w['service'] && l['port'] === w['port']
        && (w['active'] === undefined || l['active'] === w['active'])
        && l['id'] !== (w['NOT'] as Row | undefined)?.['id']) ?? null;
    },
    findUnique: (a) => { const r = listeners.find((l) => l['id'] === (a as { where: Row }).where['id']); return r ? { ...r } : null; },
    create: (a) => { const r = { id: `new${listeners.length}`, active: true, ...(a as { data: Row }).data }; listeners.push(r); return r; },
    update: (a) => { const q = a as { where: Row; data: Row }; const r = listeners.find((l) => l['id'] === q.where['id'])!; Object.assign(r, q.data); return { ...r }; },
  },
  domain: { findMany: () => [{ name: 'example.com' }, { name: 'example.org' }] },
  deviceRelaySettings: {
    findUnique: () => relayRow,
    upsert: (a) => { relayRow = { ...(a as { create: Row }).create }; return relayRow; },
  },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { adminServicesRouter, legacyTlsAuditAction } = await import('./services.js');
const { adminSmtpConfigRouter } = await import('./smtp-config.js');
const { validateDeviceRelay, normaliseNetworks } = await import('../../lib/device-relay.js');

const tok = (role: string) => core.signAccessToken({ sub: `actor-${role}`, email: `${role}@example.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'], domainId: 'd1', sessionId: 's', mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/services', adminServicesRouter);
  app.use('/api/v1/admin/smtp-config', adminSmtpConfigRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, role: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(role)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = {} as Row;
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const lastAudit = (action: string) => [...audits].reverse().find((a) => a['action'] === action);

test('legacyTlsAuditAction: only changes are audited, under the always-audited settings.* prefix', () => {
  assert.equal(legacyTlsAuditAction(false, false), null);
  assert.equal(legacyTlsAuditAction(true, true), null);
  assert.equal(legacyTlsAuditAction(false, true), 'settings.legacy-tls.enabled');
  assert.equal(legacyTlsAuditAction(true, false), 'settings.legacy-tls.disabled');
});

test('new listener: legacy TLS off unless requested; enabling it is audited', async () => {
  const plain = await call('POST', '/api/v1/admin/services/listeners/pop3', 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 1110 });
  assert.equal(plain.status, 201);
  assert.equal(plain.json['allowLegacyTls'], false);

  const legacy = await call('POST', '/api/v1/admin/services/listeners/pop3', 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 1995, ssl: true, allowLegacyTls: true });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.json['allowLegacyTls'], true);
  await flush();
  const a = lastAudit('settings.legacy-tls.enabled');
  assert.ok(a, 'audited');
  assert.equal(a['targetName'], 'POP3 0.0.0.0:1995');
  assert.deepEqual(a['changes'], { allowLegacyTls: { from: false, to: true } });
});

test('edit listener: an absent flag keeps it, switching it off is audited', async () => {
  const l993 = listeners.find((l) => l['id'] === 'l993')!;
  l993['allowLegacyTls'] = true;
  const keep = await call('PUT', '/api/v1/admin/services/listeners/l993', 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 993, ssl: true, active: true });
  assert.equal(keep.status, 200);
  assert.equal(keep.json['allowLegacyTls'], true, 'older clients (CLI) that do not send the flag keep it');

  const off = await call('PUT', '/api/v1/admin/services/listeners/l993', 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 993, ssl: true, active: true, allowLegacyTls: false });
  assert.equal(off.json['allowLegacyTls'], false);
  await flush();
  assert.ok(lastAudit('settings.legacy-tls.disabled'));
});

test('listener flag must be a boolean', async () => {
  const r = await call('POST', '/api/v1/admin/services/listeners/imap', 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 1993, allowLegacyTls: 'yes' });
  assert.equal(r.status, 400);
});

test('HTTPS proxy: GET/PUT the legacy switch; audited; read-only role refused', async () => {
  assert.deepEqual((await call('GET', '/api/v1/admin/services/https-tls', 'SERVER_MANAGEMENT')).json, { allowLegacyTls: false });
  const on = await call('PUT', '/api/v1/admin/services/https-tls', 'SERVER_MANAGEMENT', { allowLegacyTls: true });
  assert.equal(on.status, 200);
  assert.equal(settings['httpsAllowLegacyTls'], true);
  await flush();
  assert.equal(lastAudit('settings.legacy-tls.enabled')?.['targetName'], 'HTTPS');
  assert.equal((await call('PUT', '/api/v1/admin/services/https-tls', 'VIEW_ONLY_ORG', { allowLegacyTls: false })).status, 403);
  assert.equal((await call('PUT', '/api/v1/admin/services/https-tls', 'SERVER_MANAGEMENT', {})).status, 400);
});

// ── Device relay ──────────────────────────────────────────────────────────────

const relay = (over: Partial<Parameters<typeof validateDeviceRelay>[0]> = {}) => ({
  enabled: true, allowedNetworks: ['192.168.10.0/24'], senderDomains: ['example.com'], port: 25, maxMessagesPerMinute: 30, ...over,
});

test('validateDeviceRelay: whole-internet and invalid networks are refused', () => {
  // IPv4-mapped IPv6 ranges are the IPv4 ranges they denote: ::ffff:0:0/96 = 0.0.0.0/0
  for (const nets of [['0.0.0.0/0'], ['::/0'], ['10.0.0.0/7'], ['2001:db8::/31'], ['::ffff:0:0/96'], ['::ffff:0.0.0.0/100'], ['::ffff:a00:0/103']]) {
    const r = validateDeviceRelay(relay({ allowedNetworks: nets }), ['example.com']);
    assert.equal(r.ok, false, nets.join());
  }
  const mapped = validateDeviceRelay(relay({ allowedNetworks: ['::ffff:c0a8:a00/120'] }), ['example.com']);
  assert.ok(mapped.ok);
  assert.deepEqual(mapped.value.allowedNetworks, ['192.168.10.0/24'], 'stored in its IPv4 form');
  const bad = validateDeviceRelay(relay({ allowedNetworks: ['printer.local'] }), ['example.com']);
  assert.ok(!bad.ok && /printer\.local/.test(bad.error));
  assert.deepEqual(normaliseNetworks(['10.0.0.5', ' 10.0.0.5/32 ', '']).networks, ['10.0.0.5/32']);
});

test('validateDeviceRelay: only hosted sender domains, no submission port, enabling needs both lists', () => {
  const foreign = validateDeviceRelay(relay({ senderDomains: ['example.com', 'bank.example.net'] }), ['example.com']);
  assert.ok(!foreign.ok && /bank\.example\.net/.test(foreign.error));
  assert.equal(validateDeviceRelay(relay({ port: 587 }), ['example.com']).ok, false);
  assert.equal(validateDeviceRelay(relay({ port: 465 }), ['example.com']).ok, false);
  assert.equal(validateDeviceRelay(relay({ allowedNetworks: [] }), ['example.com']).ok, false);
  assert.equal(validateDeviceRelay(relay({ senderDomains: [] }), ['example.com']).ok, false);
  assert.equal(validateDeviceRelay(relay({ enabled: false, allowedNetworks: [], senderDomains: [] }), []).ok, true, 'off = empty is fine');
  const ok = validateDeviceRelay(relay({ senderDomains: ['Example.COM.', 'example.com'], port: 2525 }), ['example.com']);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.senderDomains, ['example.com']);
});

test('device relay API: default off, save is validated + audited, listener state reported', async () => {
  const initial = await call('GET', '/api/v1/admin/smtp-config/device-relay', 'SERVER_MANAGEMENT');
  assert.equal(initial.status, 200);
  assert.equal(initial.json['enabled'], false);
  assert.deepEqual(initial.json['allowedNetworks'], []);

  const open = await call('PUT', '/api/v1/admin/smtp-config/device-relay', 'SERVER_MANAGEMENT', relay({ allowedNetworks: ['0.0.0.0/0'] }));
  assert.equal(open.status, 400);
  assert.equal(relayRow, null, 'nothing stored');

  const saved = await call('PUT', '/api/v1/admin/smtp-config/device-relay', 'SERVER_MANAGEMENT', relay());
  assert.equal(saved.status, 200);
  assert.equal(saved.json['enabled'], true);
  assert.equal(saved.json['listenerActive'], true, 'port 25 has an active inbound listener');
  await flush();
  const a = lastAudit('settings.device-relay.updated');
  assert.ok(a);
  assert.deepEqual((a['changes'] as Row)['after'], { enabled: true, allowedNetworks: ['192.168.10.0/24'], senderDomains: ['example.com'], port: 25, maxMessagesPerMinute: 30 });

  const dedicated = await call('PUT', '/api/v1/admin/smtp-config/device-relay', 'SERVER_MANAGEMENT', relay({ port: 2525 }));
  assert.equal(dedicated.json['listenerActive'], false, 'no listener on 2525 yet — the BCP shows a hint');
});

test('device relay API: read-only roles cannot change it', async () => {
  assert.equal((await call('PUT', '/api/v1/admin/smtp-config/device-relay', 'VIEW_ONLY_ORG', relay())).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/smtp-config/device-relay', 'VIEW_ONLY_ORG')).status, 200);
});
