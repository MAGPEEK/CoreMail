/**
 * Apple configuration profile (v8.1): auth required, plist parses back (minimal XML plist
 * parser below), expected payloads, no password, stable UUIDs, escaping, EAS variant.
 * Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test --test-force-exit src/routes/apple-profile.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

const state = {
  mfa: null as null | { totpEnabled: boolean; webAuthnCredentials: unknown },
};

installFakePrisma({
  user: {
    findUnique: (a) => {
      const id = (a as { where: { id: string } }).where.id;
      if (id === 'ghost') return null;
      return { email: `${id}@example.com`, displayName: 'Alice <A&B>', role: 'USER', active: true };
    },
  },
  serverSettings: {
    findUnique: () => ({
      publicHostname: 'mail.example.com', useHttps: true, httpPort: 443, orgName: 'Acme & Co',
      easUrl: 'https://mail.example.com/Microsoft-Server-ActiveSync',
      imapHost: 'imap.example.com', imapPort: 993, imapSsl: true,
      smtpHost: 'smtp.example.com', smtpPort: 587, smtpTls: true,
    }),
  },
  userMfa: { findUnique: () => state.mfa },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { appleProfileRouter, stableUuid, toPlist } = await import('./apple-profile.js');

const tok = (sub: string) => core.signAccessToken({ sub, email: `${sub}@example.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use('/api/v1/user/apple-profile', appleProfileRouter);
  app.use('/api/v1/user', (await import('./user.js')).userRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

// ── Minimal XML plist parser (dict/array/string/integer/true/false) ───────────
type PV = string | number | boolean | PV[] | { [k: string]: PV };
function parsePlist(xml: string): PV {
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1.0\/\/EN" "http:\/\/www.apple.com\/DTDs\/PropertyList-1.0.dtd">\n<plist version="1.0">/);
  const body = xml.slice(xml.indexOf('<plist version="1.0">') + '<plist version="1.0">'.length, xml.lastIndexOf('</plist>'));
  const tokens = [...body.matchAll(/<(\/?)(\w+)(\/?)>([^<]*)/g)];
  let i = 0;
  const unescape = (s: string) => {
    assert.doesNotMatch(s, /&(?!amp;|lt;|gt;)/, `unescaped & in ${s}`);
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  };
  function value(): PV {
    const [, close, tag, selfClose, text] = tokens[i++]!;
    assert.equal(close, '', `unexpected closing tag ${tag}`);
    if (tag === 'true' || tag === 'false') { assert.equal(selfClose, '/'); return tag === 'true'; }
    if (selfClose === '/') return tag === 'array' ? [] : {};
    if (tag === 'string') { assert.equal(tokens[i++]![2], 'string'); return unescape(text!); }
    if (tag === 'integer') { assert.equal(tokens[i++]![2], 'integer'); assert.match(text!, /^-?\d+$/); return Number(text); }
    if (tag === 'array') {
      const out: PV[] = [];
      while (!(tokens[i]![1] === '/' && tokens[i]![2] === 'array')) out.push(value());
      i++;
      return out;
    }
    if (tag === 'dict') {
      const out: Record<string, PV> = {};
      while (!(tokens[i]![1] === '/' && tokens[i]![2] === 'dict')) {
        const [, , ktag, , ktext] = tokens[i++]!;
        assert.equal(ktag, 'key');
        assert.equal(tokens[i++]![2], 'key');
        const k = unescape(ktext!);
        assert.ok(!(k in out), `duplicate key ${k}`);
        out[k] = value();
      }
      i++;
      return out;
    }
    throw new Error(`unknown plist tag ${tag}`);
  }
  const root = value();
  assert.equal(i, tokens.length, 'trailing content after the root value');
  return root;
}

async function getProfile(query = '', token: string | null = tok('alice')) {
  return fetch(`${base}/api/v1/user/apple-profile${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;

test('authentication is required', async () => {
  assert.equal((await getProfile('', null)).status, 401);
  assert.equal((await getProfile('', 'garbage')).status, 401);
  const viaQuery = await fetch(`${base}/api/v1/user/apple-profile?token=${tok('alice')}`);
  assert.equal(viaQuery.status, 401, 'no token in the URL');
});

test('IMAP profile: valid plist with mail + CalDAV + CardDAV payloads and no password', async () => {
  state.mfa = null;
  const res = await getProfile();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/x-apple-aspen-config/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="example.com.mobileconfig"');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const xml = await res.text();
  assert.doesNotMatch(xml, /Password<\/key>\s*<string>/, 'no password value');
  assert.doesNotMatch(xml, /<key>(IncomingPassword|OutgoingPassword|Password|CalDAVPassword|CardDAVPassword)<\/key>/);

  const root = parsePlist(xml) as Record<string, PV>;
  assert.equal(root['PayloadType'], 'Configuration');
  assert.equal(root['PayloadVersion'], 1);
  assert.equal(root['PayloadIdentifier'], 'com.example.mail.coremail.alice.profile');
  assert.match(String(root['PayloadUUID']), UUID_RE);
  assert.equal(root['PayloadOrganization'], 'Acme & Co');
  const content = root['PayloadContent'] as Record<string, PV>[];
  assert.deepEqual(content.map((p) => p['PayloadType']), ['com.apple.mail.managed', 'com.apple.caldav.account', 'com.apple.carddav.account']);

  const [mail, cal, card] = content as [Record<string, PV>, Record<string, PV>, Record<string, PV>];
  assert.equal(mail['EmailAccountType'], 'EmailTypeIMAP');
  assert.equal(mail['EmailAddress'], 'alice@example.com');
  assert.equal(mail['EmailAccountName'], 'Alice <A&B>', 'escaped and parsed back');
  assert.equal(mail['IncomingMailServerHostName'], 'imap.example.com');
  assert.equal(mail['IncomingMailServerPortNumber'], 993);
  assert.equal(mail['IncomingMailServerUseSSL'], true);
  assert.equal(mail['IncomingMailServerUsername'], 'alice@example.com');
  assert.equal(mail['OutgoingMailServerHostName'], 'smtp.example.com');
  assert.equal(mail['OutgoingMailServerPortNumber'], 587);
  assert.equal(mail['OutgoingMailServerUseSSL'], true);
  assert.equal(mail['OutgoingPasswordSameAsIncomingPassword'], true);
  assert.equal(cal['CalDAVHostName'], 'mail.example.com');
  assert.equal(cal['CalDAVPort'], 443);
  assert.equal(cal['CalDAVUseSSL'], true);
  assert.equal(cal['CalDAVPrincipalURL'], 'https://mail.example.com/dav/principals/alice/');
  assert.equal(cal['CalDAVUsername'], 'alice@example.com');
  assert.equal(card['CardDAVHostName'], 'mail.example.com');
  assert.equal(card['CardDAVPrincipalURL'], 'https://mail.example.com/dav/principals/alice/');
  assert.equal(card['CardDAVUsername'], 'alice@example.com');

  const uuids = [root['PayloadUUID'], ...content.map((p) => p['PayloadUUID'])];
  assert.equal(new Set(uuids).size, 4, 'distinct payload UUIDs');
  for (const u of uuids) assert.match(String(u), UUID_RE);
  assert.doesNotMatch(String(root['PayloadDescription']), /app password \(/, 'no MFA hint without MFA');
});

test('payload UUIDs are stable per user and differ between users', async () => {
  const a1 = parsePlist(await (await getProfile()).text()) as Record<string, PV>;
  const a2 = parsePlist(await (await getProfile()).text()) as Record<string, PV>;
  const b = parsePlist(await (await getProfile('', tok('bob'))).text()) as Record<string, PV>;
  assert.equal(a1['PayloadUUID'], a2['PayloadUUID']);
  assert.deepEqual(a1['PayloadContent'], a2['PayloadContent']);
  assert.notEqual(a1['PayloadUUID'], b['PayloadUUID']);
  assert.equal(stableUuid('alice', 'profile'), a1['PayloadUUID']);
});

test('MFA on → the profile tells the user to use an app password', async () => {
  state.mfa = { totpEnabled: true, webAuthnCredentials: null };
  try {
    const root = parsePlist(await (await getProfile()).text()) as Record<string, PV>;
    assert.match(String(root['PayloadDescription']), /enter an app password/);
  } finally {
    state.mfa = null;
  }
});

test('EAS variant: one com.apple.eas.account payload with its own stable identity', async () => {
  const res = await getProfile('?type=eas');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="example.com-activesync.mobileconfig"');
  const root = parsePlist(await res.text()) as Record<string, PV>;
  const content = root['PayloadContent'] as Record<string, PV>[];
  assert.equal(content.length, 1);
  const eas = content[0]!;
  assert.equal(eas['PayloadType'], 'com.apple.eas.account');
  assert.equal(eas['Host'], 'mail.example.com');
  assert.equal(eas['SSL'], true);
  assert.equal(eas['UserName'], 'alice@example.com');
  assert.equal(eas['EmailAddress'], 'alice@example.com');
  assert.equal(root['PayloadIdentifier'], 'com.example.mail.coremail.alice.profile-eas');
  assert.notEqual(root['PayloadUUID'], stableUuid('alice', 'profile'));
  assert.equal((await getProfile('?type=bogus')).status, 400);
});

test('unknown user → 404', async () => {
  assert.equal((await getProfile('', tok('ghost'))).status, 404);
});

test('WebAuthn-only MFA (Json array) requires an app password — profile and client-config agree', async () => {
  const clientConfig = async () => (await (await fetch(`${base}/api/v1/user/client-config`, {
    headers: { authorization: `Bearer ${tok('alice')}` },
  })).json() as { requiresAppPassword: boolean }).requiresAppPassword;
  try {
    state.mfa = { totpEnabled: false, webAuthnCredentials: [{ id: 'cred-1', publicKey: 'x' }] };
    const root = parsePlist(await (await getProfile()).text()) as Record<string, PV>;
    assert.match(String(root['PayloadDescription']), /enter an app password/);
    assert.equal(await clientConfig(), true);
    // an empty array, or a legacy string value, is no MFA
    for (const creds of [[], '[{"id":"x"}]']) {
      state.mfa = { totpEnabled: false, webAuthnCredentials: creds };
      assert.doesNotMatch(String((parsePlist(await (await getProfile()).text()) as Record<string, PV>)['PayloadDescription']), /enter an app password/);
      assert.equal(await clientConfig(), false);
    }
  } finally {
    state.mfa = null;
  }
});

test('plist writer: escaping, empty containers, booleans', () => {
  const xml = toPlist({ a: '<&>', b: [], c: {}, d: false, e: [1, 'x'] });
  assert.deepEqual(parsePlist(xml), { a: '<&>', b: [], c: {}, d: false, e: [1, 'x'] });
  assert.throws(() => toPlist({ x: 1.5 }));
});
