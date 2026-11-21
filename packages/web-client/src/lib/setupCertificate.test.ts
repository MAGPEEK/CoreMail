/**
 * 10.6: the setup wizard's certificate step (lib/setupCertificate.ts) against a
 * scripted API: pre-flight first, nothing ordered when it fails, the contact and
 * the accepted terms in the order, "done" only once HTTPS serves the
 * certificate, failures with their reason, HTTPS re-requested after a restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSetupCertificate, waitForCertificate, isValidContactEmail, certificateBlockReason, issueBody, safeTermsUrl,
  pollOutcome, resumeState, blockingChecks, LE_REPOSITORY_URL, CERT_ISSUE_PATH, CERT_PREFLIGHT_PATH, CERT_STATUS_PATH,
  type CertApi, type CertificateView, type CertPhase, type PreflightReport,
} from './setupCertificate.ts';

const OK_REPORT: PreflightReport = {
  ok: true,
  domains: [{ domain: 'mail.firma.de', checks: [{ id: 'dns', status: 'ok', message: 'mail.firma.de → 203.0.113.10' }] }],
  external: { status: 'ok', message: 'validated' },
};
const FAILED_REPORT: PreflightReport = {
  ok: false,
  domains: [{ domain: 'mail.firma.de', checks: [
    { id: 'dns', status: 'ok', message: 'ok' },
    { id: 'caa', status: 'error', message: 'CAA at firma.de only allows: digicert.com.' },
  ] }],
  external: { status: 'skip', message: 'External test skipped' },
};

const cert = (over: Partial<CertificateView> = {}): CertificateView => ({
  id: 'c1', status: 'PENDING', domains: ['mail.firma.de'], lastError: null, lastErrorCode: null,
  httpsActive: false, protocolActive: false, expiresAt: null, ...over,
});

/** Like the client's ApiError: message, `status`, optional `code`. */
function HttpError(status: number, code?: string): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, ...(code ? { code } : {}) });
}

/** Scripted API: answers in order per path; records every call. */
function fakeApi(script: { preflight?: unknown; issue?: unknown[]; status?: unknown[] }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const issue = [...(script.issue ?? [{ certificate: cert() }])];
  const status = [...(script.status ?? [])];
  const answer = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const api: CertApi = {
    get: <T>(path: string) => {
      calls.push({ method: 'GET', path });
      return answer(status.length > 1 ? status.shift() : status[0]) as Promise<T>;
    },
    post: <T>(path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      if (path === CERT_PREFLIGHT_PATH) return answer(script.preflight ?? { domains: ['mail.firma.de'], report: OK_REPORT }) as Promise<T>;
      return answer(issue.length > 1 ? issue.shift() : issue[0]) as Promise<T>;
    },
  };
  return { api, calls };
}
const fast = { sleep: async () => undefined, pollMs: 1 };

test('contact e-mail: same rule as the server, trimmed body, terms always true in the order', () => {
  for (const e of ['user@domain.de', 'first.last+tag@sub.example.com', ' admin@firma.de ']) assert.equal(isValidContactEmail(e), true, e);
  for (const e of ['', 'user', 'user@', '@domain.de', 'user@domain', 'us er@domain.de', '.user@domain.de', 'a..b@domain.de']) {
    assert.equal(isValidContactEmail(e), false, e);
  }
  assert.equal(certificateBlockReason({ acmeEmail: 'user@domain.de', acmeTermsAccepted: false }), 'acmeTerms');
  assert.equal(certificateBlockReason({ acmeEmail: 'user@domain.de', acmeTermsAccepted: true }), null);
  assert.deepEqual(issueBody(' user@domain.de '), { email: 'user@domain.de', termsAccepted: true });
});

test('terms link: only an https URL from the server, else the repository page', () => {
  assert.equal(safeTermsUrl('https://letsencrypt.org/documents/LE-SA-v1.5.pdf'), 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf');
  for (const u of ['javascript:alert(1)', 'http://letsencrypt.org/x', '', null, undefined]) assert.equal(safeTermsUrl(u), LE_REPOSITORY_URL);
});

test('pre-flight, order with the contact, wait for issuance and HTTPS → done', async () => {
  const phases: CertPhase[] = [];
  const { api, calls } = fakeApi({
    status: [
      { certificate: cert() },
      { certificate: cert({ status: 'ACTIVE', protocolActive: true }) },
      { certificate: cert({ status: 'ACTIVE', protocolActive: true, httpsActive: true }) },
    ],
  });
  const r = await runSetupCertificate(api, { email: 'user@domain.de', onPhase: (p) => phases.push(p), ...fast });
  assert.equal(r.kind, 'done');
  assert.deepEqual(calls.slice(0, 2).map((c) => `${c.method} ${c.path}`), [`POST ${CERT_PREFLIGHT_PATH}`, `POST ${CERT_ISSUE_PATH}`]);
  assert.deepEqual(calls[1]!.body, { email: 'user@domain.de', termsAccepted: true });
  assert.ok(calls.slice(2).every((c) => c.path === `${CERT_STATUS_PATH}?view=certificate`), 'polling uses the light view');
  assert.deepEqual(phases, ['preflight', 'ordering', 'waiting', 'activating', 'done']);
});

test('failed pre-flight: nothing is ordered, the blocking checks are reported', async () => {
  const { api, calls } = fakeApi({ preflight: { domains: ['mail.firma.de'], report: FAILED_REPORT } });
  let seen: PreflightReport | null = null;
  const r = await runSetupCertificate(api, { email: 'user@domain.de', onReport: (rep) => { seen = rep; }, ...fast });
  assert.equal(r.kind, 'preflight-failed');
  assert.equal(seen, FAILED_REPORT, 'the per-check status reaches the step');
  assert.equal(calls.some((c) => c.path === CERT_ISSUE_PATH), false);
  assert.deepEqual(blockingChecks(FAILED_REPORT).map((b) => b.check.id), ['caa']);
});

test('issuance failure: the classified code and the CA message', async () => {
  const { api } = fakeApi({ status: [{ certificate: cert({ status: 'ERROR', lastErrorCode: 'connection', lastError: 'Connection refused' }) }] });
  const r = await runSetupCertificate(api, { email: 'user@domain.de', ...fast });
  assert.deepEqual(r, { kind: 'issuance-failed', code: 'connection', message: 'Connection refused', certificateId: 'c1' });
});

test('server errors are classified (rate limit, window closed, local host name, busy)', async () => {
  const cases: Array<[Error, string]> = [
    [HttpError(429, 'RATE_LIMITED'), 'rate-limited'],
    [HttpError(404), 'window-closed'],
    [HttpError(409, 'LOCAL_HOSTNAME'), 'local-hostname'],
    [HttpError(409, 'BUSY'), 'busy'],
    [HttpError(500), 'failed'],
  ];
  for (const [err, reason] of cases) {
    const { api } = fakeApi({ preflight: err });
    const r = await runSetupCertificate(api, { email: 'user@domain.de', ...fast });
    assert.equal(r.kind, 'error');
    assert.equal(r.kind === 'error' && r.reason, reason);
  }
  const { api } = fakeApi({ issue: [HttpError(400, 'TERMS_REQUIRED')] });
  const r = await runSetupCertificate(api, { email: 'user@domain.de', ...fast });
  assert.equal(r.kind === 'error' && r.reason, 'input');
});

test('issued but HTTPS not assigned (server restarted): the order is sent again once, then done', async () => {
  const issued = cert({ status: 'ACTIVE', protocolActive: true });
  const { api, calls } = fakeApi({
    status: [{ certificate: issued }],
    issue: [{ certificate: cert() }, { certificate: { ...issued, httpsActive: true } }],
  });
  const r = await runSetupCertificate(api, { email: 'user@domain.de', httpsGracePolls: 2, ...fast });
  assert.equal(r.kind, 'done');
  assert.equal(calls.filter((c) => c.path === CERT_ISSUE_PATH).length, 2);
});

test('timeout after the poll limit; a closed step stops quietly', async () => {
  let t = 0;
  const { api } = fakeApi({ status: [{ certificate: cert() }] });
  const r = await waitForCertificate(api, { email: 'x@y.de', sleep: async () => { t += 1_000; }, now: () => t, pollLimitMs: 5_000 });
  assert.deepEqual(r, { kind: 'timeout', certificateId: 'c1' });
  const { api: api2, calls } = fakeApi({ status: [{ certificate: cert() }] });
  const r2 = await waitForCertificate(api2, { email: 'x@y.de', ...fast, alive: () => false });
  assert.equal(r2.kind, 'timeout');
  assert.equal(calls.length, 0);
});

test('status helpers: poll outcome and the state a reloaded wizard resumes', () => {
  assert.equal(pollOutcome('ACTIVE'), 'issued');
  assert.equal(pollOutcome('EXPIRING'), 'issued');
  assert.equal(pollOutcome('ERROR'), 'failed');
  assert.equal(pollOutcome('PENDING'), 'waiting');
  assert.equal(resumeState(null), 'none');
  assert.equal(resumeState(cert()), 'running');
  assert.equal(resumeState(cert({ status: 'ACTIVE' })), 'running', 'issued, HTTPS still pending');
  assert.equal(resumeState(cert({ status: 'ACTIVE', httpsActive: true })), 'done');
  assert.equal(resumeState(cert({ status: 'ERROR' })), 'failed');
});
