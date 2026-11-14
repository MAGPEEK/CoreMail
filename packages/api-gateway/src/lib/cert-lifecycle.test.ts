/**
 * Certificate lifecycle: status derivation, renewal decision, publicHostname
 * rule and HTTPS proxy (SNI) certificate selection. No network, no ACME, no DB.
 * Run: node --import tsx --test src/lib/cert-lifecycle.test.ts  (in packages/api-gateway)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';
import {
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelayMs, decideRenewal, deriveCertStatus,
  hostnameUpdateFor, isDefaultHostname, isPemCurrentlyValid, parseCertValidity, planSni,
  recomputeStatus, resolveSni, selectProxyCerts,
  type ProxyCertRow, type RenewalCandidate,
} from './cert-lifecycle.js';

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-11-14T12:00:00Z');

const { privateKey: KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** Self-signed test certificate with explicit validity window (node-forge, offline). */
function makeCert(names: string[], notBefore: Date, notAfter: Date): string {
  const key = forge.pki.privateKeyFromPem(KEY_PEM) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = String(Math.floor(Math.random() * 1e9) + 1);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [{ name: 'commonName', value: names[0]! }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: names.map(value => ({ type: 2, value })) }]);
  cert.sign(key, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe('status derivation from validity dates', () => {
  test('ACTIVE / EXPIRING (<= 30 days) / EXPIRED / PENDING', () => {
    assert.equal(deriveCertStatus(null, NOW), 'PENDING');
    assert.equal(deriveCertStatus(at(-1), NOW), 'EXPIRED');
    assert.equal(deriveCertStatus(NOW, NOW), 'EXPIRED');
    assert.equal(deriveCertStatus(at(10), NOW), 'EXPIRING');
    assert.equal(deriveCertStatus(at(30), NOW), 'EXPIRING');
    assert.equal(deriveCertStatus(at(31), NOW), 'ACTIVE');
    assert.equal(deriveCertStatus(at(89), NOW), 'ACTIVE');
  });

  test('validity is parsed from the PEM', () => {
    const pem = makeCert(['mail.example.com'], at(-60), at(20));
    const v = parseCertValidity(pem);
    assert.ok(v);
    assert.equal(Math.round((v.validTo.getTime() - NOW.getTime()) / DAY), 20);
    assert.equal(deriveCertStatus(v.validTo, NOW), 'EXPIRING');
    assert.equal(isPemCurrentlyValid(pem, NOW), true);
    assert.equal(isPemCurrentlyValid(pem, at(25)), false);
    assert.equal(parseCertValidity('not a pem'), null);
    assert.equal(isPemCurrentlyValid(null, NOW), false);
  });

  test('recomputeStatus only touches settled states', () => {
    assert.equal(recomputeStatus('ACTIVE', at(-1), NOW), 'EXPIRED');
    assert.equal(recomputeStatus('ACTIVE', at(5), NOW), 'EXPIRING');
    assert.equal(recomputeStatus('EXPIRING', at(80), NOW), 'ACTIVE'); // renewed out of band
    assert.equal(recomputeStatus('EXPIRED', at(80), NOW), 'ACTIVE');
    assert.equal(recomputeStatus('RENEWING', at(-1), NOW), 'RENEWING');
    assert.equal(recomputeStatus('PENDING', at(-1), NOW), 'PENDING');
    assert.equal(recomputeStatus('ERROR', at(5), NOW), 'ERROR');
    assert.equal(recomputeStatus('ACTIVE', null, NOW), 'ACTIVE');
  });
});

describe('renewal decision', () => {
  const base = (over: Partial<RenewalCandidate> = {}): RenewalCandidate => ({
    id: 'c1', type: 'LETSENCRYPT', status: 'EXPIRING', autoRenew: true,
    acmeEmail: 'admin@example.com', domains: ['mail.example.com'],
    certPem: makeCert(['mail.example.com'], at(-70), at(20)), expiresAt: at(20),
    ...over,
  });

  test('renews a Let\'s Encrypt cert with autoRenew when <= 30 days remain', () => {
    const d = decideRenewal(base(), { now: NOW });
    assert.equal(d.renew, true);
    assert.equal(Math.round(d.daysLeft ?? 0), 20);
  });

  test('does not renew when more than 30 days remain', () => {
    const d = decideRenewal(base({ certPem: makeCert(['mail.example.com'], at(-10), at(80)) }), { now: NOW });
    assert.deepEqual([d.renew, d.reason], [false, 'not-due']);
  });

  test('PEM expiry wins over a stale DB expiresAt', () => {
    // DB says 80 days, the PEM actually expires in 5 → due
    const d = decideRenewal(base({ expiresAt: at(80), certPem: makeCert(['m.example.com'], at(-85), at(5)) }), { now: NOW });
    assert.equal(d.renew, true);
  });

  test('falls back to expiresAt when the PEM is missing', () => {
    assert.equal(decideRenewal(base({ certPem: null, expiresAt: at(3) }), { now: NOW }).renew, true);
    assert.equal(decideRenewal(base({ certPem: null, expiresAt: null }), { now: NOW }).reason, 'no-expiry');
  });

  test('already expired certs are renewed too', () => {
    const d = decideRenewal(base({ status: 'EXPIRED', certPem: makeCert(['m.example.com'], at(-100), at(-2)) }), { now: NOW });
    assert.equal(d.renew, true);
  });

  test('autoRenew=false, non-LE, missing email or domains → skip', () => {
    assert.equal(decideRenewal(base({ autoRenew: false }), { now: NOW }).reason, 'auto-renew-off');
    assert.equal(decideRenewal(base({ type: 'CUSTOM' }), { now: NOW }).reason, 'not-letsencrypt');
    assert.equal(decideRenewal(base({ type: 'SELF_SIGNED' }), { now: NOW }).reason, 'not-letsencrypt');
    assert.equal(decideRenewal(base({ acmeEmail: null }), { now: NOW }).reason, 'no-acme-email');
    assert.equal(decideRenewal(base({ domains: [] }), { now: NOW }).reason, 'no-domains');
  });

  test('PENDING/RENEWING or a held lock → never a second concurrent renewal', () => {
    assert.equal(decideRenewal(base({ status: 'RENEWING' }), { now: NOW }).reason, 'in-progress');
    assert.equal(decideRenewal(base({ status: 'PENDING' }), { now: NOW }).reason, 'in-progress');
    assert.equal(decideRenewal(base(), { now: NOW, lockHeld: true }).reason, 'locked');
  });

  test('ERROR after a failed renewal: retried only after the backoff', () => {
    const cert = base({ status: 'ERROR' });
    const justFailed = { failures: 1, lastFailureAt: NOW.getTime() - 30 * 60_000 };
    const d1 = decideRenewal(cert, { now: NOW, backoff: justFailed });
    assert.equal(d1.reason, 'backoff');
    assert.equal(d1.retryAt, justFailed.lastFailureAt + BACKOFF_BASE_MS);

    const longAgo = { failures: 1, lastFailureAt: NOW.getTime() - BACKOFF_BASE_MS - 1 };
    assert.equal(decideRenewal(cert, { now: NOW, backoff: longAgo }).renew, true);

    // 3 failures → 8h backoff
    const third = { failures: 3, lastFailureAt: NOW.getTime() - 5 * 3600 * 1000 };
    assert.equal(decideRenewal(cert, { now: NOW, backoff: third }).reason, 'backoff');
  });

  test('backoff grows exponentially and is capped at 24h', () => {
    assert.equal(backoffDelayMs(0), 0);
    assert.equal(backoffDelayMs(1), BACKOFF_BASE_MS);
    assert.equal(backoffDelayMs(2), 2 * BACKOFF_BASE_MS);
    assert.equal(backoffDelayMs(3), 4 * BACKOFF_BASE_MS);
    assert.equal(backoffDelayMs(20), BACKOFF_MAX_MS);
  });
});

describe('publicHostname rule', () => {
  test('only a default hostname is replaced on first activation', () => {
    assert.equal(hostnameUpdateFor('mail.local', ['mail.example.com'], { isRenewal: false }), 'mail.example.com');
    assert.equal(hostnameUpdateFor('mail.localhost', ['*.example.com', 'mx.example.com'], { isRenewal: false }), 'mx.example.com');
    assert.equal(hostnameUpdateFor(null, ['mail.example.com'], { isRenewal: false }), 'mail.example.com');
    assert.equal(hostnameUpdateFor('', ['mail.example.com'], { isRenewal: false }), 'mail.example.com');
  });

  test('an admin-chosen hostname is never overwritten', () => {
    assert.equal(hostnameUpdateFor('mx.company.de', ['autodiscover.company.de'], { isRenewal: false }), null);
  });

  test('renewal never changes the hostname', () => {
    assert.equal(hostnameUpdateFor('mail.local', ['mail.example.com'], { isRenewal: true }), null);
  });

  test('wildcard-only / localhost certs give no hostname', () => {
    assert.equal(hostnameUpdateFor('mail.local', ['*.example.com', 'localhost'], { isRenewal: false }), null);
    assert.equal(isDefaultHostname('Mail.Local'), true);
    assert.equal(isDefaultHostname('mail.example.com'), false);
  });
});

describe('HTTPS proxy certificate selection', () => {
  const row = (id: string, names: string[], from: number, to: number, over: Partial<ProxyCertRow> = {}): ProxyCertRow => ({
    id, name: id, certPem: makeCert(names, at(from), at(to)), keyPem: KEY_PEM, chainPem: null,
    domains: names, isActiveHttps: false, createdAt: at(from), ...over,
  });

  test('expired and not-yet-valid PEMs are dropped, valid ones kept regardless of status', () => {
    const rows = [
      row('expired', ['old.example.com'], -100, -1),
      row('future', ['new.example.com'], 2, 90),
      row('valid', ['mail.example.com'], -10, 80),
      // status is irrelevant: an EXPIRING / ERROR cert with a valid PEM stays in SNI
      row('expiring', ['autodiscover.example.com'], -80, 10),
    ];
    const ids = selectProxyCerts(rows, NOW).map(c => c.id);
    assert.deepEqual(ids.sort(), ['expiring', 'valid']);
  });

  test('rows without key or PEM are skipped', () => {
    const rows = [row('nokey', ['a.example.com'], -1, 10, { keyPem: null }), row('nopem', ['b.example.com'], -1, 10, { certPem: null })];
    assert.equal(selectProxyCerts(rows, NOW).length, 0);
  });

  test('newest certificate wins per hostname (renewal next to the old cert)', () => {
    const rows = [
      row('old', ['mail.example.com', 'autodiscover.example.com'], -80, 10),
      row('renewed', ['mail.example.com'], -1, 89),
    ];
    const selected = selectProxyCerts(rows, NOW);
    assert.deepEqual(selected.map(c => c.id), ['renewed', 'old']);
    const plan = planSni(selected);
    assert.equal(resolveSni(plan, 'mail.example.com'), 'renewed');
    assert.equal(resolveSni(plan, 'MAIL.example.com'), 'renewed');
    // a hostname only the older cert has still resolves to it
    assert.equal(resolveSni(plan, 'autodiscover.example.com'), 'old');
  });

  test('wildcard matches exactly one label; default is isActiveHttps, else newest', () => {
    const rows = [
      row('wild', ['*.example.org'], -20, 60),
      row('https', ['mail.example.net'], -30, 60, { isActiveHttps: true }),
    ];
    const plan = planSni(selectProxyCerts(rows, NOW));
    assert.equal(resolveSni(plan, 'a.example.org'), 'wild');
    assert.equal(resolveSni(plan, 'a.b.example.org'), 'https'); // no deep wildcard → default
    assert.equal(resolveSni(plan, 'unknown.test'), 'https');

    const noDefault = planSni(selectProxyCerts([row('a', ['a.test'], -5, 50), row('b', ['b.test'], -1, 50)], NOW));
    assert.equal(noDefault.defaultId, 'b');
  });

  test('nothing valid → no default (HTTPS server stays down)', () => {
    const plan = planSni(selectProxyCerts([row('x', ['x.test'], -100, -1)], NOW));
    assert.equal(plan.defaultId, null);
    assert.equal(resolveSni(plan, 'x.test'), null);
  });
});
