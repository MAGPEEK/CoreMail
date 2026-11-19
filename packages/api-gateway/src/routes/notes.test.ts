/**
 * 9.5: notes keep their colour and get categories (validated, de-duplicated, filterable).
 * Run: node --import tsx --test src/routes/notes.test.ts  (in packages/api-gateway)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../test-support/fake-prisma.js';
import { noProtocolPolicies } from '@coremail/storage/auth/testing';

setTestEnv();

type Row = Record<string, unknown>;
const notes: Row[] = [];
const queries: Row[] = [];
let seq = 0;
const matches = (r: Row, w: Row): boolean => Object.entries(w).every(([k, v]) => {
  if (k === 'OR') return true;
  if (v && typeof v === 'object' && 'has' in (v as Row)) return (r[k] as string[]).includes(String((v as Row)['has']));
  return r[k] === v;
});
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  ...noProtocolPolicies(),
  note: {
    findMany: async (a: { where: Row }) => { queries.push(a.where); return notes.filter((n) => matches(n, a.where)); },
    findFirst: async (a: { where: Row }) => notes.find((n) => matches(n, a.where)) ?? null,
    create: async (a: { data: Row }) => { const row = { id: `n${++seq}`, ...a.data, updatedAt: new Date() }; notes.push(row); return row; },
    update: async (a: { where: Row; data: Row }) => Object.assign(notes.find((n) => matches(n, a.where))!, a.data),
    delete: async () => ({}),
  },
};

const express = (await import('express')).default;
const { signAccessToken } = await import('@coremail/core');
const { notesRouter } = await import('./notes.js');
const token = signAccessToken({ sub: 'alice', email: 'alice@example.com', role: 'USER', domainId: 'd1', sessionId: 's1', mfaVerified: false });

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/notes', notesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/notes`;
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

test('create with colour + categories; categories trimmed and de-duplicated; list carries them', async () => {
  const r = await call('POST', '/', { subject: 'Einkauf', color: 'GREEN', categories: [' Privat ', 'privat', 'Haushalt'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.categories, ['Privat', 'Haushalt']);
  assert.equal(r.json.color, 'GREEN');
  const list = await call('GET', '/');
  assert.deepEqual(list.json[0].categories, ['Privat', 'Haushalt']);
  const plain = await call('POST', '/', { subject: 'Ohne' });
  assert.deepEqual([plain.json.color, plain.json.categories], ['YELLOW', []]);
});

test('update changes only what is sent; category filter; invalid colour / categories → 400', async () => {
  const id = notes[0]!['id'] as string;
  const r = await call('PUT', `/${id}`, { categories: ['Arbeit'] });
  assert.deepEqual([r.json.subject, r.json.color, r.json.categories], ['Einkauf', 'GREEN', ['Arbeit']]);
  await call('GET', '/?category=Arbeit');
  assert.deepEqual(queries.at(-1)!['categories'], { has: 'Arbeit' });
  assert.equal((await call('PUT', `/${id}`, { color: 'ORANGE' })).status, 400);
  assert.equal((await call('POST', '/', { subject: 'x', categories: ['ok', ''] })).status, 400);
  assert.equal((await call('POST', '/', { subject: 'x', categories: ['a\nb'] })).status, 400);
});

// Review 9.5: colours stored before the validation (any string was accepted) stay saveable
test('a note with a pre-9.5 colour can be saved with that colour; known colours are case-insensitive', async () => {
  notes.push({ id: 'old-1', userId: 'alice', subject: 'Alt', body: '', color: 'white', categories: [], updatedAt: new Date() });
  const same = await call('PUT', '/old-1', { subject: 'Alt 2', body: '', color: 'white', categories: [] });
  assert.equal(same.status, 200);
  assert.deepEqual([same.json.subject, same.json.color], ['Alt 2', 'white']);
  assert.equal((await call('PUT', '/old-1', { color: 'black' })).status, 400);
  const lower = await call('PUT', '/old-1', { color: 'blue' });
  assert.equal(lower.json.color, 'BLUE');
  const created = await call('POST', '/', { subject: 'klein', color: 'pink' });
  assert.deepEqual([created.status, created.json.color], [201, 'PINK']);
  const refused = await call('POST', '/', { subject: 'x', color: 'ORANGE' });
  assert.deepEqual([refused.status, refused.json.field], [400, 'color']);
});
