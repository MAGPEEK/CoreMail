/**
 * zod 4 migration guards: PATCH bodies keep omitted fields omitted (zod 4 applies
 * `.default()` inside `.partial()`), date-times without seconds stay valid, address
 * validation accepts/rejects the same addresses as zod 3, and the 400 body keeps
 * its `{ error, details: [{ code, path, message }] }` envelope.
 * Run: node --import tsx --test src/lib/zod-compat.test.ts  (in packages/api-gateway)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { noProtocolPolicies } from '@coremail/storage/auth/testing';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

type Row = Record<string, unknown>;
const updates: Array<{ model: string; data: Row }> = [];
const rows: Record<string, Row> = {
  t1: { id: 't1', userId: 'alice', subject: 'Old', priority: 'HIGH', status: 'IN_PROGRESS', body: 'keep', reminderByMail: true },
  n1: { id: 'n1', userId: 'alice', subject: 'Old', body: 'keep', color: 'BLUE' },
};
const model = (name: string) => ({
  findFirst: async (a: { where: Row }) => {
    const r = rows[String(a.where['id'])];
    return r && r['userId'] === a.where['userId'] ? r : null;
  },
  update: async (a: { where: Row; data: Row }) => {
    updates.push({ model: name, data: a.data });
    return { ...rows[String(a.where['id'])], ...a.data };
  },
  create: async (a: { data: Row }) => ({ id: 'new', ...a.data }),
});
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined, ...noProtocolPolicies(), task: model('task'), note: model('note'),
};

const { z } = await import('zod');
const { patchSchema, isoDateTime } = await import('./zod-compat.js');
const express = (await import('express')).default;
const { signAccessToken } = await import('@coremail/core');
const { tasksRouter } = await import('../routes/tasks.js');
const { notesRouter } = await import('../routes/notes.js');

const token = signAccessToken({ sub: 'alice', email: 'alice@example.com', role: 'USER', domainId: 'd1', sessionId: 's1', mfaVerified: false });
let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1/notes', notesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('patchSchema: omitted fields stay omitted, given fields are still validated', () => {
  const S = z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    body: z.string().optional().default(''),
    tags: z.array(z.string()).default([]),
  });
  assert.deepEqual(S.partial().parse({}), { enabled: true, body: '', tags: [] }, 'zod 4 .partial() applies defaults');
  assert.deepEqual(patchSchema(S).parse({}), {});
  assert.deepEqual(patchSchema(S).parse({ enabled: false }), { enabled: false });
  assert.equal(patchSchema(S).safeParse({ name: '' }).success, false);
  assert.equal(patchSchema(S).safeParse({ enabled: 'yes' }).success, false);
  // the create schema keeps its defaults
  assert.deepEqual(S.parse({ name: 'x' }), { name: 'x', enabled: true, body: '', tags: [] });
});

test('PUT /tasks/:id with one field does not reset priority/status/body/reminderByMail', async () => {
  updates.length = 0;
  const r = await call('PUT', '/tasks/t1', { subject: 'New' });
  assert.equal(r.status, 200);
  assert.deepEqual(updates[0], { model: 'task', data: { subject: 'New' } });
});

test('PUT /notes/:id with one field does not reset body/color', async () => {
  updates.length = 0;
  const r = await call('PUT', '/notes/n1', { subject: 'New' });
  assert.equal(r.status, 200);
  assert.deepEqual(updates[0], { model: 'note', data: { subject: 'New' } });
});

test('400 body keeps the { error, details: [{ code, path, message }] } envelope', async () => {
  const r = await call('POST', '/tasks', { subject: '', priority: 'URGENT' });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.json).sort(), ['details', 'error']);
  assert.equal(r.json.error, 'Invalid request');
  assert.ok(Array.isArray(r.json.details) && r.json.details.length === 2);
  for (const issue of r.json.details) {
    assert.equal(typeof issue.code, 'string');
    assert.equal(typeof issue.message, 'string');
    assert.ok(Array.isArray(issue.path));
    assert.equal('input' in issue, false, 'issues must not echo the input');
  }
  assert.deepEqual(r.json.details.map((i: { path: string[] }) => i.path[0]).sort(), ['priority', 'subject']);
});

test('isoDateTime accepts zod 3 forms (seconds optional), rejects offsets and garbage', () => {
  for (const ok of ['2026-01-01T08:00:00Z', '2026-01-01T08:00:00.123Z', '2026-01-01T08:00Z']) {
    assert.equal(isoDateTime().safeParse(ok).success, true, ok);
  }
  for (const bad of ['2026-01-01T08:00:00+01:00', '2026-01-01', '2026-01-01 08:00:00Z', 'tomorrow', '']) {
    assert.equal(isoDateTime().safeParse(bad).success, false, bad);
  }
});

test('z.string().email() accepts and rejects the same addresses as zod 3', () => {
  const accepted = ['user@example.com', 'a.b+tag@sub.example.co.uk', "o'brien@example.com", 'USER@EXAMPLE.COM',
    'user@xn--mnchen-3ya.de', '_u@example.com', 'u-@example.com'];
  // zod 3 already rejected these (ASCII-only dot-atom, letters-only TLD, no IP literals/quoted local parts);
  // SMTPUTF8/IDN addresses are validated by the mail paths, not by these REST schemas.
  const rejected = ['postmaster@example.xn--p1ai', 'user@münchen.de', 'jörg@example.de', 'user@localhost', 'user@[192.168.0.1]', '"quoted"@example.com',
    '.user@example.com', 'user.@example.com', 'us..er@example.com', 'user@-example.com', 'user@example.c', ' user@example.com'];
  for (const a of accepted) assert.equal(z.string().email().safeParse(a).success, true, a);
  for (const a of rejected) assert.equal(z.string().email().safeParse(a).success, false, a);
});
