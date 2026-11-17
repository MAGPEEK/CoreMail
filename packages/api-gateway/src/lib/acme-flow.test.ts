/**
 * ACME HTTP-01 flow (9.2.x fix "Let's Encrypt certificates can't be issued").
 *
 * Root cause on the test server: acme-client's auto() fetched the challenge
 * from the server's OWN public address before asking Let's Encrypt (no hairpin
 * NAT in Docker → no answer, no HTTP timeout, 10+ retries), so the CA was never
 * contacted and the 5-minute guard hid everything behind a generic timeout.
 * These tests pin the replacement: loopback check only, bounded public check,
 * CA problem details classified, abortable, no hidden acme-client retries.
 * Fake CA — no network except loopback test servers.
 * Run: node --import tsx --test src/lib/acme-flow.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import {
  configureAcmeHttp, httpGetText, runAcmeFlow, ACME_HTTP_TIMEOUT_MS,
} from './acme-flow.js';
import {
  AcmeProblemError, classifyAcmeProblem, isAcmeNetworkError, problemFromAcmeObject, toAcmeFailure,
} from './acme-errors.js';
import { makeFakeCa, makeFakeServing } from '../test-support/fake-acme.js';

const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----';
const fastSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, Math.min(ms, 5));
    signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason as Error); }, { once: true });
  });

test('issues without fetching the public address first: hairpin hang does not block, CA validates over port 80', async () => {
  const { serving, served, events } = makeFakeServing({ public: 'hang' });
  const ca = makeFakeCa({ served });
  const ac = new AbortController();
  const steps: string[] = [];
  const t0 = Date.now();
  const res = await runAcmeFlow(ca.client, serving, {
    domains: ['mail.example.com', 'autodiscover.example.com'], csr: CSR, email: 'admin@example.com',
    signal: ac.signal, sleep: fastSleep, publicCheckTimeoutMs: 50, onStep: (s) => steps.push(s),
  });
  assert.ok(Date.now() - t0 < 3_000, 'a public address that never answers must not stall the issuance');
  assert.match(res.certificate ?? '', /BEGIN CERTIFICATE/);
  assert.deepEqual(Object.keys(res.publicCheck).sort(), ['autodiscover.example.com', 'mail.example.com']);
  assert.match(res.publicCheck['mail.example.com']!, /no answer/);
  // loopback check happened before the CA was asked to validate
  const localIdx = events.findIndex(e => e.startsWith('local:'));
  assert.ok(localIdx >= 0);
  assert.ok(ca.calls.includes('complete:mail.example.com'));
  assert.ok(ca.calls.includes('finalize') && ca.calls.includes('getCertificate'));
  assert.ok(steps.includes('validate') && steps.includes('download'));
  assert.equal(served.size, 0, 'tokens are removed afterwards');
  assert.ok(!ca.calls.some(c => c.startsWith('deactivate:')), 'successful authorizations are kept');
});

test('connection refused reported by the CA → code "connection" with the CA detail and the domain', async () => {
  const { serving } = makeFakeServing();
  const ca = makeFakeCa({
    outcome: () => ({ status: 'invalid', type: 'urn:ietf:params:acme:error:connection',
      detail: '84.247.191.198: Fetching http://mail.example.com/.well-known/acme-challenge/x: Connection refused' }),
  });
  await assert.rejects(
    runAcmeFlow(ca.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep }),
    (err: unknown) => {
      assert.ok(err instanceof AcmeProblemError);
      assert.equal(err.code, 'connection');
      assert.equal(err.domain, 'mail.example.com');
      assert.match(err.message, /port 80/);
      assert.match(err.message, /Connection refused/);
      assert.match(err.message, /\[mail\.example\.com\]/);
      return true;
    },
  );
  assert.ok(!ca.calls.includes('finalize'));
});

test('CAA, rate limit and DNS problems are classified with the detail kept', async () => {
  const { serving } = makeFakeServing();
  const caa = makeFakeCa({ outcome: () => ({ status: 'invalid', type: 'urn:ietf:params:acme:error:caa', detail: 'CAA record for example.com prevents issuance' }) });
  await assert.rejects(runAcmeFlow(caa.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep }),
    (e: unknown) => e instanceof AcmeProblemError && e.code === 'caa' && /prevents issuance/.test(e.message));

  // acme-client throws Error(detail) for non-2xx answers (no problem type) → classified by text
  const rl = makeFakeCa({ createOrderError: 'Error creating new order :: too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after 2026-11-20 10:00:00 UTC' });
  await assert.rejects(runAcmeFlow(rl.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep }),
    (e: unknown) => e instanceof AcmeProblemError && e.code === 'rate-limited' && /retry after 2026-11-20/.test(e.message));

  const dns = makeFakeCa({ outcome: () => ({ status: 'invalid', type: 'urn:ietf:params:acme:error:dns', detail: 'DNS problem: NXDOMAIN looking up A for mail.example.com' }) });
  await assert.rejects(runAcmeFlow(dns.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep }),
    (e: unknown) => e instanceof AcmeProblemError && e.code === 'dns' && /NXDOMAIN/.test(e.message));
});

test('token not served locally → nothing is sent to the CA, the pending authorization is deactivated', async () => {
  const { serving, served } = makeFakeServing({ local: 404 });
  const ca = makeFakeCa({ served });
  await assert.rejects(
    runAcmeFlow(ca.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep }),
    (e: unknown) => e instanceof AcmeProblemError && e.code === 'local-serving' && /HTTP 404/.test(e.message),
  );
  assert.ok(!ca.calls.some(c => c.startsWith('complete:')), 'no failed validation is spent at the CA');
  assert.ok(ca.calls.includes('deactivate:mail.example.com'));
  assert.equal(served.size, 0);
});

test('abort stops the run within milliseconds even when the CA never answers (no zombie holding the lock)', async () => {
  const { serving, served } = makeFakeServing();
  const ca = makeFakeCa({ served, hangComplete: true });
  const ac = new AbortController();
  const run = runAcmeFlow(ca.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: ac.signal, sleep: fastSleep });
  await new Promise(r => setTimeout(r, 30));
  const t0 = Date.now();
  ac.abort(new Error('cancelled by test'));
  await assert.rejects(run, /cancelled by test/);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(served.size, 0, 'published tokens are removed on abort');
});

test('network errors (acme-client TypeError without response) are retried, then reported as "network"', async () => {
  const { serving, served } = makeFakeServing();
  const ok = makeFakeCa({ served, accountNetworkFailures: 2 });
  const res = await runAcmeFlow(ok.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep });
  assert.ok(res.certificate);
  assert.equal(ok.calls.filter(c => c === 'createAccount').length, 3);

  const bad = makeFakeCa({ served, accountNetworkFailures: 5 });
  await assert.rejects(runAcmeFlow(bad.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep }),
    (e: unknown) => e instanceof AcmeProblemError && e.code === 'network');
});

test('validateOnly (pre-flight): no certificate, authorizations deactivated so the next test validates again', async () => {
  const { serving, served } = makeFakeServing();
  const ca = makeFakeCa({ served });
  const res = await runAcmeFlow(ca.client, serving, { domains: ['mail.example.com'], signal: new AbortController().signal, validateOnly: true, sleep: fastSleep });
  assert.equal(res.certificate, undefined);
  assert.ok(ca.calls.includes('complete:mail.example.com'));
  assert.ok(!ca.calls.includes('finalize'));
  assert.ok(ca.calls.includes('deactivate:mail.example.com'));
});

test('a validation that stays pending ends with a timeout error naming the domain (not an endless wait)', async () => {
  const { serving, served } = makeFakeServing();
  const ca = makeFakeCa({ served });
  const realComplete = ca.client.completeChallenge.bind(ca.client);
  ca.client.completeChallenge = async (ch) => { ca.calls.push('complete:pending'); return ch; }; // CA never decides
  void realComplete;
  await assert.rejects(
    runAcmeFlow(ca.client, serving, { domains: ['mail.example.com'], csr: CSR, signal: new AbortController().signal, sleep: fastSleep, validationTimeoutMs: 30 }),
    (e: unknown) => e instanceof AcmeProblemError && e.code === 'timeout' && e.domain === 'mail.example.com',
  );
});

test('classification table', () => {
  assert.equal(classifyAcmeProblem('urn:ietf:params:acme:error:rateLimited', ''), 'rate-limited');
  assert.equal(classifyAcmeProblem('urn:ietf:params:acme:error:unauthorized', 'Invalid response from http://x/.well-known/acme-challenge/y: 404'), 'unauthorized');
  assert.equal(classifyAcmeProblem('urn:ietf:params:acme:error:incorrectResponse', 'Timeout during connect (likely firewall problem)'), 'connection');
  assert.equal(classifyAcmeProblem('urn:ietf:params:acme:error:invalidContact', 'contact email has invalid domain'), 'account');
  assert.equal(classifyAcmeProblem(null, 'Error creating new order :: Cannot issue for "mail.local": Domain name does not end with a valid public suffix (TLD)'), 'rejected-identifier');
  assert.equal(classifyAcmeProblem(null, 'Service Unavailable'), 'server');
  assert.equal(classifyAcmeProblem(null, 'something odd'), 'unknown');
  assert.equal(isAcmeNetworkError(new TypeError("Cannot read properties of undefined (reading 'config')")), true);
  assert.equal(isAcmeNetworkError(new Error('Invalid response')), false);
  assert.equal(toAcmeFailure(new TypeError("Cannot read properties of undefined (reading 'config')")).code, 'network');
  const p = problemFromAcmeObject({ challenges: [{ status: 'invalid', error: { type: 'urn:ietf:params:acme:error:connection', detail: 'refused' } }] });
  assert.deepEqual(p, { type: 'urn:ietf:params:acme:error:connection', detail: 'refused' });
  // user-visible texts: no RFC numbers
  for (const code of ['connection', 'caa', 'rate-limited', 'dns', 'unauthorized'] as const) {
    assert.doesNotMatch(new AcmeProblemError(code, 'x').message, /RFC\s*\d/i);
  }
});

// ── acme-client HTTP settings: no unbounded hidden retries ────────────────────

test('configureAcmeHttp: a rate-limit answer with Retry-After: 3600 returns at once; network errors fail fast', async () => {
  const require = createRequire(import.meta.url);
  const acme = require('acme-client') as { axios: { defaults: { timeout?: number; acmeSettings: { retryMaxAttempts: number } }; request: (c: object) => Promise<{ status: number }> } };
  configureAcmeHttp(acme);
  configureAcmeHttp(acme); // idempotent
  assert.equal(acme.axios.defaults.timeout, ACME_HTTP_TIMEOUT_MS);
  assert.equal(acme.axios.defaults.acmeSettings.retryMaxAttempts, 0);

  const srv = http.createServer((_req, res) => {
    res.writeHead(429, { 'retry-after': '3600', 'content-type': 'application/problem+json' });
    res.end(JSON.stringify({ type: 'urn:ietf:params:acme:error:rateLimited', detail: 'too many failed authorizations recently' }));
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (srv.address() as AddressInfo).port;
    const t0 = Date.now();
    const r = await acme.axios.request({ url: `http://127.0.0.1:${port}/new-order`, method: 'post', validateStatus: null });
    assert.equal(r.status, 429);
    assert.ok(Date.now() - t0 < 2_000, 'no sleep for Retry-After');

    // closed port → acme-client's network TypeError, recognised by the flow
    const closed = http.createServer();
    await new Promise<void>(res => closed.listen(0, '127.0.0.1', () => res()));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>(res => closed.close(() => res()));
    await assert.rejects(acme.axios.request({ url: `http://127.0.0.1:${closedPort}/x`, method: 'post', validateStatus: null }),
      (e: unknown) => isAcmeNetworkError(e));
  } finally {
    srv.close();
  }
});

test('httpGetText: passes the Host header, never waits longer than its timeout', async () => {
  let seenHost = '';
  const ok = http.createServer((req, res) => { seenHost = String(req.headers.host); res.end('tok.thumb'); });
  const silent = http.createServer(() => { /* accepts, never answers — like a dropped hairpin connection */ });
  await new Promise<void>(r => ok.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>(r => silent.listen(0, '127.0.0.1', () => r()));
  try {
    const r = await httpGetText(`http://127.0.0.1:${(ok.address() as AddressInfo).port}/.well-known/acme-challenge/tok`, { host: 'mail.example.com' });
    assert.deepEqual([r.status, r.body], [200, 'tok.thumb']);
    assert.equal(seenHost, 'mail.example.com');
    const t0 = Date.now();
    await assert.rejects(httpGetText(`http://127.0.0.1:${(silent.address() as AddressInfo).port}/x`, { timeoutMs: 150 }),
      (e: unknown) => (e as { code?: string }).code === 'ETIMEDOUT');
    assert.ok(Date.now() - t0 < 1_500);
  } finally {
    ok.close();
    silent.closeAllConnections();
    silent.close();
  }
});

test('a refused contact e-mail does not block the account: registered again without contact', async () => {
  const { serving, served } = makeFakeServing();
  const ca = makeFakeCa({ served, rejectContact: true });
  const steps: Array<[string, unknown]> = [];
  const res = await runAcmeFlow(ca.client, serving, {
    domains: ['mail.example.com'], csr: CSR, email: 'admin@example.com', signal: new AbortController().signal,
    sleep: fastSleep, onStep: (s, i) => steps.push([s, i]),
  });
  assert.ok(res.certificate);
  assert.equal(ca.calls.filter(c => c === 'createAccount').length, 2);
  assert.ok(steps.some(([s, i]) => s === 'account' && (i as { withoutContact?: boolean } | undefined)?.withoutContact));
});
