import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portLabel, problemPorts, problemText, warningSummary, type ServedReport, type ServedPort } from './servedCert.ts';

const cert = (cn: string, over: Partial<NonNullable<ServedPort['cert']>> = {}) => ({
  subject: `CN=${cn}`, issuer: `CN=${cn}`, commonName: cn, altNames: [cn], validFrom: '', validTo: '',
  fingerprint256: 'AA', selfSigned: true, hostnameMatch: false, trusted: false, trustError: null, expired: false, ...over,
});
const port = (protocol: ServedPort['protocol'], p: number, tls: boolean, over: Partial<ServedPort> = {}): ServedPort => ({
  protocol, port: p, implicitTls: tls, mode: tls ? 'tls' : 'starttls', ok: true, problem: null, certId: null, certName: null, ...over,
});

test('portLabel', () => {
  assert.equal(portLabel(port('imap', 993, true)), 'IMAP 993 (TLS)');
  assert.equal(portLabel(port('smtp', 587, false)), 'SMTP 587 (STARTTLS)');
});

test('problemText names the host for a mismatch', () => {
  assert.match(problemText('self-signed', 'mail.example.com'), /selbstsigniert/);
  assert.equal(problemText('hostname-mismatch', 'mail.example.com'), 'passt nicht zu mail.example.com');
  assert.equal(problemText(null, 'x'), 'OK');
});

test('warningSummary groups ports with the same problem and CN', () => {
  const report: ServedReport = {
    hostname: 'mail.example.com',
    problem: true,
    suggestedCert: null,
    ports: [
      port('imap', 993, true, { problem: 'self-signed', cert: cert('mail.localhost') }),
      port('smtp', 465, true, { problem: 'self-signed', cert: cert('mail.localhost') }),
      port('pop3', 995, true, { cert: cert('mail.example.com', { selfSigned: false, hostnameMatch: true }) }),
      port('smtp', 25, false, { ok: false, error: 'STARTTLS not offered' }),
    ],
  };
  assert.equal(problemPorts(report).length, 2);
  assert.equal(warningSummary(report), 'IMAP 993 (TLS), SMTP 465 (TLS): selbstsigniert — Outlook/iPhone vertrauen diesem Zertifikat nicht (CN=mail.localhost)');
  assert.deepEqual(problemPorts(null), []);
});
