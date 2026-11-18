/**
 * `coremail protocol` helpers (9.4): scope parsing, option → PUT body, table rows.
 * Run: node --import tsx --test src/commands/protocol.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProtocolPatch, parseScope, protocolRows, PROTOCOLS, type ProtocolView } from './protocol.js';

test('scope: global by default, domain/user, anything else is refused', () => {
  assert.equal(parseScope(undefined), 'global');
  assert.equal(parseScope('Domain'), 'domain');
  assert.equal(parseScope('user'), 'user');
  assert.throws(() => parseScope('tenant'), /Invalid --scope/);
});

test('patch: only the given switches, values validated, at least one required', () => {
  assert.deepEqual(buildProtocolPatch({ imap: 'OFF', webmail: ' inherit ' }, 'user'), { imap: 'off', webmail: 'inherit' });
  assert.throws(() => buildProtocolPatch({ imap: 'disabled' }, 'domain'), /--imap: inherit, on, off on the domain level/);
  assert.throws(() => buildProtocolPatch({}, 'user'), /Nothing to set/);
});

test('patch: the server level is two-state (no inherit)', () => {
  assert.deepEqual(buildProtocolPatch({ mapi: 'on', pop3: 'off' }, 'global'), { mapi: 'on', pop3: 'off' });
  assert.throws(() => buildProtocolPatch({ imap: 'inherit' }, 'global'), /--imap: on, off on the global level/);
});

test('rows: inherit shows what it resolves to', () => {
  const all = <T>(v: T) => Object.fromEntries(PROTOCOLS.map((p) => [p, v])) as Record<(typeof PROTOCOLS)[number], T>;
  const view: ProtocolView = {
    level: 'domain', settings: { ...all('inherit' as const), pop3: 'off' },
    inherited: { ...all(true), mapi: false }, effective: { ...all(true), pop3: false, mapi: false },
  };
  const rows = protocolRows(view);
  assert.deepEqual(rows.find((r) => r['protocol'] === 'imap'), { protocol: 'imap', setting: 'inherit (on)', effective: 'on' });
  assert.deepEqual(rows.find((r) => r['protocol'] === 'pop3'), { protocol: 'pop3', setting: 'off', effective: 'off' });
});

test('w2b: combined view — one row per protocol, HTTP-based ones on HTTPS, warnings worded', async () => {
  const { overviewRows, warningLine } = await import('./protocol.js');
  const group = (differing: number) => ({ total: differing, differing, entries: [] });
  const https = { active: true, port: 443, cert: { name: 'le', trusted: true } };
  const rows = overviewRows({
    protocols: [
      { protocol: 'imap', transport: 'listener', server: 'on', activePorts: [143, 993], overrides: { domains: group(2), users: group(0) }, warnings: [] },
      { protocol: 'pop3', transport: 'listener', server: 'off', activePorts: [], overrides: { domains: group(0), users: group(1) }, warnings: [] },
      { protocol: 'mapi', transport: 'http', server: 'off', activePorts: [], overrides: { domains: group(0), users: group(0) }, warnings: [] },
    ],
    smtpInbound: { activePorts: [25] },
    https,
    warnings: [],
  });
  assert.deepEqual(rows[0], { protocol: 'imap', access: 'on', ports: '143, 993', domains: '2 differ', mailboxes: '-' });
  assert.deepEqual(rows[1], { protocol: 'pop3', access: 'off', ports: 'none active', domains: '-', mailboxes: '1 differ' });
  assert.equal(rows[2]!['ports'], 'HTTPS 443');
  assert.equal(warningLine({ code: 'port-open-access-off', protocol: 'pop3', ports: [110, 995] }, https),
    'pop3: port open (110, 995), login refused for everyone');
  assert.match(warningLine({ code: 'mapi-https', protocol: 'mapi' }, https), /HTTPS \(port 443\) is not active or has no trusted certificate/);
  assert.match(warningLine({ code: 'no-active-port', protocol: 'imap' }, https), /no port is active/);
});

test('w2b: notice when a port is open and only differing domains / mailboxes may log in', async () => {
  const { noticeLine } = await import('./protocol.js');
  assert.equal(noticeLine({ code: 'port-open-access-limited', protocol: 'imap', ports: [993] }),
    'imap: port open (993); login only for the differing domains / mailboxes');
});
