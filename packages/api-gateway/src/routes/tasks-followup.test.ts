/**
 * 9.4: REST task form (status rules, recurring tasks) and follow-up flags of mails.
 * Express app on a loopback port, Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test --test-force-exit src/routes/tasks-followup.test.ts  (in packages/api-gateway)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const tasks: Row[] = [];
const messages: Row[] = [
  { id: 'm1', folderId: 'inbox', subject: 'Angebot', fromName: 'Bob', fromAddr: 'bob@example.com', date: new Date('2026-03-01T09:00:00Z'), flags: ['\\Seen'], flagStatus: 'none', deletedAt: null, modSeq: 1n, folder: { displayName: 'Posteingang' } },
  { id: 'm2', folderId: 'inbox', subject: 'Alt', fromName: 'Carol', fromAddr: 'carol@example.com', date: new Date('2026-02-01T09:00:00Z'), flags: ['\\Flagged'], flagStatus: 'none', deletedAt: null, modSeq: 2n, folder: { displayName: 'Posteingang' } },
  { id: 'foreign', folderId: 'other', subject: 'x', flags: [], flagStatus: 'none', deletedAt: null, modSeq: 1n },
];
const mailbox = { id: 'mb1', uidNext: 10, highestModSeq: 5n };
let seq = 0;

const pick = (row: Row, select?: Row): Row => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });

installFakePrisma({
  task: {
    findFirst: (a) => tasks.find((t) => t['id'] === (a as { where: Row }).where['id'] && t['userId'] === 'alice') ?? null,
    findMany: () => tasks.map((t) => ({ ...t })),
    create: (a) => { const row = { id: `t${++seq}`, createdAt: new Date(), ...(a as { data: Row }).data }; tasks.push(row); return row; },
    update: (a) => { const { where, data } = a as { where: Row; data: Row }; const row = tasks.find((t) => t['id'] === where['id'])!; Object.assign(row, data); return { ...row }; },
  },
  mailbox: {
    findFirst: () => ({ id: 'mb1' }),
    update: (a) => {
      const data = (a as { data: Row }).data;
      mailbox.highestModSeq += 1n;
      if (data['uidNext']) mailbox.uidNext += 1;
      return { uidNext: mailbox.uidNext, highestModSeq: mailbox.highestModSeq };
    },
    updateMany: () => ({ count: 0 }),
  },
  message: {
    aggregate: () => ({ _max: { modSeq: 2n, uid: 2 } }),
    findMany: (a) => {
      const { where, select } = a as { where: Row; select?: Row };
      const ids = (where['id'] as { in?: string[] } | undefined)?.in;
      const inMailbox = messages.filter((m) => m['folderId'] === 'inbox');
      const rows = ids ? inMailbox.filter((m) => ids.includes(m['id'] as string)) : inMailbox.filter((m) =>
        m['flagStatus'] === 'flagged' || m['flagStatus'] === 'complete' || (m['flags'] as string[]).includes('\\Flagged'));
      return rows.map((r) => pick(r, select));
    },
    update: (a) => { const { where, data } = a as { where: Row; data: Row }; const row = messages.find((m) => m['id'] === where['id'])!; Object.assign(row, data); return { ...row }; },
  },
});

const express = (await import('express')).default;
const { signAccessToken } = await import('@coremail/core');
const { tasksRouter } = await import('./tasks.js');
const { followUpRouter } = await import('./follow-up-flags.js');

const token = signAccessToken({ sub: 'alice', email: 'alice@example.com', role: 'USER', domainId: 'd1', sessionId: 's1', mfaVerified: false });
let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1/mail/follow-up', followUpRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('tasks: full form fields are stored; percent drives the status', async () => {
  const r = await call('POST', '/tasks', {
    subject: 'Bericht', startDate: '2026-03-02T00:00:00.000Z', dueDate: '2026-03-06T00:00:00.000Z',
    percentComplete: 25, isPrivate: true, totalWorkMinutes: 240, actualWorkMinutes: 60,
    mileage: '42 km', billingInfo: 'Projekt A', companies: 'Beispiel GmbH', bodyHtml: '<p><b>Notiz</b></p>', body: 'Notiz',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'IN_PROGRESS');
  assert.equal(r.json.percentComplete, 25);
  assert.equal(r.json.isPrivate, true);
  assert.equal(r.json.totalWorkMinutes, 240);
  assert.equal(r.json.companies, 'Beispiel GmbH');
  const waiting = await call('PUT', `/tasks/${r.json.id}`, { status: 'WAITING' });
  assert.equal(waiting.json.status, 'WAITING');
  assert.equal(waiting.json.percentComplete, 25);
  const done = await call('PUT', `/tasks/${r.json.id}`, { percentComplete: 100 });
  assert.equal(done.json.status, 'COMPLETED');
  assert.ok(done.json.completedAt);
  const reopened = await call('PUT', `/tasks/${r.json.id}`, { status: 'NOT_STARTED' });
  assert.equal(reopened.json.percentComplete, 0);
  assert.equal(reopened.json.completedAt, null);
  assert.equal((await call('POST', '/tasks', { subject: 'x', status: 'BOGUS' })).status, 400);
  assert.equal((await call('POST', '/tasks', { subject: 'x', rrule: 'FREQ=DAILY\r\nX:1' })).status, 400);
});

test('tasks: completing a recurring task creates the next occurrence and closes this one', async () => {
  const r = await call('POST', '/tasks', { subject: 'Wochenbericht', dueDate: '2026-03-06T00:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=FR' });
  const done = await call('PUT', `/tasks/${r.json.id}`, { status: 'COMPLETED' });
  assert.equal(done.status, 200);
  assert.equal(done.json.rrule, null);
  assert.equal(done.json.next.subject, 'Wochenbericht');
  assert.equal(done.json.next.dueDate, '2026-03-13T00:00:00.000Z');
  assert.equal(done.json.next.status, 'NOT_STARTED');
  assert.equal(done.json.next.rrule, 'FREQ=WEEKLY;BYDAY=FR');
});

test('follow-up: flag with due date sets \\Flagged; complete clears it; the list derives legacy rows', async () => {
  const flagged = await call('PUT', '/mail/follow-up', { ids: ['m1', 'foreign'], status: 'flagged', dueAt: '2026-03-06T00:00:00.000Z' });
  assert.equal(flagged.status, 200);
  assert.equal(flagged.json.count, 1, 'messages of other mailboxes are ignored');
  const m1 = messages.find((m) => m['id'] === 'm1')!;
  assert.deepEqual(m1['flags'], ['\\Seen', '\\Flagged']);
  assert.equal(m1['flagStatus'], 'flagged');
  assert.equal(m1['modSeq'], 6n);

  const list = await call('GET', '/mail/follow-up');
  assert.deepEqual(list.json.map((x: any) => [x.id, x.flagStatus]), [['m1', 'flagged'], ['m2', 'flagged']]);
  assert.equal(list.json[0].folderName, 'Posteingang');

  const done = await call('PUT', '/mail/follow-up', { ids: ['m1'], status: 'complete' });
  assert.equal(done.status, 200);
  assert.deepEqual(m1['flags'], ['\\Seen']);
  assert.equal(m1['flagStatus'], 'complete');
  assert.ok(m1['flagCompletedAt'] instanceof Date);
  assert.equal((m1['flagDueAt'] as Date).toISOString(), '2026-03-06T00:00:00.000Z', 'due date kept');

  assert.equal((await call('PUT', '/mail/follow-up', { ids: [], status: 'flagged' })).status, 400);
  assert.equal((await call('GET', '/mail/follow-up?status=bogus')).status, 400);
});
