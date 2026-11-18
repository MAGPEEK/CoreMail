/**
 * w2b: combined protocol model (ports vs. access) — pure builder, override
 * counts, consistency warnings, HTTPS trust check.
 * Run: node --import tsx --test src/lib/protocol-overview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma(); // pure module under test; the seam keeps @coremail/storage from opening a real client
const { inheritAll } = await import('@coremail/storage');
const {
  buildProtocolOverview, protocolWarnings, protocolNotices, redactOverrideNames, isTrustedHttpsCert, submissionPorts, OVERRIDE_LIST_LIMIT,
} = await import('./protocol-overview.js');
type Input = Parameters<typeof buildProtocolOverview>[0];

const SERVER = { imap: 'on', pop3: 'on', smtp: 'on', activesync: 'on', jmap: 'on', dav: 'on', webmail: 'on', mapi: 'off' } as const;
const listener = (id: string, service: string, port: number, ssl: boolean, active = true) =>
  ({ id, service, address: '0.0.0.0', port, ssl, active, allowLegacyTls: false });
const DEFAULT_LISTENERS = [
  listener('l25', 'SMTP_RECEIVE', 25, false), listener('l465', 'SMTP_RECEIVE', 465, true), listener('l587', 'SMTP_RECEIVE', 587, false),
  listener('l143', 'IMAP', 143, false), listener('l993', 'IMAP', 993, true),
  listener('l110', 'POP3', 110, false), listener('l995', 'POP3', 995, true),
];
const HTTPS_OK = { active: true, port: 443, cert: { id: 'c1', name: 'le', trusted: true } };

function input(over: Partial<Input> = {}, overrides: Partial<Input['overrides']> = {}): Input {
  return {
    overrides: { server: { ...SERVER }, domains: [], users: [], ...overrides },
    listeners: DEFAULT_LISTENERS,
    https: HTTPS_OK,
    submissionPorts: [465, 587],
    ...over,
  };
}
const row = (o: ReturnType<typeof buildProtocolOverview>, p: string) => o.protocols.find((r) => r.protocol === p)!;

test('one row per access protocol; mail protocols own their ports, the others run on the HTTP server', () => {
  const o = buildProtocolOverview(input());
  assert.deepEqual(o.protocols.map((r) => r.protocol), ['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi']);
  assert.deepEqual(row(o, 'imap').activePorts, [143, 993]);
  assert.deepEqual(row(o, 'imap').ports.map((p) => p.tlsMode), ['starttls', 'tls']);
  assert.equal(row(o, 'imap').listenerService, 'IMAP');
  assert.deepEqual(row(o, 'smtp').activePorts, [465, 587], 'submission = the submission ports only');
  assert.equal(row(o, 'smtp').listenerService, 'SMTP_RECEIVE');
  assert.deepEqual(o.smtpInbound.activePorts, [25], 'port 25 is transport, not user access');
  for (const p of ['activesync', 'jmap', 'dav', 'webmail', 'mapi']) {
    assert.equal(row(o, p).transport, 'http');
    assert.deepEqual(row(o, p).ports, []);
    assert.equal(row(o, p).listenerService, null);
  }
  assert.equal(row(o, 'mapi').server, 'off');
  assert.deepEqual(o.warnings, [], 'the defaults are consistent');
});

test('custom ports: by service for IMAP/POP3, by submission port for SMTP; duplicate ports on two addresses count once', () => {
  const listeners = [
    ...DEFAULT_LISTENERS,
    listener('l2525', 'SMTP_RECEIVE', 2525, false),
    listener('l1993', 'IMAP', 1993, true),
    { ...listener('l993b', 'IMAP', 993, true), address: '10.0.0.1' },
    listener('l1995', 'POP3', 1995, true, false),
  ];
  const o = buildProtocolOverview(input({ listeners }));
  assert.deepEqual(o.smtpInbound.activePorts, [25, 2525], 'a non-submission SMTP port is inbound, as in smtp-server');
  assert.deepEqual(row(o, 'smtp').activePorts, [465, 587]);
  assert.deepEqual(row(o, 'imap').activePorts, [143, 993, 1993]);
  assert.equal(row(o, 'imap').ports.length, 4);
  assert.deepEqual(row(o, 'pop3').activePorts, [110, 995], 'inactive custom port is listed but not active');
  assert.equal(row(o, 'pop3').ports.length, 3);
  const custom = buildProtocolOverview(input({ listeners: [listener('s', 'SMTP_RECEIVE', 2587, false)], submissionPorts: [2465, 2587] }));
  assert.deepEqual(row(custom, 'smtp').activePorts, [2587], 'SMTP_PORT_587 moved: the moved port is submission');
  assert.deepEqual(custom.smtpInbound.activePorts, []);
});

test('overrides: counts per level, "differs" against what the level inherits, user rows see their domain', () => {
  const o = buildProtocolOverview(input({}, {
    domains: [
      { id: 'd1', name: 'one.test', settings: { ...inheritAll(), imap: 'off' } },
      { id: 'd2', name: 'two.test', settings: { ...inheritAll(), imap: 'on' } },
    ],
    users: [
      { id: 'u1', email: 'a@one.test', domainId: 'd1', settings: { ...inheritAll(), imap: 'on' } },
      { id: 'u2', email: 'b@one.test', domainId: 'd1', settings: { ...inheritAll(), imap: 'off' } },
      { id: 'u3', email: 'c@two.test', domainId: 'd2', settings: { ...inheritAll(), pop3: 'off' } },
    ],
  }));
  const imap = row(o, 'imap').overrides;
  assert.equal(imap.domains.total, 2);
  assert.equal(imap.domains.differing, 1, 'one.test off differs from the server, two.test on does not');
  assert.deepEqual(imap.domains.entries.map((e) => [e.name, e.setting, e.differs]), [['one.test', 'off', true], ['two.test', 'on', false]]);
  assert.equal(imap.users.total, 2);
  assert.deepEqual(imap.users.entries.map((e) => [e.name, e.differs]), [['a@one.test', true], ['b@one.test', false]],
    'a user is compared with its domain (one.test is off)');
  assert.equal(row(o, 'pop3').overrides.users.differing, 1);
  assert.equal(row(o, 'smtp').overrides.users.total, 0);
});

test('override lists are capped, the counts are not', () => {
  const users = Array.from({ length: OVERRIDE_LIST_LIMIT + 5 }, (_, i) => ({
    id: `u${i}`, email: `u${String(i).padStart(3, '0')}@one.test`, domainId: 'd1', settings: { ...inheritAll(), pop3: 'off' as const },
  }));
  const pop3 = row(buildProtocolOverview(input({}, { users })), 'pop3').overrides.users;
  assert.equal(pop3.total, OVERRIDE_LIST_LIMIT + 5);
  assert.equal(pop3.differing, OVERRIDE_LIST_LIMIT + 5);
  assert.equal(pop3.entries.length, OVERRIDE_LIST_LIMIT);
  assert.equal(pop3.entries[0]!.name, 'u000@one.test');
});

test('warning: protocol allowed but no active port', () => {
  const listeners = DEFAULT_LISTENERS.map((l) => (l.service === 'POP3' ? { ...l, active: false } : l));
  const o = buildProtocolOverview(input({ listeners }));
  assert.deepEqual(o.warnings, [{ code: 'no-active-port', protocol: 'pop3' }]);
});

test('warning: port open while nobody may log in; an override switching it on clears it', () => {
  const server = { ...SERVER, pop3: 'off' as const };
  const o = buildProtocolOverview(input({}, { server }));
  assert.deepEqual(o.warnings, [{ code: 'port-open-access-off', protocol: 'pop3', ports: [110, 995] }]);
  assert.equal(row(o, 'pop3').enabledAnywhere, false);
  const withUser = buildProtocolOverview(input({}, {
    server, users: [{ id: 'u1', email: 'a@one.test', domainId: 'd1', settings: { ...inheritAll(), pop3: 'on' } }],
  }));
  assert.equal(row(withUser, 'pop3').enabledAnywhere, true);
  assert.deepEqual(withUser.warnings, []);
  assert.deepEqual(withUser.notices, [{ code: 'port-open-access-limited', protocol: 'pop3', ports: [110, 995] }],
    'not silent: a softer notice says only the differing domains / mailboxes may log in');
  assert.deepEqual(row(withUser, 'pop3').notices, withUser.notices);
  assert.deepEqual(o.notices, [], 'off for everyone is a warning, not a notice');
  const noPorts = buildProtocolOverview(input({ listeners: DEFAULT_LISTENERS.filter((l) => l.service !== 'POP3') }, { server }));
  assert.deepEqual(noPorts.warnings, [], 'off and no port is consistent');
});

test('warning: MAPI on without an active, trusted HTTPS certificate', () => {
  const on = { server: { ...SERVER, mapi: 'on' as const } };
  assert.deepEqual(buildProtocolOverview(input({}, on)).warnings, []);
  for (const https of [
    { ...HTTPS_OK, active: false },
    { ...HTTPS_OK, cert: null },
    { ...HTTPS_OK, cert: { id: 'c2', name: 'self', trusted: false } },
  ]) {
    assert.deepEqual(buildProtocolOverview(input({ https }, on)).warnings, [{ code: 'mapi-https', protocol: 'mapi' }]);
  }
  const domainOnly = buildProtocolOverview(input({ https: { ...HTTPS_OK, active: false } }, {
    domains: [{ id: 'd1', name: 'one.test', settings: { ...inheritAll(), mapi: 'on' } }],
  }));
  assert.deepEqual(domainOnly.warnings, [{ code: 'mapi-https', protocol: 'mapi' }], 'MAPI on for one domain is enough');
  assert.deepEqual(buildProtocolOverview(input({ https: { ...HTTPS_OK, active: false } })).warnings, [], 'MAPI off: no warning');
});

test('protocolWarnings: HTTP-based protocols never get port warnings', () => {
  assert.deepEqual(protocolWarnings({ protocol: 'jmap', transport: 'http', activePorts: [], enabledAnywhere: true }, HTTPS_OK), []);
});

test('protocolNotices: only listener protocols, server off, switched on below, a port listening', () => {
  const base = { protocol: 'imap' as const, transport: 'listener' as const, server: 'off' as const, activePorts: [993], enabledAnywhere: true };
  assert.deepEqual(protocolNotices(base), [{ code: 'port-open-access-limited', protocol: 'imap', ports: [993] }]);
  assert.deepEqual(protocolNotices({ ...base, server: 'on' }), [], 'server on: nothing to say');
  assert.deepEqual(protocolNotices({ ...base, activePorts: [] }), [], 'no port: the no-active-port warning applies');
  assert.deepEqual(protocolNotices({ ...base, enabledAnywhere: false }), [], 'nobody: the port-open-access-off warning applies');
  assert.deepEqual(protocolNotices({ ...base, protocol: 'jmap', transport: 'http' as const, activePorts: [] }), []);
});

test('redactOverrideNames: counts stay, names only for readers of domains / recipients', () => {
  const o = buildProtocolOverview(input({}, {
    domains: [{ id: 'd1', name: 'one.test', settings: { ...inheritAll(), imap: 'off' } }],
    users: [{ id: 'u1', email: 'a@one.test', domainId: 'd1', settings: { ...inheritAll(), imap: 'on' } }],
  }));
  assert.equal(redactOverrideNames(o, { domains: true, users: true }), o);
  const r = redactOverrideNames(o, { domains: true, users: false });
  const imap = row(r, 'imap').overrides;
  assert.equal(imap.domains.entries[0]!.name, 'one.test');
  assert.deepEqual(imap.users, { total: 1, differing: 1, entries: [], namesHidden: true });
  assert.ok(!JSON.stringify(r).includes('a@one.test'), 'no mailbox address anywhere in the answer');
  const none = redactOverrideNames(o, { domains: false, users: false });
  assert.ok(!JSON.stringify(none).includes('one.test'));
  assert.equal(row(none, 'imap').overrides.domains.namesHidden, true);
});

test('submission ports follow SMTP_PORT_465 / SMTP_PORT_587', () => {
  assert.deepEqual(submissionPorts({}), [465, 587]);
  assert.deepEqual(submissionPorts({ SMTP_PORT_587: '2587' }), [465, 2587]);
});

// ── HTTPS trust ───────────────────────────────────────────────────────────────

function certPem(opts: { cn: string; issuer: string; days?: number }): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + (opts.days ?? 30) * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: opts.cn }]);
  cert.setIssuer([{ name: 'commonName', value: opts.issuer }]);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: opts.cn }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

test('isTrustedHttpsCert: CA-issued, valid, covering the host name; never self-signed or staging', () => {
  const issued = certPem({ cn: 'mail.example.test', issuer: 'Test CA' });
  const ok = { type: 'LETSENCRYPT', acmeStaging: false, certPem: issued, status: 'ACTIVE' };
  assert.equal(isTrustedHttpsCert(ok, 'mail.example.test'), true);
  assert.equal(isTrustedHttpsCert(ok, 'other.example.test'), false, 'name mismatch');
  assert.equal(isTrustedHttpsCert({ ...ok, acmeStaging: true }, 'mail.example.test'), false, 'staging');
  assert.equal(isTrustedHttpsCert({ ...ok, type: 'SELF_SIGNED' }, 'mail.example.test'), false);
  assert.equal(isTrustedHttpsCert({ ...ok, type: 'UPLOADED', certPem: certPem({ cn: 'mail.example.test', issuer: 'mail.example.test' }) }, 'mail.example.test'), false,
    'an uploaded self-issued certificate');
  assert.equal(isTrustedHttpsCert({ ...ok, certPem: null }, 'mail.example.test'), false);
});
