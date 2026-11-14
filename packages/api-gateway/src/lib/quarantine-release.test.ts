/**
 * BCP quarantine release: re-injection via 'smtp-outbound', idempotency, rollback.
 * Run: node --import tsx --test src/lib/quarantine-release.test.ts  (in packages/api-gateway)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { releaseQuarantine, ReleaseError } = await import('./quarantine-release.js');
type Deps = Parameters<typeof releaseQuarantine>[2];
type Job = Parameters<Deps['enqueue']>[0];

const RAW = Buffer.from('X-CoreMail-Quarantine-Released: stale\r\nSubject: Invoice\r\n\r\nbody\r\n');

interface Row {
  id: string; fromAddr: string; toAddr: string; subject: string; reason: string; details: unknown;
  rawPath: string; released: boolean; releasedAt?: Date | null; releasedBy?: string | null;
}
let rows: Map<string, Row>;
let jobs: Job[];
let failEnqueue: boolean;

function deps(): Deps {
  return {
    findById: async (id) => rows.get(id) ?? null,
    claim: async (id, by, at) => {
      const r = rows.get(id);
      if (!r || r.released) return 0;
      Object.assign(r, { released: true, releasedBy: by, releasedAt: at });
      return 1;
    },
    unclaim: async (id) => { Object.assign(rows.get(id)!, { released: false, releasedBy: null, releasedAt: null }); },
    download: async (path) => { if (path !== 'quarantine/q1.eml') throw new Error('missing'); return RAW; },
    enqueue: async (job) => { if (failEnqueue) throw new Error('redis down'); jobs.push(job); return `job-${jobs.length}`; },
    isLocalAddress: async (a) => a.endsWith('@corp.test'),
  };
}

beforeEach(() => {
  jobs = [];
  failEnqueue = false;
  rows = new Map([['q1', {
    id: 'q1', fromAddr: 'sender@ext.test', toAddr: 'bob@corp.test', subject: 'Invoice', reason: 'VIRUS',
    details: { virusName: 'EICAR', envelope: { from: 'sender@ext.test', recipients: ['bob@corp.test', 'partner@ext.test'] } },
    rawPath: 'quarantine/q1.eml', released: false,
  }]]);
});

test('release re-injects the raw message for all original recipients and records releasedBy/At', async () => {
  const res = await releaseQuarantine('q1', 'admin-1', deps());
  assert.deepEqual(res.local, ['bob@corp.test']);
  assert.deepEqual(res.external, ['partner@ext.test']);
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.equal(job.from, 'sender@ext.test');
  assert.deepEqual(job.to, ['bob@corp.test', 'partner@ext.test']);
  assert.equal(job.quarantineReleaseId, 'q1');           // internal flag → worker skips re-quarantine
  const raw = Buffer.from(job.rawMessage, 'base64').toString();
  assert.equal(raw, 'X-CoreMail-Quarantine-Released: q1\r\nSubject: Invoice\r\n\r\nbody\r\n');
  const row = rows.get('q1')!;
  assert.equal(row.released, true);
  assert.equal(row.releasedBy, 'admin-1');
  assert.ok(row.releasedAt instanceof Date);
});

test('second release → 409, no second job', async () => {
  await releaseQuarantine('q1', 'admin-1', deps());
  await assert.rejects(releaseQuarantine('q1', 'admin-2', deps()), (e: unknown) => e instanceof ReleaseError && e.status === 409);
  assert.equal(jobs.length, 1);
  assert.equal(rows.get('q1')!.releasedBy, 'admin-1');
});

test('concurrent release: only one claim wins', async () => {
  const results = await Promise.allSettled([releaseQuarantine('q1', 'a', deps()), releaseQuarantine('q1', 'b', deps())]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(jobs.length, 1);
});

test('legacy record without envelope → falls back to fromAddr/toAddr', async () => {
  rows.get('q1')!.details = { virusName: 'EICAR' };
  await releaseQuarantine('q1', 'admin-1', deps());
  assert.deepEqual(jobs[0]!.to, ['bob@corp.test']);
  assert.equal(jobs[0]!.from, 'sender@ext.test');
});

test('unknown id → 404; missing raw → 502 and not marked released', async () => {
  await assert.rejects(releaseQuarantine('nope', 'a', deps()), (e: unknown) => e instanceof ReleaseError && e.status === 404);
  rows.get('q1')!.rawPath = 'quarantine/gone.eml';
  await assert.rejects(releaseQuarantine('q1', 'a', deps()), (e: unknown) => e instanceof ReleaseError && e.status === 502);
  assert.equal(rows.get('q1')!.released, false);
});

test('queue failure rolls the claim back (release can be retried)', async () => {
  failEnqueue = true;
  await assert.rejects(releaseQuarantine('q1', 'a', deps()), (e: unknown) => e instanceof ReleaseError && e.status === 503);
  assert.equal(rows.get('q1')!.released, false);
  failEnqueue = false;
  await releaseQuarantine('q1', 'a', deps());
  assert.equal(jobs.length, 1);
});
