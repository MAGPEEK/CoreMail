/**
 * 10.1 personal mail templates on the REST API (loopback Express app, Prisma
 * faked via globalThis.__prisma): CRUD, ownership (404 for another user's id),
 * validation (400), the 200-template limit (409), the body size cap and the
 * list preview, and the realtime event of every successful write.
 * Run: node --import tsx --test --test-force-exit src/routes/mail-templates.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let tick = 0;
const stamp = () => new Date(1_700_000_000_000 + (++tick));

const users: Record<string, Row> = {
  u1: { id: 'u1', email: 'bob@ex.com', displayName: 'Bob', role: 'USER', active: true, domainId: 'd1' },
  u2: { id: 'u2', email: 'eve@ex.com', displayName: 'Eve', role: 'USER', active: true, domainId: 'd1' },
};
let templates: Row[] = [];
let countOverride: number | null = null;
const published: Array<{ channel: string; message: Row }> = [];
(globalThis as Record<string, unknown>)['__realtimeRedis'] = {
  publish: async (channel: string, message: string) => { published.push({ channel, message: JSON.parse(message) as Row }); },
};

const owns = (r: Row, w: Row) => r['userId'] === w['userId'] && (w['id'] === undefined || r['id'] === w['id']);

installFakePrisma({
  user: {
    findUnique: (a) => { const q = a as { where: Row; select?: Row }; const r = users[String(q.where['id'])] ?? null; return q.select ? applySelect(r, q.select) : r; },
  },
  mailTemplate: {
    findMany: (a) => {
      const q = a as { where: Row; select?: Row };
      return templates.filter((t) => owns(t, q.where))
        .sort((x, y) => String(x['name']).localeCompare(String(y['name'])))
        .map((t) => applySelect({ ...t }, q.select));
    },
    findFirst: (a) => { const q = a as { where: Row; select?: Row }; const r = templates.find((t) => owns(t, q.where)); return r ? applySelect({ ...r }, q.select) : null; },
    count: (a) => countOverride ?? templates.filter((t) => owns(t, (a as { where: Row }).where)).length,
    create: (a) => {
      const q = a as { data: Row; select?: Row };
      const r = { id: `tpl${templates.length + 1}`, createdAt: stamp(), updatedAt: stamp(), ...q.data };
      templates.push(r);
      return applySelect({ ...r }, q.select);
    },
    updateMany: (a) => {
      const q = a as { where: Row; data: Row };
      const r = templates.find((t) => owns(t, q.where));
      if (!r) return { count: 0 };
      Object.assign(r, q.data, { updatedAt: stamp() });
      return { count: 1 };
    },
    deleteMany: (a) => {
      const w = (a as { where: Row }).where;
      const n = templates.length;
      templates = templates.filter((t) => !owns(t, w));
      return { count: n - templates.length };
    },
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mailTemplatesRouter } = await import('./mail-templates.js');
const { previewOf, MAX_TEMPLATE_BODY_BYTES } = await import('../lib/mail-templates.js');

const tok = (sub: string) => core.signAccessToken({ sub, email: `${sub}@ex.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/mail/templates', mailTemplatesRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => { templates = []; countOverride = null; published.length = 0; });

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const r = await fetch(`${base}/api/v1/mail/templates${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

const sample = {
  name: 'Angebot', subject: 'Ihr Angebot', bodyHtml: '<p>Guten Tag,</p><p>anbei das Angebot.</p>',
  bodyText: 'Guten Tag,\n\nanbei das Angebot.', to: ['Kunde <kunde@example.org>'], cc: [], bcc: ['archiv@example.org'],
};

test('templates: create, list with preview, read, update, delete', async () => {
  const t = tok('u1');
  const created = await call('POST', '/', { token: t, body: sample });
  assert.equal(created.status, 201);
  const id = String(created.json['id']);
  assert.deepEqual(created.json['to'], ['Kunde <kunde@example.org>']);
  assert.deepEqual(created.json['bcc'], ['archiv@example.org']);

  const list = await call('GET', '/', { token: t });
  assert.equal(list.status, 200);
  assert.equal(list.json['max'], 200);
  const rows = list.json['templates'] as Row[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['name'], 'Angebot');
  assert.equal(rows[0]!['preview'], 'Guten Tag, anbei das Angebot.');
  assert.equal(rows[0]!['bodyHtml'], undefined, 'the list carries no body');

  const one = await call('GET', `/${id}`, { token: t });
  assert.equal(one.json['bodyHtml'], sample.bodyHtml);

  const upd = await call('PUT', `/${id}`, { token: t, body: { subject: 'Neues Angebot', cc: ['chef@example.org'] } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json['subject'], 'Neues Angebot');
  assert.equal(upd.json['name'], 'Angebot', 'fields not given stay');
  assert.deepEqual(upd.json['cc'], ['chef@example.org']);

  assert.equal((await call('DELETE', `/${id}`, { token: t })).status, 200);
  assert.equal((await call('GET', `/${id}`, { token: t })).status, 404);
  assert.equal((await call('DELETE', `/${id}`, { token: t })).status, 404);
});

test('templates: another user\'s template answers 404 everywhere and stays untouched', async () => {
  const id = String((await call('POST', '/', { token: tok('u1'), body: sample })).json['id']);
  const eve = tok('u2');
  assert.equal((await call('GET', `/${id}`, { token: eve })).status, 404);
  assert.equal((await call('PUT', `/${id}`, { token: eve, body: { name: 'gekapert' } })).status, 404);
  assert.equal((await call('DELETE', `/${id}`, { token: eve })).status, 404);
  assert.equal(((await call('GET', '/', { token: eve })).json['templates'] as Row[]).length, 0);
  assert.equal(templates[0]!['name'], 'Angebot');
});

test('templates: 401 without a token', async () => {
  assert.equal((await call('GET', '/')).status, 401);
  assert.equal((await call('POST', '/', { body: sample })).status, 401);
});

test('templates: validation errors answer 400 with the failing field', async () => {
  const t = tok('u1');
  const cases: Array<[Row, string]> = [
    [{ ...sample, name: '' }, 'name'],
    [{ ...sample, name: 'x'.repeat(101) }, 'name'],
    [{ ...sample, to: ['kein-gueltiger-empfaenger'] }, 'to'],
    [{ ...sample, bcc: ['a@b.example', 'Name <ohne-at>'] }, 'bcc'],
    [{ ...sample, subject: 'Zeile\r\nBcc: x@y.example' }, 'subject'],
    [{ ...sample, bodyHtml: 'x'.repeat(MAX_TEMPLATE_BODY_BYTES + 1) }, 'bodyHtml'],
    [{ ...sample, attachments: [] }, ''],
  ];
  for (const [body, field] of cases) {
    const r = await call('POST', '/', { token: t, body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json['code'], 'TEMPLATE_INVALID');
    assert.ok((r.json['details'] as Row[]).some((d) => d['field'] === field), `field ${field}`);
  }
  // the size cap counts bytes: 128 Ki of a 2-byte character is 256 KB exactly
  assert.equal((await call('POST', '/', { token: t, body: { ...sample, bodyHtml: 'ä'.repeat(MAX_TEMPLATE_BODY_BYTES / 2) } })).status, 201);
  assert.equal((await call('POST', '/', { token: t, body: { ...sample, bodyHtml: 'ä'.repeat(MAX_TEMPLATE_BODY_BYTES / 2 + 1) } })).status, 400);
  const id = String(templates[0]!['id']);
  assert.equal((await call('PUT', `/${id}`, { token: t, body: { name: '   ' } })).status, 400);
  assert.equal((await call('PUT', `/${id}`, { token: t, body: { ownerId: 'u2' } })).status, 400);
});

test('templates: only a name is required; the rest defaults to empty', async () => {
  const r = await call('POST', '/', { token: tok('u1'), body: { name: '  Kurz  ' } });
  assert.equal(r.status, 201);
  assert.equal(r.json['name'], 'Kurz');
  assert.equal(r.json['subject'], '');
  assert.deepEqual(r.json['to'], []);
});

test('templates: the 201st template is refused with 409 TEMPLATE_LIMIT', async () => {
  countOverride = 200;
  const r = await call('POST', '/', { token: tok('u1'), body: sample });
  assert.equal(r.status, 409);
  assert.equal(r.json['code'], 'TEMPLATE_LIMIT');
  assert.equal(templates.length, 0);
  countOverride = 199;
  assert.equal((await call('POST', '/', { token: tok('u1'), body: sample })).status, 201);
});

test('templates: successful writes reach the other tabs as settings/templates; reads and refusals do not', async () => {
  const t = tok('u1');
  const id = String((await call('POST', '/', { token: t, body: sample })).json['id']);
  await call('GET', '/', { token: t });
  await call('PUT', `/${id}`, { token: t, body: { name: '' } }); // 400
  await call('PUT', `/${id}`, { token: t, body: { name: 'Neu' } });
  await call('DELETE', `/${id}`, { token: t });
  await new Promise((r) => setTimeout(r, 20));
  const mine = published.filter((p) => p.channel === core.userEventsChannel('u1')).map((p) => p.message);
  assert.deepEqual(mine, [
    { type: 'settings', action: 'create', section: 'templates' },
    { type: 'settings', action: 'update', section: 'templates' },
    { type: 'settings', action: 'delete', section: 'templates' },
  ]);
});

test('previewOf: one line, whitespace folded, cut with an ellipsis', () => {
  assert.equal(previewOf('  a\n\n b\t c '), 'a b c');
  const long = previewOf('x'.repeat(500));
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
});
