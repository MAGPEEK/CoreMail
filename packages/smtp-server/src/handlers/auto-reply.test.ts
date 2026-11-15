/**
 * Out-of-office decision table (RFC 3834) + rate limit + reply headers.
 * Run: node --import tsx --test src/handlers/auto-reply.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { decideAutoReply, parseHeaderBlock, sendAutoReplyIfNeeded, buildAutoReply } = await import('./auto-reply.js');
type Settings = NonNullable<Parameters<typeof decideAutoReply>[0]['settings']>;

const S: Settings = {
  oofEnabled: true, oofInternal: 'I am out (internal).', oofExternal: '<p>I am out.</p>',
  oofExternalEnabled: true, oofExternalOnlyContacts: false, oofUseTimeRange: false, oofStart: null, oofEnd: null,
};
const NOW = new Date('2026-07-10T12:00:00Z');

// The recipient is addressed in To: unless a case overrides the recipient fields (RFC 3834 §2).
function input(
  over: Partial<Parameters<typeof decideAutoReply>[0]> = {},
  headers = 'From: a@ext.example\r\nSubject: Hi\r\n\r\n',
  recipientFields = 'To: Bob <bob@local.example>\r\n',
) {
  return {
    settings: S, envelopeFrom: 'a@ext.example', ownAddresses: ['bob@local.example', 'info@local.example'],
    headers: parseHeaderBlock(recipientFields + headers), deliveredToJunk: false, senderIsInternal: false, senderIsContact: false, now: NOW,
    ...over,
  };
}

test('RFC 3834 decision table', () => {
  const cases: Array<[string, ReturnType<typeof input>, boolean | string]> = [
    ['external sender → external text', input(), true],
    ['internal sender → internal text', input({ senderIsInternal: true }), true],
    ['oof disabled', input({ settings: { ...S, oofEnabled: false } }), 'oof disabled'],
    ['no settings', input({ settings: null }), 'oof disabled'],
    ['null sender', input({ envelopeFrom: '' }), 'null sender'],
    ['null sender <>', input({ envelopeFrom: '<>' }), 'null sender'],
    ['own address', input({ envelopeFrom: 'Bob@Local.example' }), 'own address'],
    ['own alias', input({ envelopeFrom: 'info@local.example' }), 'own address'],
    ['MAILER-DAEMON', input({ envelopeFrom: 'MAILER-DAEMON@ext.example' }), 'automated sender'],
    ['list -request', input({ envelopeFrom: 'users-request@lists.example' }), 'automated sender'],
    ['owner-', input({ envelopeFrom: 'owner-users@lists.example' }), 'automated sender'],
    ['noreply', input({ envelopeFrom: 'no-reply@shop.example' }), 'automated sender'],
    ['junk', input({ deliveredToJunk: true }), 'junk'],
    ['Auto-Submitted: auto-replied', input({}, 'Auto-Submitted: auto-replied\r\n\r\n'), 'auto-submitted'],
    ['Auto-Submitted: auto-generated', input({}, 'Auto-Submitted: auto-generated; type=x\r\n\r\n'), 'auto-submitted'],
    ['Auto-Submitted: no', input({}, 'Auto-Submitted: no\r\n\r\n'), true],
    ['Precedence: bulk', input({}, 'Precedence: bulk\r\n\r\n'), 'precedence'],
    ['Precedence: list', input({}, 'Precedence: List\r\n\r\n'), 'precedence'],
    ['Precedence: junk', input({}, 'Precedence: junk\r\n\r\n'), 'precedence'],
    ['List-Id', input({}, 'List-Id: <users.lists.example>\r\n\r\n'), 'mailing list'],
    ['List-Unsubscribe folded', input({}, 'List-Unsubscribe:\r\n <mailto:x@y>\r\n\r\n'), 'mailing list'],
    ['X-Auto-Response-Suppress: OOF', input({}, 'X-Auto-Response-Suppress: DR, OOF\r\n\r\n'), 'suppressed'],
    ['before period', input({ settings: { ...S, oofUseTimeRange: true, oofStart: new Date('2026-07-11T00:00:00Z'), oofEnd: null } }), 'before oof period'],
    ['after period', input({ settings: { ...S, oofUseTimeRange: true, oofStart: null, oofEnd: new Date('2026-07-09T00:00:00Z') } }), 'after oof period'],
    ['inside period', input({ settings: { ...S, oofUseTimeRange: true, oofStart: new Date('2026-07-01'), oofEnd: new Date('2026-07-20') } }), true],
    ['range ignored when oofUseTimeRange=false', input({ settings: { ...S, oofStart: new Date('2030-01-01') } }), true],
    ['external disabled', input({ settings: { ...S, oofExternalEnabled: false } }), 'external replies disabled'],
    ['external only contacts, not a contact', input({ settings: { ...S, oofExternalOnlyContacts: true } }), 'sender not a contact'],
    ['external only contacts, contact', input({ settings: { ...S, oofExternalOnlyContacts: true }, senderIsContact: true }), true],
    ['internal unaffected by external switch', input({ settings: { ...S, oofExternalEnabled: false }, senderIsInternal: true }), true],
    ['empty text', input({ settings: { ...S, oofExternal: '  ' } }), 'no external text'],
    ['only Bcc (no recipient field)', input({}, 'Subject: Hi\r\n\r\n', 'To: undisclosed-recipients:;\r\n'), 'not addressed explicitly'],
    ['list without List-* headers', input({}, 'Subject: Hi\r\n\r\n', 'To: all-staff@lists.example\r\n'), 'not addressed explicitly'],
    ['alias in Cc', input({}, 'Subject: Hi\r\n\r\n', 'To: x@ext.example\r\nCc: "Info" <INFO@local.example>\r\n'), true],
    ['Resent-To', input({}, 'Subject: Hi\r\n\r\n', 'To: x@ext.example\r\nResent-To: bob@local.example\r\n'), true],
  ];
  for (const [name, i, expected] of cases) {
    const d = decideAutoReply(i);
    if (expected === true) assert.equal(d.send, true, name);
    else assert.deepEqual(d, { send: false, reason: expected }, name);
  }
  const ext = decideAutoReply(input());
  assert.equal(ext.send && ext.audience, 'external');
  const int = decideAutoReply(input({ senderIsInternal: true }));
  assert.equal(int.send && int.body, 'I am out (internal).');
});

function deps(over: Record<string, unknown> = {}) {
  const sent: Array<{ from: string; to: string; raw: Buffer }> = [];
  const keys = new Set<string>();
  const d = {
    sent,
    loadSettings: async () => S,
    ownAddresses: async (_u: string, e: string) => [e],
    isLocalDomain: async (dom: string) => dom === 'local.example',
    isContact: async () => false,
    acquire: async (k: string) => { if (keys.has(k)) return false; keys.add(k); return true; },
    hostname: async () => 'mail.local.example',
    displayName: async () => 'Bob Builder',
    enqueue: async (j: { from: string; to: string; raw: Buffer }) => { sent.push(j); },
    ...over,
  };
  return d;
}

const ORIG = Buffer.from('From: Ann <ann@ext.example>\r\nTo: bob@local.example\r\nSubject: Meeting\r\nMessage-ID: <m1@ext.example>\r\nReferences: <m0@ext.example>\r\n\r\nHi Bob\r\n');

test('sends once per sender within the window (rate limit), with RFC 3834 headers', async () => {
  const d = deps();
  const ctx = { userId: 'u1', userEmail: 'bob@local.example', envelopeFrom: 'ann@ext.example', raw: ORIG, deliveredToJunk: false, now: NOW };
  assert.equal(await sendAutoReplyIfNeeded(ctx, d), 'sent');
  assert.equal(await sendAutoReplyIfNeeded(ctx, d), 'rate limited');
  assert.equal(await sendAutoReplyIfNeeded({ ...ctx, envelopeFrom: 'carl@ext.example' }, d), 'sent');
  assert.equal(d.sent.length, 2);
  assert.equal(d.sent[0]!.to, 'ann@ext.example');
  const reply = d.sent[0]!.raw.toString('utf8');
  assert.match(reply, /^Auto-Submitted: auto-replied\r?$/m);
  assert.match(reply, /^In-Reply-To: <m1@ext\.example>\r?$/m);
  assert.match(reply, /^References: <m0@ext\.example> <m1@ext\.example>\r?$/m);
  assert.match(reply, /^Subject: Auto: Meeting\r?$/m);
  assert.match(reply, /^To: ann@ext\.example\r?$/m);
  assert.match(reply, /^From: Bob Builder <bob@local\.example>\r?$/m);
});

test('changing the out-of-office text restarts the window', async () => {
  let text = 'v1';
  const d = deps({ loadSettings: async () => ({ ...S, oofExternal: text }) });
  const ctx = { userId: 'u1', userEmail: 'bob@local.example', envelopeFrom: 'ann@ext.example', raw: ORIG, deliveredToJunk: false, now: NOW };
  assert.equal(await sendAutoReplyIfNeeded(ctx, d), 'sent');
  assert.equal(await sendAutoReplyIfNeeded(ctx, d), 'rate limited');
  text = 'v2';
  assert.equal(await sendAutoReplyIfNeeded(ctx, d), 'sent');
});

test('internal sender gets the internal text; list mail and errors send nothing', async () => {
  const d = deps();
  assert.equal(await sendAutoReplyIfNeeded({ userId: 'u1', userEmail: 'bob@local.example', envelopeFrom: 'eve@local.example', raw: ORIG, deliveredToJunk: false, now: NOW }, d), 'sent');
  assert.match(d.sent[0]!.raw.toString('utf8'), /I am out \(internal\)\./);
  const list = Buffer.concat([Buffer.from('List-Id: <x.example>\r\n'), ORIG]);
  assert.equal(await sendAutoReplyIfNeeded({ userId: 'u1', userEmail: 'bob@local.example', envelopeFrom: 'ann@ext.example', raw: list, deliveredToJunk: false, now: NOW }, d), 'mailing list');
  const broken = deps({ loadSettings: async () => { throw new Error('db down'); } });
  assert.equal(await sendAutoReplyIfNeeded({ userId: 'u1', userEmail: 'bob@local.example', envelopeFrom: 'ann@ext.example', raw: ORIG, deliveredToJunk: false }, broken), 'error');
});

test('HTML out-of-office text produces an alternative text part', async () => {
  const raw = (await buildAutoReply({ fromAddress: 'bob@local.example', to: 'ann@ext.example', originalHeaders: parseHeaderBlock(ORIG), body: '<p>Away &amp; back</p>', hostname: 'h.example' })).toString('utf8');
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /Away & back/);
});
