/**
 * 9.3 — served-certificate probe against local TLS server fixtures:
 * implicit TLS, SMTP STARTTLS, IMAP STARTTLS, POP3 STLS; subject / issuer /
 * expiry / fingerprint / self-signed / host-name match; bounded timeouts; and
 * GET /api/v1/admin/certificates/served (listeners from the DB, certificate
 * matched by fingerprint, "Jetzt zuweisen" suggestion).
 * Run: node --import tsx --test --test-force-exit src/lib/served-cert.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let listeners: Row[] = [];
let certRows: Row[] = [];
installFakePrisma({
  user: { findUnique: () => ({ role: 'ORGANIZATION_MANAGEMENT', active: true }) },
  serviceListener: { findMany: () => listeners },
  // unreadableInUseCertKeys asks for the protocol / HTTPS certificates only (where.OR)
  certificate: { findMany: (a: unknown) => ((a as { where?: Row } | undefined)?.where?.['OR'] ? certRows.filter((r) => r['isActiveProtocol'] || r['isActiveHttps']) : certRows) },
  serverSettings: { findUnique: () => ({ publicHostname: 'mail.example.com' }) },
});

const { probeServedCert, describeCert, servedCertProblem, localProbeHost } = await import('./served-cert.js');
const { createSelfSignedPem } = await import('./protocol-cert-assign.js');

const good = await createSelfSignedPem(['mail.example.com']);
const other = await createSelfSignedPem(['mail.localhost']);
const ctx = (c: { certPem: string; keyPem: string }) => tls.createSecureContext({ cert: c.certPem, key: c.keyPem });

const servers: net.Server[] = [];
async function listen(s: net.Server): Promise<number> {
  servers.push(s);
  s.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  return (s.address() as AddressInfo).port;
}

/** Plain server that speaks a minimal greeting/STARTTLS dialogue, then upgrades. */
function starttlsServer(kind: 'smtp' | 'imap' | 'pop3', cert: { certPem: string; keyPem: string }, opts: { offer?: boolean } = {}): net.Server {
  return net.createServer((sock) => {
    sock.on('error', () => undefined);
    const greet = kind === 'smtp' ? '220 test ESMTP\r\n' : kind === 'imap' ? '* OK test ready\r\n' : '+OK test ready\r\n';
    sock.write(greet);
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const upgrade = (reply: string) => {
          sock.off('data', onData);
          sock.write(reply, () => {
            const t = new tls.TLSSocket(sock, { isServer: true, secureContext: ctx(cert) });
            t.on('error', () => undefined);
          });
        };
        if (kind === 'smtp' && /^EHLO/i.test(line)) sock.write(opts.offer === false ? '250 test\r\n' : '250-test\r\n250 STARTTLS\r\n');
        else if (kind === 'smtp' && /^STARTTLS/i.test(line)) upgrade('220 go ahead\r\n');
        else if (kind === 'imap' && /^cm1 STARTTLS/i.test(line)) upgrade('cm1 OK begin TLS\r\n');
        else if (kind === 'pop3' && /^STLS/i.test(line)) upgrade('+OK begin TLS\r\n');
      }
    };
    sock.on('data', onData);
  });
}

let ports: Record<string, number> = {};
before(async () => {
  ports = {
    implicit: await listen(tls.createServer({ cert: good.certPem, key: good.keyPem }, (s) => s.on('error', () => undefined))),
    smtp: await listen(starttlsServer('smtp', good)),
    imap: await listen(starttlsServer('imap', other)),
    pop3: await listen(starttlsServer('pop3', good)),
    smtpNoTls: await listen(starttlsServer('smtp', good, { offer: false })),
    silent: await listen(net.createServer((s) => s.on('error', () => undefined))),
  };
});
after(() => { for (const s of servers) s.close(); });

const fp = (pem: string) => new X509Certificate(pem).fingerprint256;

test('implicit TLS: subject, issuer, self-signed, host name match, fingerprint', async () => {
  const r = await probeServedCert({ protocol: 'imap', port: ports['implicit']!, implicitTls: true }, 'mail.example.com');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, 'tls');
  assert.equal(r.cert!.commonName, 'mail.example.com');
  assert.equal(r.cert!.selfSigned, true);
  assert.equal(r.cert!.hostnameMatch, true);
  assert.equal(r.cert!.trusted, false);
  assert.equal(r.cert!.fingerprint256, fp(good.certPem));
  assert.equal(servedCertProblem(r), 'self-signed');

  const mismatch = await probeServedCert({ protocol: 'imap', port: ports['implicit']!, implicitTls: true }, 'mail.other.org');
  assert.equal(mismatch.cert!.hostnameMatch, false);
});

test('STARTTLS dialogues: SMTP EHLO/STARTTLS, IMAP STARTTLS, POP3 STLS', async () => {
  const smtp = await probeServedCert({ protocol: 'smtp', port: ports['smtp']!, implicitTls: false }, 'mail.example.com');
  assert.equal(smtp.ok, true, smtp.error);
  assert.equal(smtp.mode, 'starttls');
  assert.equal(smtp.cert!.fingerprint256, fp(good.certPem));

  const imap = await probeServedCert({ protocol: 'imap', port: ports['imap']!, implicitTls: false }, 'mail.example.com');
  assert.equal(imap.ok, true, imap.error);
  assert.equal(imap.cert!.commonName, 'mail.localhost');
  assert.equal(imap.cert!.hostnameMatch, false);

  const pop3 = await probeServedCert({ protocol: 'pop3', port: ports['pop3']!, implicitTls: false }, 'mail.example.com');
  assert.equal(pop3.ok, true, pop3.error);
  assert.equal(pop3.cert!.fingerprint256, fp(good.certPem));
});

test('failures are reported, never thrown: STARTTLS not offered, timeout, refused', async () => {
  const noTls = await probeServedCert({ protocol: 'smtp', port: ports['smtpNoTls']!, implicitTls: false }, 'mail.example.com');
  assert.equal(noTls.ok, false);
  assert.match(noTls.error!, /STARTTLS not offered/);

  const t0 = Date.now();
  const silent = await probeServedCert({ protocol: 'imap', port: ports['silent']!, implicitTls: false }, 'mail.example.com', { timeoutMs: 400 });
  assert.equal(silent.ok, false);
  assert.match(silent.error!, /timeout/);
  assert.ok(Date.now() - t0 < 2_000, 'bounded');

  const refused = await probeServedCert({ protocol: 'pop3', port: 1, implicitTls: true }, 'mail.example.com', { timeoutMs: 1_000 });
  assert.equal(refused.ok, false);
});

test('describeCert: trusted chain via a CA, expiry flag', () => {
  const d = describeCert(new X509Certificate(good.certPem).raw, 'mail.example.com', true, null, new Date(Date.now() + 20 * 365 * 86_400_000));
  assert.equal(d.trusted, true);
  assert.equal(d.expired, true);
  assert.equal(servedCertProblem({ protocol: 'imap', port: 1, implicitTls: true, mode: 'tls', ok: true, cert: d }), 'expired');
});

// ── GET /served ──────────────────────────────────────────────────────────────

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../middleware/auth.js');
const { adminCertificatesRouter } = await import('../routes/admin/certificates.js');
const tok = core.signAccessToken({ sub: 'admin', email: 'admin@example.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's', mfaVerified: true });

test('localProbeHost: wildcard/loopback/own interfaces only — never a foreign host (no SSRF via listener rows)', () => {
  const own = new Set(['10.0.0.5', 'fe80::1']);
  assert.equal(localProbeHost('0.0.0.0', own), '127.0.0.1');
  assert.equal(localProbeHost('::', own), '127.0.0.1');
  assert.equal(localProbeHost('', own), '127.0.0.1');
  assert.equal(localProbeHost('localhost', own), '127.0.0.1');
  assert.equal(localProbeHost('127.0.0.2', own), '127.0.0.2');
  assert.equal(localProbeHost('[::1]', own), '::1');
  assert.equal(localProbeHost('10.0.0.5', own), '10.0.0.5', 'own interface address');
  assert.equal(localProbeHost('fe80::1%eth0', own), 'fe80::1');
  assert.equal(localProbeHost('10.0.0.6', own), null, 'other host in the LAN');
  assert.equal(localProbeHost('169.254.169.254', own), null, 'cloud metadata');
  assert.equal(localProbeHost('internal.example.com', own), null, 'host names are never resolved');
});

test('probeServedCert refuses a non-local listener address without connecting', async () => {
  const started = Date.now();
  const r = await probeServedCert({ protocol: 'imap', port: 993, implicitTls: true, host: '203.0.113.7' }, 'mail.example.com', { timeoutMs: 3_000 });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not a local address/);
  assert.ok(Date.now() - started < 500, 'no connection attempt (would wait for the timeout)');
});

test('GET /served probes the configured listeners, matches the cert row and suggests a trusted one', async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use('/api/v1/admin/certificates', requireAuth, adminCertificatesRouter);
  const srv: Server = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    listeners = [
      { service: 'IMAP', address: '0.0.0.0', port: ports['imap'], ssl: false },
      { service: 'SMTP_RECEIVE', address: '127.0.0.1', port: ports['implicit'], ssl: true },
    ];
    const trusted = await createSelfSignedPem(['mail.example.com']);
    certRows = [
      { id: 'self', name: 'mail.localhost', type: 'SELF_SIGNED', status: 'ACTIVE', acmeStaging: false, certPem: other.certPem, keyPem: 'k', isActiveProtocol: true, isActiveHttps: false, services: ['SMTP', 'IMAP', 'POP3'] },
      { id: 'le', name: 'mail.example.com (LE)', type: 'LETSENCRYPT', status: 'ACTIVE', acmeStaging: false, certPem: trusted.certPem, keyPem: 'k', isActiveProtocol: false },
      { id: 'stg', name: 'staging', type: 'LETSENCRYPT', status: 'ACTIVE', acmeStaging: true, certPem: trusted.certPem, keyPem: 'k', isActiveProtocol: false },
    ];
    const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1/admin/certificates/served`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { hostname: string; problem: boolean; ports: Row[]; suggestedCert: Row | null; unreadableKeys: Row[] };
    assert.equal(body.hostname, 'mail.example.com');
    assert.equal(body.problem, true);
    assert.equal(body.ports.length, 2);
    assert.equal(body.ports[0]!['port'], ports['implicit'], 'implicit TLS listeners first');
    const imap = body.ports.find((p) => p['port'] === ports['imap'])!;
    assert.equal(imap['certId'], 'self', 'served cert matched to its row by fingerprint');
    assert.equal(imap['problem'], 'self-signed');
    assert.deepEqual(body.suggestedCert, { id: 'le', name: 'mail.example.com (LE)' });
    // w1: the protocol certificate's stored key ('k') is unreadable → reported by name, no key data
    assert.deepEqual(body.unreadableKeys, [{ id: 'self', name: 'mail.localhost', services: ['SMTP', 'IMAP', 'POP3'], https: false }]);
  } finally {
    srv.close();
  }
});
