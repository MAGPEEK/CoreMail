/**
 * v8.1 — DSN requests (RFC 3461), DSN generation (RFC 3464 / 6533), SMTPUTF8
 * relaying (RFC 6531) and IDN recipient matching.
 * Run: node --import tsx --test src/outbound/dsn-request.test.ts  (in packages/smtp-server)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

/** Local domains: one stored as A-label, one as U-label. */
const LOCAL_DOMAINS = ['xn--bcher-kva.example', 'straße.example', 'corp.test'];
const USERS = ['jörg@xn--bcher-kva.example', 'anna@straße.example', 'bob@corp.test'];
let domainLookups = 0;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  systemLog: { create: async () => ({}) },
  domain: {
    findFirst: async ({ where }: { where: { name: string | { in: string[] } } }) => {
      domainLookups++;
      const names = typeof where.name === 'string' ? [where.name] : where.name.in;
      const name = LOCAL_DOMAINS.find((d) => names.includes(d));
      return name ? { id: `d-${name}`, name } : null;
    },
  },
  user: {
    findFirst: async ({ where }: { where: { email: string } }) => (USERS.includes(where.email) ? { id: `u-${where.email}` } : null),
    findMany: async () => [],
  },
  sharedMailbox: { findFirst: async () => null },
  resourceMailbox: { findFirst: async () => null },
  emailAlias: { findFirst: async () => null },
};

const { decodeXtext, encodeXtext, parseNotify, parseOrcpt, parseEnvid, wantsNotification, dsnForRecipients } = await import('../core/dsn-params.js');
const { applyDsnRequest, buildDsnMessage, sendDsnBounce, sendSuccessDsn, messageHeaders } = await import('./dsn.js');
const { relayMessage, dsnGroups } = await import('./relay.js');
const { deliverOutboundJob } = await import('./queue.js');
const { domainVariants, toAsciiDomainAddress, envelopeNeedsSmtputf8 } = await import('../core/idn.js');
const { canonicalRecipient, isLocalDomainAddress, expandRecipients } = await import('../handlers/expand.js');
const { verifyRecipient, asciiJson } = await import('../inbound/handler.js');
const { esmtpEnvFlags } = await import('../core/esmtp-env.js');
const { parseRawMessage } = await import('@coremail/storage');

type DsnOpts = Parameters<typeof buildDsnMessage>[0];
type EnvelopeDsn = NonNullable<DsnOpts['dsn']>;
type RelayDeps = NonNullable<Parameters<typeof relayMessage>[4]>;
type QueueDeps = Parameters<typeof deliverOutboundJob>[2];
type Job = Parameters<typeof deliverOutboundJob>[0];

const ORIGINAL = Buffer.from('From: alice@corp.test\r\nSubject: Report\r\nMessage-ID: <m1@corp.test>\r\n\r\nSECRET BODY\r\n');

const BASE: DsnOpts = {
  originalFrom: 'alice@corp.test',
  originalTo: ['x@ext.test'],
  originalSubject: 'Report',
  originalMessageId: '<m1@corp.test>',
  failureReason: '550 5.1.1 No such user',
  smtpCode: 550,
  serverHostname: 'mail.corp.test',
};

function part(raw: string, contentType: string): string | null {
  const at = raw.indexOf(`Content-Type: ${contentType}\r\n`);
  if (at < 0) return null;
  const body = raw.slice(raw.indexOf('\r\n\r\n', at) + 4);
  return body.slice(0, body.indexOf('\r\n--dsn-boundary'));
}

// ─── xtext + parameter parsing ──────────────────────────────────────────────

describe('RFC 3461 parameter values', () => {
  test('xtext decodes "+HH" (upper-case hex only) and round-trips', () => {
    assert.equal(decodeXtext('a+2Bb+3Dc'), 'a+b=c');
    assert.equal(decodeXtext('a+2bb'), null, 'lower-case hex is not xtext');
    assert.equal(decodeXtext('a=b'), null);
    assert.equal(decodeXtext('a+2'), null);
    assert.equal(decodeXtext('a b'), null);
    assert.equal(encodeXtext('x+y=z ä'), 'x+2By+3Dz+20+C3+A4');
    assert.equal(decodeXtext(encodeXtext('id+1=2')), 'id+1=2');
  });

  test('NOTIFY, ORCPT and ENVID validation', () => {
    assert.deepEqual(parseNotify('never'), []);
    assert.deepEqual(parseNotify('SUCCESS,FAILURE,DELAY'), ['SUCCESS', 'FAILURE', 'DELAY']);
    assert.equal(parseNotify('NEVER,FAILURE'), null);
    assert.equal(parseNotify(''), null);
    assert.deepEqual(parseOrcpt('rfc822;a+2Bb@x.test'), { type: 'rfc822', address: 'a+b@x.test' });
    assert.deepEqual(parseOrcpt('UTF-8;jörg\\x{40}x.test'.replace('\\x{40}', '@')), { type: 'utf-8', address: 'jörg@x.test' });
    assert.equal(parseOrcpt(';a@x'), null);
    assert.equal(parseOrcpt('rfc822;'), null);
    assert.equal(parseOrcpt(`rfc822;${'a'.repeat(500)}`), null);
    assert.equal(parseEnvid('abc+0Ddef'), null, 'decoded ENVID must be printable');
    assert.equal(parseEnvid('Q+2B1'), 'Q+1');
  });

  test('dsnForRecipients keeps RET/ENVID and only the given recipients', () => {
    const dsn: EnvelopeDsn = { ret: 'HDRS', envid: 'E1', rcpts: { 'a@x.test': { notify: ['SUCCESS'] }, 'b@x.test': { notify: [] } } };
    assert.deepEqual(dsnForRecipients(dsn, ['A@x.test']), { ret: 'HDRS', envid: 'E1', rcpts: { 'a@x.test': { notify: ['SUCCESS'] } } });
    assert.equal(dsnForRecipients({ rcpts: { 'a@x.test': {} } }, ['c@x.test']), undefined);
  });
});

// ─── NOTIFY combinations ────────────────────────────────────────────────────

describe('NOTIFY decides which DSNs are generated (RFC 3461 §4.1)', () => {
  const combos: Array<{ notify: Array<'SUCCESS' | 'FAILURE' | 'DELAY'> | undefined; label: string }> = [
    { notify: undefined, label: '(none)' },
    { notify: [], label: 'NEVER' },
    { notify: ['SUCCESS'], label: 'SUCCESS' },
    { notify: ['FAILURE'], label: 'FAILURE' },
    { notify: ['DELAY'], label: 'DELAY' },
    { notify: ['SUCCESS', 'FAILURE'], label: 'SUCCESS,FAILURE' },
    { notify: ['SUCCESS', 'DELAY'], label: 'SUCCESS,DELAY' },
    { notify: ['FAILURE', 'DELAY'], label: 'FAILURE,DELAY' },
    { notify: ['SUCCESS', 'FAILURE', 'DELAY'], label: 'SUCCESS,FAILURE,DELAY' },
  ];
  for (const { notify, label } of combos) {
    test(`NOTIFY=${label}`, () => {
      const dsn: EnvelopeDsn = notify === undefined ? {} : { rcpts: { 'x@ext.test': { notify } } };
      const expected = {
        failed:    notify === undefined || notify.includes('FAILURE'),
        delayed:   notify === undefined || notify.includes('DELAY'),
        delivered: notify !== undefined && notify.includes('SUCCESS'),
        relayed:   notify !== undefined && notify.includes('SUCCESS'),
      };
      for (const action of ['failed', 'delayed', 'delivered', 'relayed'] as const) {
        const out = applyDsnRequest({ ...BASE, action, dsn });
        assert.equal(out !== null, expected[action], `${label} → ${action}`);
      }
    });
  }

  test('mixed recipients: only those that asked are reported', () => {
    const dsn: EnvelopeDsn = { rcpts: { 'a@ext.test': { notify: [] }, 'b@ext.test': { notify: ['FAILURE'] } } };
    const out = applyDsnRequest({ ...BASE, originalTo: ['a@ext.test', 'b@ext.test', 'c@ext.test'], dsn });
    assert.deepEqual(out?.originalTo, ['b@ext.test', 'c@ext.test']);
    assert.equal(wantsNotification(undefined, 'success'), false);
  });

  test('sendDsnBounce sends nothing for NOTIFY=NEVER (no lookup, no delivery)', async () => {
    const before = domainLookups;
    await sendDsnBounce({ ...BASE, dsn: { rcpts: { 'x@ext.test': { notify: [] } } } });
    assert.equal(domainLookups, before);
  });

  test('sendSuccessDsn reports only SUCCESS recipients and nothing without a request', async () => {
    const sent: DsnOpts[] = [];
    const send = async (o: DsnOpts): Promise<void> => { sent.push(o); };
    const dsn: EnvelopeDsn = { rcpts: { 'a@x.test': { notify: ['SUCCESS'] }, 'b@x.test': { notify: ['FAILURE'] } } };

    assert.deepEqual(await sendSuccessDsn({ from: 's@x.test', rcpts: ['a@x.test', 'b@x.test'], action: 'delivered', dsn, hostname: 'h' }, send), ['a@x.test']);
    assert.deepEqual(await sendSuccessDsn({ from: 's@x.test', rcpts: ['b@x.test'], action: 'delivered', dsn, hostname: 'h' }, send), []);
    assert.deepEqual(await sendSuccessDsn({ from: '', rcpts: ['a@x.test'], action: 'delivered', dsn, hostname: 'h' }, send), [], 'null sender never gets a DSN');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.action, 'delivered');
    assert.deepEqual(sent[0]?.originalTo, ['a@x.test']);
  });
});

// ─── report format ──────────────────────────────────────────────────────────

describe('DSN report content (RFC 3464 / RFC 6533)', () => {
  test('ENVID → Original-Envelope-Id, ORCPT → Original-Recipient', () => {
    const raw = buildDsnMessage({
      ...BASE,
      dsn: { envid: 'QQ314159', rcpts: { 'x@ext.test': { orcpt: { type: 'rfc822', address: 'Orig@Ext.test' } } } },
    }).toString('utf8');
    const report = part(raw, 'message/delivery-status') ?? '';

    assert.match(report, /^Original-Envelope-Id: QQ314159\r\nReporting-MTA: dns; mail\.corp\.test\r\n/);
    assert.match(report, /\r\n\r\nOriginal-Recipient: rfc822; Orig@Ext\.test\r\nFinal-Recipient: rfc822; x@ext\.test\r\nAction: failed\r\n/);
  });

  test('RET=HDRS (and no RET) return only the headers as text/rfc822-headers', () => {
    for (const dsn of [{ ret: 'HDRS' as const }, {}]) {
      const raw = buildDsnMessage({ ...BASE, dsn, originalRaw: ORIGINAL }).toString('utf8');
      assert.ok(raw.includes('Content-Type: text/rfc822-headers'));
      assert.ok(raw.includes('Subject: Report\r\nMessage-ID: <m1@corp.test>\r\n'));
      assert.ok(!raw.includes('SECRET BODY'));
    }
  });

  test('RET=FULL returns the whole message as message/rfc822 on failure, only headers on success/delay', () => {
    const failed = buildDsnMessage({ ...BASE, dsn: { ret: 'FULL' }, originalRaw: ORIGINAL }).toString('utf8');
    assert.ok(failed.includes('Content-Type: message/rfc822'));
    assert.ok(failed.includes('SECRET BODY'));

    for (const action of ['delivered', 'delayed'] as const) {
      const raw = buildDsnMessage({ ...BASE, action, dsn: { ret: 'FULL' }, originalRaw: ORIGINAL }).toString('utf8');
      assert.ok(!raw.includes('SECRET BODY'), action);
      assert.ok(raw.includes('Content-Type: text/rfc822-headers'), action);
    }
    assert.ok(buildDsnMessage({ ...BASE, dsn: { ret: 'FULL' }, originalRaw: ORIGINAL }).toString('utf8').endsWith('--\r\n'));
  });

  test('success DSN: Action delivered/relayed, Status 2.0.0, no Diagnostic-Code, CRLF only', () => {
    for (const action of ['delivered', 'relayed'] as const) {
      const raw = buildDsnMessage({ ...BASE, action, recipients: [{ rcpt: 'x@ext.test', status: '2.0.0', diagnostic: '' }] }).toString('utf8');
      const report = part(raw, 'message/delivery-status') ?? '';
      assert.match(report, new RegExp(`Final-Recipient: rfc822; x@ext\\.test\\r\\nAction: ${action}\\r\\nStatus: 2\\.0\\.0`));
      assert.doesNotMatch(report, /Diagnostic-Code/);
      assert.doesNotMatch(raw, /(?<!\r)\n/);
    }
  });

  test('UTF-8 addresses use utf-8 address types and message/global-delivery-status / global-headers', () => {
    const original = Buffer.from('From: jörg@bücher.example\r\nSubject: Grüße\r\n\r\nx\r\n', 'utf8');
    const raw = buildDsnMessage({ ...BASE, originalTo: ['用户@例子.example'], originalRaw: original }).toString('utf8');

    assert.ok(raw.includes('Content-Type: message/global-delivery-status'));
    assert.ok(raw.includes('Final-Recipient: utf-8; 用户@例子.example'));
    assert.ok(raw.includes('Content-Type: message/global-headers'));
  });

  test('messageHeaders stops at the empty line', () => {
    assert.equal(messageHeaders(ORIGINAL).toString(), 'From: alice@corp.test\r\nSubject: Report\r\nMessage-ID: <m1@corp.test>\r\n');
  });
});

// ─── relay: DSN pass-through and SMTPUTF8 ───────────────────────────────────

const MX_CONFIG = {
  mode: 'mx' as const, smarthostHost: '', smarthostPort: 587, smarthostTls: true, smarthostImplicitTls: false,
  smarthostUsername: '', smarthostPassword: '', heloName: 'mail.corp.test',
};

describe('relay (RFC 3461 §5.2, RFC 6531 §3.2)', () => {
  test('dsnGroups: one transaction per NOTIFY/ORCPT combination, RET/ENVID on every group', () => {
    const groups = dsnGroups(['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'], {
      ret: 'HDRS', envid: 'E',
      rcpts: {
        'a@x.test': { notify: ['SUCCESS'] },
        'b@x.test': { notify: ['SUCCESS'] },
        'c@x.test': { notify: ['SUCCESS'], orcpt: { type: 'rfc822', address: 'C@x.test' } },
      },
    });
    assert.deepEqual(groups, [
      { rcpts: ['a@x.test', 'b@x.test'], dsn: { ret: 'HDRS', envid: 'E', notify: 'SUCCESS' } },
      { rcpts: ['c@x.test'], dsn: { ret: 'HDRS', envid: 'E', notify: 'SUCCESS', orcpt: 'rfc822;C@x.test' } },
      { rcpts: ['d@x.test'], dsn: { ret: 'HDRS', envid: 'E' } },
    ]);
    assert.deepEqual(dsnGroups(['a@x.test'], undefined), [{ rcpts: ['a@x.test'] }]);
    assert.deepEqual(dsnGroups(['a@x.test'], { rcpts: { 'a@x.test': { notify: [] } } }), [{ rcpts: ['a@x.test'], dsn: { notify: 'NEVER' } }]);
  });

  test('the DSN request is handed to nodemailer; dsnPassedOn only when the next hop advertises DSN', async () => {
    const seen: unknown[] = [];
    const deps = (ehlo: string[]): RelayDeps => ({
      config: async () => MX_CONFIG,
      resolveMx: async () => [{ exchange: 'mx.ext.test', priority: 10 }],
      send: async (_o, envelope, _raw, dsn) => { seen.push(dsn); return { accepted: envelope.to, rejected: [], ehlo }; },
    });
    const dsn: EnvelopeDsn = { ret: 'FULL', rcpts: { 'a@ext.test': { notify: ['SUCCESS', 'FAILURE'] } } };

    const withDsn = await relayMessage(Buffer.from('x'), 's@corp.test', ['a@ext.test'], {}, deps(['SIZE 100', 'DSN', 'PIPELINING']), { dsn });
    const withoutDsn = await relayMessage(Buffer.from('x'), 's@corp.test', ['a@ext.test'], {}, deps(['SIZE 100']), { dsn });
    const noRequest = await relayMessage(Buffer.from('x'), 's@corp.test', ['a@ext.test'], {}, deps(['DSN']));

    assert.deepEqual(seen[0], { ret: 'FULL', notify: 'SUCCESS,FAILURE' });
    assert.deepEqual(withDsn.dsnPassedOn, ['a@ext.test']);
    assert.equal(withoutDsn.dsnPassedOn, undefined);
    assert.deepEqual(withoutDsn.delivered, ['a@ext.test']);
    assert.equal(seen[2], undefined);
    assert.equal(noRequest.dsnPassedOn, undefined);
  });

  test('a UTF-8 local-part to a next hop without SMTPUTF8 fails permanently with 5.6.7 — nothing is sent', async () => {
    let sends = 0;
    const deps: RelayDeps = {
      config: async () => MX_CONFIG,
      resolveMx: async () => [{ exchange: 'mx.ext.test', priority: 10 }],
      probe: async () => ['SIZE 1000', '8BITMIME'],
      send: async (_o, envelope) => { sends++; return { accepted: envelope.to, rejected: [] }; },
    };

    const r = await relayMessage(Buffer.from('x'), 's@corp.test', ['jörg@ext.test'], {}, deps);

    assert.equal(sends, 0);
    assert.deepEqual(r.failures.map((f) => [f.rcpt, f.status, f.permanent]), [['jörg@ext.test', '5.6.7', true]]);
  });

  test('a UTF-8 envelope goes to a next hop with SMTPUTF8; an unknown probe result falls back to sending', async () => {
    for (const probe of [async () => ['SMTPUTF8', 'DSN'], async () => null]) {
      let sends = 0;
      const deps: RelayDeps = {
        config: async () => MX_CONFIG,
        resolveMx: async () => [{ exchange: 'mx.ext.test', priority: 10 }],
        probe,
        send: async (_o, envelope) => { sends++; return { accepted: envelope.to, rejected: [] }; },
      };
      const r = await relayMessage(Buffer.from('x'), 'jörg@corp.test', ['b@ext.test'], {}, deps);
      assert.equal(sends, 1);
      assert.deepEqual(r.delivered, ['b@ext.test']);
    }
  });

  test('an IDN domain is looked up and sent as A-label (no SMTPUTF8 needed) and reported in its original spelling', async () => {
    const mxQueries: string[] = [];
    let envelopeTo: string[] = [];
    let probed = false;
    const deps: RelayDeps = {
      config: async () => MX_CONFIG,
      resolveMx: async (d) => { mxQueries.push(d); return [{ exchange: 'mx.ext.test', priority: 10 }]; },
      probe: async () => { probed = true; return []; },
      send: async (_o, envelope) => { envelopeTo = envelope.to; return { accepted: envelope.to, rejected: ['bad@xn--mnchen-3ya.example'] }; },
    };

    const r = await relayMessage(Buffer.from('x'), 's@corp.test', ['info@münchen.example', 'bad@münchen.example'], {}, deps);

    assert.deepEqual(mxQueries, ['xn--mnchen-3ya.example']);
    assert.deepEqual(envelopeTo, ['info@xn--mnchen-3ya.example', 'bad@xn--mnchen-3ya.example']);
    assert.equal(probed, false);
    assert.deepEqual(r.delivered, ['info@münchen.example']);
    assert.deepEqual(r.failures.map((f) => f.rcpt), ['bad@münchen.example']);
  });
});

// ─── outbound queue: DSN request across the job ─────────────────────────────

function queueHarness(relayResult: (to: string[]) => { delivered: string[]; failures: Array<{ rcpt: string; code: number | null; status: string; message: string; permanent: boolean }>; dsnPassedOn?: string[] }) {
  const reports: DsnOpts[] = [];
  const relayOpts: unknown[] = [];
  const deps: QueueDeps = {
    isLocalAddress: async (a) => a.endsWith('@corp.test'),
    expand: async (a) => a,
    storeLocal: async () => undefined,
    resolveDkim: async () => ({}),
    relay: async (_raw, _from, to, _dkim, opts) => { relayOpts.push(opts); return relayResult(to); },
    bounce: async (o) => { reports.push(o); },
    hostname: async () => 'mail.corp.test',
  };
  return { deps, reports, relayOpts };
}

function queueJob(to: string[], dsn: EnvelopeDsn): Job {
  const j: Job = {
    id: 'j1',
    data: { messageId: 'm1', from: 'alice@corp.test', to, rawMessage: ORIGINAL.toString('base64'), dsn },
    attemptsMade: 0,
    opts: { attempts: 5 },
    updateData: async (d) => { j.data = d; },
  };
  return j;
}

describe('outbound queue honours the DSN request', () => {
  test('NOTIFY=SUCCESS: "relayed" for a non-DSN next hop, nothing when the next hop took the DSN request; "delivered" locally', async () => {
    const h = queueHarness((to) => ({ delivered: to, failures: [], dsnPassedOn: to.filter((r) => r.startsWith('dsn')) }));
    const dsn: EnvelopeDsn = {
      envid: 'E1',
      rcpts: {
        'plain@ext.test': { notify: ['SUCCESS'] },
        'dsn@ext.test': { notify: ['SUCCESS'] },
        'bob@corp.test': { notify: ['SUCCESS'] },
      },
    };
    const j = queueJob(['plain@ext.test', 'dsn@ext.test', 'bob@corp.test'], dsn);

    await deliverOutboundJob(j, ORIGINAL, h.deps);

    assert.deepEqual(h.relayOpts, [{ dsn }]);
    assert.deepEqual(h.reports.map((r) => [r.action, r.originalTo]), [['delivered', ['bob@corp.test']], ['relayed', ['plain@ext.test']]]);
    assert.equal(h.reports[0]?.originalSubject, 'Report', 'subject taken from the raw message');
    assert.deepEqual(j.data.successNotified?.sort(), ['bob@corp.test', 'dsn@ext.test', 'plain@ext.test']);
  });

  test('a retry does not send the success DSN twice', async () => {
    let call = 0;
    const h = queueHarness((to) => (call++ === 0
      ? { delivered: to.filter((r) => r === 'ok@ext.test'), failures: [{ rcpt: 'grey@ext.test', code: 451, status: '4.3.0', message: '451 later', permanent: false }] }
      : { delivered: to, failures: [] }));
    const j = queueJob(['ok@ext.test', 'grey@ext.test'], { rcpts: { 'ok@ext.test': { notify: ['SUCCESS'] }, 'grey@ext.test': { notify: ['SUCCESS'] } } });

    await assert.rejects(deliverOutboundJob(j, ORIGINAL, h.deps));
    j.attemptsMade = 1;
    await deliverOutboundJob(j, ORIGINAL, h.deps);

    assert.deepEqual(h.reports.map((r) => r.originalTo), [['ok@ext.test'], ['grey@ext.test']]);
  });

  test('bounces carry the DSN request and the original (filtered by NOTIFY at send time)', async () => {
    const h = queueHarness((to) => ({ delivered: [], failures: to.map((rcpt) => ({ rcpt, code: 550, status: '5.1.1', message: '550 no', permanent: true })) }));
    const dsn: EnvelopeDsn = { ret: 'FULL', rcpts: { 'never@ext.test': { notify: [] } } };
    const j = queueJob(['never@ext.test', 'default@ext.test'], dsn);

    await assert.rejects(deliverOutboundJob(j, ORIGINAL, h.deps));

    const bounce = h.reports[0]!;
    assert.equal(bounce.action, undefined);
    assert.deepEqual(bounce.dsn, dsn);
    assert.ok(bounce.originalRaw?.equals(ORIGINAL));
    assert.deepEqual(applyDsnRequest(bounce)?.originalTo, ['default@ext.test'], 'NOTIFY=NEVER recipient is left out');
  });
});

// ─── IDN + SMTPUTF8 helpers and local matching ──────────────────────────────

describe('IDN normalisation and local recipient match (RFC 6531)', () => {
  test('domain variants and the wire form', () => {
    assert.deepEqual(domainVariants('Bücher.example').sort(), ['bücher.example', 'xn--bcher-kva.example']);
    assert.deepEqual(domainVariants('xn--bcher-kva.example').sort(), ['bücher.example', 'xn--bcher-kva.example']);
    assert.equal(toAsciiDomainAddress('Jörg@Bücher.example'), 'Jörg@xn--bcher-kva.example');
    assert.equal(envelopeNeedsSmtputf8('a@bücher.example', ['b@münchen.example']), false);
    assert.equal(envelopeNeedsSmtputf8('jörg@example.test', []), true);
  });

  test('a U-label recipient matches a domain stored as A-label, and vice versa', async () => {
    assert.equal(await canonicalRecipient('jörg@bücher.example'), 'jörg@xn--bcher-kva.example');
    assert.equal(await canonicalRecipient('anna@xn--strae-oqa.example'), 'anna@straße.example');
    assert.equal(await canonicalRecipient('x@other.example'), 'x@other.example');
    assert.equal(await isLocalDomainAddress('jörg@BÜCHER.example'), true);
    assert.equal(await isLocalDomainAddress('x@münchen.example'), false);
  });

  test('RCPT verification and delivery expansion find the local mailbox in either spelling', async () => {
    assert.equal(await verifyRecipient(await canonicalRecipient('jörg@bücher.example')), true);
    assert.equal(await verifyRecipient(await canonicalRecipient('anna@xn--strae-oqa.example')), true);
    assert.equal(await verifyRecipient(await canonicalRecipient('nobody@bücher.example')), false);
    assert.deepEqual(await expandRecipients(['jörg@bücher.example']), ['jörg@xn--bcher-kva.example']);
  });

  test('UTF-8 header fields are parsed for storage (RFC 6532)', async () => {
    const parsed = await parseRawMessage(Buffer.from('From: Jörg <jörg@bücher.example>\r\nTo: 用户@例子.example\r\nSubject: Grüße aus München\r\n\r\nHallo\r\n', 'utf8'));
    assert.equal(parsed.subject, 'Grüße aus München');
    assert.equal(parsed.fromAddr, 'jörg@bücher.example');
    assert.equal(parsed.fromName, 'Jörg');
  });

  test('the content-filter context header is ASCII-only JSON', () => {
    const header = asciiJson({ mailFrom: 'jörg@bücher.example' });
    assert.match(header, /^[\x20-\x7e]+$/);
    assert.deepEqual(JSON.parse(header), { mailFrom: 'jörg@bücher.example' });
  });

  test('SMTP_EXT_* switches (default on)', () => {
    assert.deepEqual(esmtpEnvFlags({}), { smtputf8: true, dsn: true, chunking: true });
    assert.deepEqual(esmtpEnvFlags({ SMTP_EXT_DSN: 'false', SMTP_EXT_CHUNKING: '0', SMTP_EXT_SMTPUTF8: 'yes' }), { smtputf8: true, dsn: false, chunking: false });
  });
});
