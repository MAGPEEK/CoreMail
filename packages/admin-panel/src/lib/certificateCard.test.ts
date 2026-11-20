import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acmeDomains, pollOutcome, preflightProblems, runCertificateCard, type CardApi, type CardPhase } from './certificateCard.ts';

type Call = [method: 'GET' | 'POST', path: string, body?: unknown];

/** A scripted fake of the admin API: answers by "METHOD path", records every call. */
function fakeApi(answers: Record<string, unknown | ((n: number) => unknown)>): { api: CardApi; calls: Call[] } {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const answer = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
    if (!(key in answers)) throw new Error(`unexpected ${key}`);
    const a = answers[key];
    const v = typeof a === 'function' ? (a as (n: number) => unknown)(counts[key]!) : a;
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    calls,
    api: {
      get: async <T>(path: string) => { calls.push(['GET', path]); return answer(`GET ${path}`) as T; },
      post: async <T>(path: string, body?: unknown) => { calls.push(['POST', path, body]); return answer(`POST ${path}`) as T; },
    },
  };
}

const SUGGEST = {
  publicHostname: 'mail.example.com',
  sans: [{ name: 'autodiscover.example.com', resolvesHere: true }, { name: 'autoconfig.example.com', resolvesHere: false }],
  preselectServices: ['SMTP', 'IMAP', 'POP3'],
};
const OK_REPORT = { ok: true, domains: [], external: { status: 'ok', message: 'ok' } };
const noSleep = async () => undefined;

test('order names: host name first, suggestions only when their DNS points here', () => {
  assert.deepEqual(acmeDomains('Mail.example.com.', [
    { name: 'autodiscover.example.com', resolvesHere: true },
    { name: 'autoconfig.example.com', resolvesHere: false },
    { name: 'mail.example.com', resolvesHere: true },
  ]), ['mail.example.com', 'autodiscover.example.com']);
});

test('poll outcome and preflight problems', () => {
  assert.equal(pollOutcome('PENDING'), 'waiting');
  assert.equal(pollOutcome('RENEWING'), 'waiting');
  assert.equal(pollOutcome('ACTIVE'), 'done');
  assert.equal(pollOutcome('ERROR'), 'failed');
  assert.deepEqual(preflightProblems({
    ok: false,
    domains: [{ domain: 'mail.example.com', checks: [{ status: 'ok', message: 'fine' }, { status: 'error', message: 'A record points elsewhere' }] }],
    external: { status: 'error', message: 'staging validation failed' },
  }), ['mail.example.com: A record points elsewhere', 'staging validation failed']);
});

test('success: preflight → order with the mail services → poll → HTTPS assigned after the issuance', async () => {
  const { api, calls } = fakeApi({
    'GET /admin/certificates/acme-suggestions': SUGGEST,
    'POST /admin/certificates/preflight': OK_REPORT,
    'POST /admin/certificates/letsencrypt': { id: 'c1' },
    'GET /admin/certificates/c1': (n: number) => ({ status: n < 3 ? 'PENDING' : 'ACTIVE' }),
    'POST /admin/certificates/c1/activate-https': { certId: 'c1' },
  });
  const phases: CardPhase[] = [];
  const r = await runCertificateCard(api, { email: 'admin@example.com', sleep: noSleep, onPhase: (p) => phases.push(p) });
  assert.deepEqual(r, { kind: 'done', certificateId: 'c1', domains: ['mail.example.com', 'autodiscover.example.com'] });
  assert.deepEqual(phases, ['preflight', 'ordering', 'waiting', 'activating', 'done']);
  assert.deepEqual(calls.find((c) => c[1] === '/admin/certificates/preflight')?.[2], {
    domains: ['mail.example.com', 'autodiscover.example.com'], external: true,
  });
  assert.deepEqual(calls.find((c) => c[1] === '/admin/certificates/letsencrypt')?.[2], {
    name: 'mail.example.com', domains: ['mail.example.com', 'autodiscover.example.com'], email: 'admin@example.com',
    services: ['SMTP', 'IMAP', 'POP3'], autoRenew: true,
  });
  const activate = calls.findIndex((c) => c[1] === '/admin/certificates/c1/activate-https');
  const lastPoll = calls.map((c) => c[1]).lastIndexOf('/admin/certificates/c1');
  assert.ok(activate > lastPoll, 'HTTPS is assigned only after the certificate is ACTIVE');
  assert.equal(calls.filter((c) => c[1].endsWith('/activate-https')).length, 1);
});

test('preflight problems: nothing ordered, nothing assigned', async () => {
  const { api, calls } = fakeApi({
    'GET /admin/certificates/acme-suggestions': SUGGEST,
    'POST /admin/certificates/preflight': {
      ok: false, domains: [{ domain: 'mail.example.com', checks: [{ status: 'error', message: 'no A record' }] }],
      external: { status: 'skip', message: '' },
    },
  });
  const r = await runCertificateCard(api, { email: 'a@example.com', sleep: noSleep });
  assert.deepEqual(r, { kind: 'preflight-failed', problems: ['mail.example.com: no A record'] });
  assert.ok(!calls.some((c) => c[1] === '/admin/certificates/letsencrypt'));
  assert.ok(!calls.some((c) => c[1].endsWith('/activate-https')));
});

test('failed issuance: the CA error is reported, HTTPS stays untouched', async () => {
  const { api, calls } = fakeApi({
    'GET /admin/certificates/acme-suggestions': SUGGEST,
    'POST /admin/certificates/preflight': OK_REPORT,
    'POST /admin/certificates/letsencrypt': { id: 'c2' },
    'GET /admin/certificates/c2': { status: 'ERROR', lastError: 'urn:ietf:params:acme:error:dns' },
  });
  const r = await runCertificateCard(api, { email: 'a@example.com', sleep: noSleep });
  assert.deepEqual(r, { kind: 'issuance-failed', message: 'urn:ietf:params:acme:error:dns', certificateId: 'c2' });
  assert.ok(!calls.some((c) => c[1].endsWith('/activate-https')));
});

test('timeout while waiting: no HTTPS assignment', async () => {
  let t = 0;
  const { api, calls } = fakeApi({
    'GET /admin/certificates/acme-suggestions': SUGGEST,
    'POST /admin/certificates/preflight': OK_REPORT,
    'POST /admin/certificates/letsencrypt': { id: 'c3' },
    'GET /admin/certificates/c3': { status: 'PENDING' },
  });
  const r = await runCertificateCard(api, {
    email: 'a@example.com', pollMs: 1000, pollLimitMs: 5000, now: () => t, sleep: async (ms) => { t += ms; },
  });
  assert.deepEqual(r, { kind: 'timeout', certificateId: 'c3' });
  assert.ok(!calls.some((c) => c[1].endsWith('/activate-https')));
});

test('no usable public host name → error before anything is ordered', async () => {
  const { api, calls } = fakeApi({ 'GET /admin/certificates/acme-suggestions': { publicHostname: null, sans: [] } });
  const r = await runCertificateCard(api, { email: 'a@example.com', sleep: noSleep });
  assert.deepEqual(r, { kind: 'error', message: null });
  assert.equal(calls.length, 1);
});
