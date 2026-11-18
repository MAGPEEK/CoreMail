import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hiddenNamesText, httpsName, legacyServicesTarget, listenerSlug, noticeText, orderedRows, overrideEntryLabel, overrideLink, overrideSummary,
  portsSummary, protocolAnchorId, summaryLine, warningText,
  type HttpsState, type OverrideGroup, type ProtocolOverviewRow,
} from './protocolOverview.ts';

const HTTPS: HttpsState = { active: true, port: 443, cert: { id: 'c1', name: 'le', trusted: true } };
const none: OverrideGroup = { total: 0, differing: 0, entries: [] };
const row = (over: Partial<ProtocolOverviewRow> = {}): ProtocolOverviewRow => ({
  protocol: 'imap', transport: 'listener', listenerService: 'IMAP', server: 'on', ports: [], activePorts: [993],
  overrides: { domains: none, users: none }, enabledAnywhere: true, warnings: [], notices: [], ...over,
});

test('summary line: active ports, then the differing domains and mailboxes', () => {
  const r = row({
    overrides: {
      domains: { total: 3, differing: 2, entries: [] },
      users: { total: 1, differing: 1, entries: [] },
    },
  });
  assert.equal(summaryLine(r, HTTPS), 'aktiv auf 993 · 2 Domains abweichend · 1 Benutzer abweichend');
  assert.equal(summaryLine(row({ activePorts: [143, 993] }), HTTPS), 'aktiv auf 143, 993');
  assert.equal(summaryLine(row({ activePorts: [] }), HTTPS), 'kein Port aktiv');
});

test('summary line of HTTP-based protocols names the HTTPS state', () => {
  const r = row({ protocol: 'activesync', transport: 'http', listenerService: null, activePorts: [] });
  assert.equal(portsSummary(r, HTTPS), 'über HTTPS (Port 443)');
  assert.equal(portsSummary(r, { ...HTTPS, active: false }), 'über HTTP (HTTPS (Port 443) aus)');
});

test('override counts: singular / plural, nothing when no setting differs', () => {
  assert.equal(overrideSummary('domains', { total: 1, differing: 1, entries: [] }), '1 Domain abweichend');
  assert.equal(overrideSummary('users', { total: 5, differing: 2, entries: [] }), '2 Benutzer abweichend');
  assert.equal(overrideSummary('domains', { total: 2, differing: 0, entries: [] }), null);
});

test('override links filter the domain / mailbox list', () => {
  assert.equal(overrideLink('domains', 'one.test'), '/domains?q=one.test');
  assert.equal(overrideLink('users', 'a+b@one.test'), '/mailboxes?q=a%2Bb%40one.test');
  assert.equal(overrideEntryLabel({ id: 'x', name: 'x', setting: 'off', differs: true }), 'aus');
  assert.equal(overrideEntryLabel({ id: 'x', name: 'x', setting: 'on', differs: false }), 'an (wie geerbt)');
});

test('warnings are worded per code', () => {
  assert.equal(warningText({ code: 'no-active-port', protocol: 'pop3' }, HTTPS),
    'POP3 ist erlaubt, aber kein Port ist aktiv — Clients können sich nicht verbinden.');
  assert.match(warningText({ code: 'port-open-access-off', protocol: 'imap', ports: [143, 993] }, HTTPS),
    /^IMAP: Port offen \(143, 993\), Anmeldung für alle gesperrt/);
  assert.match(warningText({ code: 'mapi-https', protocol: 'mapi' }, HTTPS), /HTTPS \(Port 443\) ist nicht aktiv oder hat kein vertrauenswürdiges Zertifikat/);
});

test('display order puts SMTP sending first; listener slugs; HTTPS name', () => {
  const rows = ['imap', 'mapi', 'smtp', 'webmail'].map((p) => row({ protocol: p as ProtocolOverviewRow['protocol'] }));
  assert.deepEqual(orderedRows({ protocols: rows }).map((r) => r.protocol), ['smtp', 'imap', 'webmail', 'mapi']);
  assert.equal(listenerSlug('SMTP_RECEIVE'), 'smtp-receive');
  assert.equal(listenerSlug('IMAP'), 'imap');
  assert.equal(httpsName(8443), 'HTTPS (Port 8443)');
});

test('notice: port open, login only for the differing domains / mailboxes', () => {
  assert.equal(noticeText({ code: 'port-open-access-limited', protocol: 'imap', ports: [143, 993] }),
    'IMAP: Port offen (143, 993); Anmeldung nur für abweichende Domains/Benutzer.');
});

test('hidden names: a hint instead of the list', () => {
  assert.match(hiddenNamesText('users'), /Empfänger/);
  assert.match(hiddenNamesText('domains'), /Domains/);
});

test('old /services/<sub> links land on the matching card', () => {
  assert.equal(legacyServicesTarget('imap'), '/services#protocol-imap');
  assert.equal(legacyServicesTarget('POP3'), '/services#protocol-pop3');
  assert.equal(legacyServicesTarget('smtp-receive'), '/services#protocol-smtp');
  assert.equal(legacyServicesTarget('smtp-inbound'), '/services#smtp-inbound');
  assert.equal(legacyServicesTarget('protocols'), '/services');
  assert.equal(legacyServicesTarget('nonsense'), '/services');
  assert.equal(legacyServicesTarget(undefined), '/services');
  assert.equal(protocolAnchorId('mapi'), 'protocol-mapi');
});
