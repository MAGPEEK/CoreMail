/**
 * DKIM key resolution for outbound jobs without DKIM fields
 * (SMTP submission 465/587, rule forwards, EAS).
 * Run: node --import tsx --test src/outbound/dkim.test.ts  (in packages/smtp-server)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

interface Row { name: string; dkimSelector: string; dkimPrivateKey: string }
let domains: Row[] = [];
let lookups: string[] = [];
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  domain: {
    findUnique: async ({ where }: { where: { name: string } }) => {
      lookups.push(where.name);
      return domains.find((d) => d.name === where.name) ?? null;
    },
  },
};

const { pickDkim, resolveJobDkim, senderDomain, hasCompleteDkim } = await import('./dkim.js');

const KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';

beforeEach(() => { domains = []; lookups = []; });

test('senderDomain lower-cases and handles null sender / malformed', () => {
  assert.equal(senderDomain('Alice@Example.COM'), 'example.com');
  assert.equal(senderDomain(''), '');
  assert.equal(senderDomain('no-at-sign'), '');
  assert.equal(senderDomain('<bob@firma.de>'), 'firma.de');
});

test('pickDkim keeps a complete DKIM triple from the job', () => {
  const job = { dkimDomain: 'a.test', dkimSelector: 's1', dkimPrivateKey: KEY };
  assert.ok(hasCompleteDkim(job));
  assert.deepEqual(pickDkim(job, { name: 'b.test', dkimSelector: 'x', dkimPrivateKey: 'other' }), job);
});

test('pickDkim falls back to the domain row and ignores empty keys', () => {
  assert.deepEqual(pickDkim({}, { name: 'a.test', dkimSelector: 'coremail', dkimPrivateKey: KEY }),
    { dkimDomain: 'a.test', dkimSelector: 'coremail', dkimPrivateKey: KEY });
  assert.deepEqual(pickDkim({}, { name: 'a.test', dkimSelector: 'coremail', dkimPrivateKey: '  ' }), {});
  assert.deepEqual(pickDkim({}, null), {});
  // incomplete job fields are not trusted half-way
  assert.deepEqual(pickDkim({ dkimDomain: 'evil.test' }, { name: 'a.test', dkimSelector: 'd', dkimPrivateKey: KEY }),
    { dkimDomain: 'a.test', dkimSelector: 'd', dkimPrivateKey: KEY });
});

test('resolveJobDkim looks up the envelope-from domain when the job has no key', async () => {
  domains = [{ name: 'firma.de', dkimSelector: 'default', dkimPrivateKey: KEY }];
  const dkim = await resolveJobDkim({ from: 'User@Firma.de' });
  assert.deepEqual(dkim, { dkimDomain: 'firma.de', dkimSelector: 'default', dkimPrivateKey: KEY });
  assert.deepEqual(lookups, ['firma.de']);
});

test('resolveJobDkim: external sender (redirect) and null sender stay unsigned', async () => {
  domains = [{ name: 'firma.de', dkimSelector: 'default', dkimPrivateKey: KEY }];
  assert.deepEqual(await resolveJobDkim({ from: 'someone@gmail.com' }), {});
  assert.deepEqual(await resolveJobDkim({ from: '' }), {});
  assert.deepEqual(lookups, ['gmail.com']);
});

test('resolveJobDkim skips the DB when the job already carries DKIM', async () => {
  const job = { from: 'u@firma.de', dkimDomain: 'firma.de', dkimSelector: 'sel', dkimPrivateKey: KEY };
  assert.deepEqual(await resolveJobDkim(job), { dkimDomain: 'firma.de', dkimSelector: 'sel', dkimPrivateKey: KEY });
  assert.deepEqual(lookups, []);
});
