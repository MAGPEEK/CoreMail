import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  certServiceChips, chipLabel, httpsSwitchLabel, httpsSwitchName, mailFixSuggestion, mailSwitchLabel,
  portLabel, problemPorts, problemText, warningSummary, type ServedReport, type ServedPort,
} from './servedCert.ts';

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

test('unreadable private key: names the certificate, what the protocols do now and what to do', async () => {
  const { unreadableKeyText } = await import('./servedCert.ts');
  assert.equal(
    unreadableKeyText({ id: 'c1', name: 'Firmenzertifikat', services: ['SMTP', 'IMAP', 'POP3'], https: false }),
    'Privater Schlüssel von Firmenzertifikat nicht lesbar — Mail-Protokolle nutzen das selbstsignierte Ersatzzertifikat; Zertifikat neu ausstellen oder hochladen',
  );
  assert.match(unreadableKeyText({ id: 'c2', name: 'Web', services: [], https: true }), /^Privater Schlüssel von Web nicht lesbar — HTTPS liefert es nicht aus; /);
  assert.match(unreadableKeyText({ id: 'c3', name: 'Beides', services: ['SMTP'], https: true }), /Ersatzzertifikat, HTTPS liefert es nicht aus/);
});

test('the served-certificate warning (SSL/TLS page + dashboard) renders unreadable keys', async () => {
  const { readFileSync } = await import('node:fs');
  const component = readFileSync(new URL('../components/ServedCert.tsx', import.meta.url), 'utf8');
  assert.match(component, /data\?\.unreadableKeys \?\? \[\]/, 'older servers send no field');
  assert.match(component, /<UnreadableKeyWarning certs=\{unreadable\}/);
  assert.match(component, /unreadableKeyText\(c\)/);
  for (const page of ['../pages/CertificatesPage.tsx', '../pages/DashboardPage.tsx']) {
    assert.match(readFileSync(new URL(page, import.meta.url), 'utf8'), /<ServedCertWarning\b/, page);
  }
});

// ── w2b: status chips in the certificate overview ────────────────────────────

const report = (over: Partial<ServedReport> = {}): ServedReport => ({
  hostname: 'mail.example.com', problem: false, suggestedCert: null, ports: [], ...over,
});
const trusted = cert('mail.example.com', { selfSigned: false, hostnameMatch: true, trusted: true });
const mine = (protocol: ServedPort['protocol'], p: number, tls: boolean) =>
  port(protocol, p, tls, { cert: trusted, certId: 'le', certName: 'LE' });
const holder = { id: 'le', services: ['SMTP', 'IMAP', 'POP3'], isActiveHttps: true };

test('chips: one per held service (mail protocols in order, HTTPS last); none for an unused certificate', () => {
  assert.deepEqual(certServiceChips(holder, report()).map((c) => c.service), ['SMTP', 'IMAP', 'POP3', 'HTTPS']);
  assert.deepEqual(certServiceChips({ id: 'x', services: ['IMAP'], isActiveHttps: false }, report()).map((c) => c.service), ['IMAP'], 'legacy partial set');
  assert.deepEqual(certServiceChips({ id: 'x', services: [], isActiveHttps: false }, report()), []);
});

test('chips: OK when every reachable port of the service serves this certificate', () => {
  const r = report({
    ports: [mine('imap', 993, true), mine('imap', 143, false), mine('smtp', 465, true),
      port('smtp', 25, false, { ok: false, error: 'STARTTLS not offered' }), mine('pop3', 995, true)],
    https: mine('https', 443, true),
  });
  const chips = certServiceChips(holder, r);
  assert.deepEqual(chips.map((c) => c.state), ['ok', 'ok', 'ok', 'ok']);
  const smtp = chips.find((c) => c.service === 'SMTP')!;
  assert.deepEqual(smtp.details, ['SMTP 465 (TLS): liefert dieses Zertifikat', 'SMTP 25 (STARTTLS): nicht erreichbar (STARTTLS not offered)']);
  assert.equal(chipLabel(smtp), 'SMTP: OK, dieses Zertifikat wird ausgeliefert');
});

test('chips: warning lists the ports that serve another / self-signed / mismatched / expired certificate', () => {
  const r = report({
    problem: true,
    ports: [
      mine('imap', 993, true),
      port('imap', 143, false, { cert: cert('mail.localhost'), problem: 'self-signed', certId: 'self', certName: 'Standard' }),
      port('smtp', 465, true, { cert: cert('other.example.org', { selfSigned: false }), problem: 'hostname-mismatch' }),
      port('pop3', 995, true, { cert: cert('mail.example.com', { selfSigned: false, hostnameMatch: true, expired: true }), problem: 'expired', certId: 'le', certName: 'LE' }),
    ],
    https: port('https', 443, true, { cert: trusted, certId: 'web', certName: 'Web' }),
  });
  const [smtp, imap, pop3, https] = certServiceChips(holder, r);
  assert.equal(imap!.state, 'warning');
  assert.deepEqual(imap!.details, [
    'IMAP 993 (TLS): liefert dieses Zertifikat',
    'IMAP 143 (STARTTLS): selbstsigniert — Outlook/iPhone vertrauen diesem Zertifikat nicht („Standard“)',
  ]);
  assert.deepEqual(smtp!.details, ['SMTP 465 (TLS): passt nicht zu mail.example.com (CN=other.example.org)']);
  assert.equal(pop3!.state, 'warning');
  assert.deepEqual(pop3!.details, ['POP3 995 (TLS): abgelaufen („LE“)']);
  assert.equal(https!.state, 'warning');
  assert.deepEqual(https!.details, ['HTTPS 443 (TLS): liefert ein anderes Zertifikat („Web“)']);
  assert.equal(chipLabel(https!), 'HTTPS: Warnung');
});

test('chips: unknown while loading, without ports or when every port is unreachable; HTTPS server not running = warning', () => {
  assert.deepEqual(certServiceChips(holder, undefined).map((c) => c.state), ['unknown', 'unknown', 'unknown', 'unknown']);
  const r = report({ ports: [port('smtp', 25, false, { ok: false, error: 'refused' })] });
  const [smtp, imap, , httpsOld] = certServiceChips(holder, r);
  assert.equal(smtp!.state, 'unknown');
  assert.equal(imap!.state, 'unknown');
  assert.deepEqual(imap!.details, ['Kein aktiver Port gefunden']);
  assert.equal(httpsOld!.state, 'unknown', 'older server without the https field');
  assert.equal(chipLabel(httpsOld!), 'HTTPS: nicht geprüft');
  const notRunning = certServiceChips(holder, report({ https: null }))[3]!;
  assert.equal(notRunning.state, 'warning');
  assert.match(notRunning.details[0]!, /HTTPS-Server läuft nicht/);
});

test('mailFixSuggestion: the suggested certificate only when a mail chip warns', () => {
  const suggestedCert = { id: 'le', name: 'LE' };
  const warn = report({ problem: true, suggestedCert, ports: [port('imap', 993, true, { cert: cert('mail.localhost'), problem: 'self-signed' })], https: null });
  const self = { id: 'self', services: ['SMTP', 'IMAP', 'POP3'], isActiveHttps: false };
  assert.deepEqual(mailFixSuggestion(certServiceChips(self, warn), warn), suggestedCert);
  const httpsOnly = { id: 'web', services: [], isActiveHttps: true };
  assert.equal(mailFixSuggestion(certServiceChips(httpsOnly, warn), warn), null, 'HTTPS warnings are fixed with the HTTPS switch');
  assert.equal(mailFixSuggestion(certServiceChips(self, warn), { ...warn, suggestedCert: null }), null, 'nothing to assign');
  assert.equal(mailFixSuggestion([], undefined), null);
});

test('SSL/TLS page: per-service chips in the overview instead of a separate served-certificate table', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../pages/CertificatesPage.tsx', import.meta.url), 'utf8');
  const component = readFileSync(new URL('../components/ServedCert.tsx', import.meta.url), 'utf8');
  assert.match(page, /<CertServiceChips cert=\{cert\} \/>/);
  assert.doesNotMatch(page + component, /ServedCertTable|Tatsächlich ausgeliefert/);
  assert.match(page, /aria-pressed=\{true\} aria-label=\{httpsSwitchLabel\(httpsPort\)\}/, 'HTTPS switch names what it does');
  assert.match(component, /role="tooltip"/);
  assert.match(component, /aria-describedby=\{tipId\}/);
});

test('switch labels say what each switch does', () => {
  assert.equal(httpsSwitchName(8443), 'HTTPS (Port 8443)');
  assert.equal(httpsSwitchLabel(443),
    'HTTPS (Port 443): Dieses Zertifikat für Webmail/BCP/ActiveSync/Autodiscover über den integrierten HTTPS-Server verwenden');
  assert.equal(mailSwitchLabel(false), 'Mail-Protokolle (SMTP · IMAP · POP3): Dieses Zertifikat sofort verwenden');
  assert.match(mailSwitchLabel(true), /^Mail-Protokolle \(SMTP · IMAP · POP3\): aktiv/);
});

test('w2b: a wrong HTTPS certificate raises its own warning line; a matching one or a silent server does not', async () => {
  const { httpsServedProblem, httpsWarningText } = await import('./servedCert.ts');
  const base: ServedReport = { hostname: 'mail.example.com', problem: false, suggestedCert: null, ports: [] };
  const wrong = port('https', 443, true, { problem: 'hostname-mismatch', cert: cert('mail.localhost') });
  assert.equal(httpsServedProblem({ ...base, https: wrong }), wrong);
  assert.equal(httpsWarningText(base, wrong), 'HTTPS (Port 443): passt nicht zu mail.example.com (CN=mail.localhost)');
  assert.equal(httpsServedProblem({ ...base, https: port('https', 443, true) }), null);
  assert.equal(httpsServedProblem({ ...base, https: null }), null, 'not listening is the chip\'s job, not a wrong certificate');
  assert.equal(httpsServedProblem(base), null, 'older servers without the HTTPS probe');
  assert.equal(httpsServedProblem(undefined), null);
});
