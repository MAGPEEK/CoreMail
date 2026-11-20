/**
 * Message trace "Zustellweg" (10.2): Received chain parser with real-world
 * samples (Gmail, Outlook / Exchange Online, Postfix, Exim, CoreMail, IPv6,
 * missing / broken dates) and the Authentication-Results / ARC summary;
 * hostile input stays bounded and linear.
 * Run: node --import tsx --test src/lib/received-hops.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma();
const {
  headerBlock, headerFields, parseReceived, parseReceivedChain, authSummary, HEADER_READ_LIMIT, MAX_RECEIVED,
} = await import('./received-hops.js');

const GMAIL_OUT = 'from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41])\r\n'
  + '        by mx.corp.test (CoreMail) with ESMTPS id 4F2A9B1C\r\n'
  + '        for <bob@corp.test>; Fri, 20 Nov 2026 10:02:05 +0100';
const GMAIL_INTERNAL = 'by 2002:a05:6a10:1234:b0:5c1:abcd:ef01 with SMTP id x12csp123456pxb;\r\n        Fri, 20 Nov 2026 01:02:03 -0800 (PST)';
const GMAIL_SMTPS = 'from mail.example.com (mail.example.com. [203.0.113.10])\r\n        by mx.google.com with SMTPS id a1sor123.2026.11.20.01.02.03\r\n        for <user@gmail.com>\r\n        (Google Transport Security);\r\n        Fri, 20 Nov 2026 01:02:03 -0800 (PST)';
const OUTLOOK_INTERNAL = 'from AM6PR04MB1234.eurprd04.prod.outlook.com (2603:10a6:20b:12::34) by AM6PR04MB5678.eurprd04.prod.outlook.com with HTTPS; Fri, 20 Nov 2026 09:02:03 +0000';
const OUTLOOK_TLS = 'from EUR05-AM6-obe.outbound.protection.outlook.com (mail-am6eur05on2101.outbound.protection.outlook.com [40.107.22.101]) by mx.corp.test with Microsoft SMTP Server (version=TLS1_2, cipher=TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384) id 15.20.1234.5; Fri, 20 Nov 2026 09:02:04 +0000';
const POSTFIX = 'from mail.example.org (mail.example.org [192.0.2.10])\r\n'
  + '\t(using TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits)\r\n'
  + '\t key-exchange X25519 server-signature RSA-PSS (2048 bits) server-digest SHA256)\r\n'
  + '\t(No client certificate requested)\r\n'
  + '\tby mx.corp.test (Postfix) with ESMTPS id 4ABC123\r\n'
  + '\tfor <bob@corp.test>; Fri, 20 Nov 2026 10:00:00 +0100 (CET)';
const POSTFIX_LOCAL = 'by mail.example.org (Postfix, from userid 1000)\r\n\tid 12345; Fri, 20 Nov 2026 09:59:58 +0100 (CET)';
const EXIM = 'from [203.0.113.5] (helo=client.local)\r\n\tby mx.example.com with esmtpsa (TLS1.3) tls TLS_AES_256_GCM_SHA384\r\n\t(Exim 4.96)\r\n\t(envelope-from <a@example.com>)\r\n\tid 1abcDE-000123-AB\r\n\tfor b@example.com; Fri, 20 Nov 2026 10:00:00 +0000';
const IPV6 = 'from mail.example.net (mail.example.net [IPv6:2001:db8::25]) by mx.corp.test (CoreMail) with ESMTP id 77AA; Fri, 20 Nov 2026 11:00:00 +0100';
const COREMAIL = 'from client.ext.test ([192.0.2.1])\r\n\tby mx.corp.test (CoreMail) with ESMTPSA id ABCD1234 (authenticated user a@corp.test)\r\n\tfor <bob@corp.test>; Fri, 20 Nov 2026 10:00:00 +0000';

test('Gmail: rDNS with trailing dot, IP, SMTPS with Google Transport Security, internal hop without from', () => {
  const h = parseReceived(GMAIL_SMTPS);
  assert.deepEqual(
    [h.from, h.fromRdns, h.fromIp, h.by, h.with, h.for, h.tls, h.time],
    ['mail.example.com', 'mail.example.com', '203.0.113.10', 'mx.google.com', 'SMTPS', 'user@gmail.com', true, '2026-11-20T09:02:03.000Z'],
  );
  const internal = parseReceived(GMAIL_INTERNAL);
  assert.deepEqual([internal.from, internal.by, internal.with, internal.id, internal.tls], [undefined, '2002:a05:6a10:1234:b0:5c1:abcd:ef01', 'SMTP', 'x12csp123456pxb', false]);
});

test('Outlook / Exchange Online: bare IPv6 comment, HTTPS hop, TLS version + cipher from the comment', () => {
  const internal = parseReceived(OUTLOOK_INTERNAL);
  assert.deepEqual([internal.fromIp, internal.with, internal.tls], ['2603:10a6:20b:12::34', 'HTTPS', true]);
  const tls = parseReceived(OUTLOOK_TLS);
  assert.deepEqual(
    [tls.fromRdns, tls.fromIp, tls.by, tls.with, tls.id, tls.tls, tls.tlsVersion, tls.tlsCipher],
    ['mail-am6eur05on2101.outbound.protection.outlook.com', '40.107.22.101', 'mx.corp.test', 'Microsoft', '15.20.1234.5', true,
      'TLS1_2', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384'],
  );
});

test('Postfix: nested TLS comment does not leak "with cipher" into the with clause; local pickup hop', () => {
  const h = parseReceived(POSTFIX);
  assert.deepEqual(
    [h.from, h.fromIp, h.by, h.with, h.id, h.for, h.tls, h.tlsVersion, h.tlsCipher, h.time],
    ['mail.example.org', '192.0.2.10', 'mx.corp.test', 'ESMTPS', '4ABC123', 'bob@corp.test', true, 'TLSv1.3', 'TLS_AES_256_GCM_SHA384', '2026-11-20T09:00:00.000Z'],
  );
  const local = parseReceived(POSTFIX_LOCAL);
  assert.deepEqual([local.by, local.id, local.from], ['mail.example.org', '12345', undefined]);
});

test('Exim: address literal + helo= comment, "tls <cipher>" clause, bare for address', () => {
  const h = parseReceived(EXIM);
  assert.deepEqual(
    [h.from, h.fromIp, h.by, h.with, h.tls, h.tlsVersion, h.tlsCipher, h.id, h.for],
    ['client.local', '203.0.113.5', 'mx.example.com', 'esmtpsa', true, 'TLS1.3', 'TLS_AES_256_GCM_SHA384', '1abcDE-000123-AB', 'b@example.com'],
  );
});

test('IPv6 address literal and our own CoreMail hop', () => {
  assert.deepEqual([parseReceived(IPV6).fromIp, parseReceived(IPV6).tls], ['2001:db8::25', false]);
  const own = parseReceived(COREMAIL);
  assert.deepEqual([own.from, own.fromIp, own.with, own.tls, own.id], ['client.ext.test', '192.0.2.1', 'ESMTPSA', true, 'ABCD1234']);
});

test('missing or broken dates leave the time out; unparseable fields are kept as text', () => {
  assert.equal(parseReceived('from a.example by b.example with SMTP').time, undefined);
  assert.equal(parseReceived('from a.example by b.example; not a date at all').time, undefined);
  const raw = parseReceived('(qmail 12345 invoked by uid 89); 20 Nov 2026 10:00:00 -0000');
  assert.equal(raw.raw, '(qmail 12345 invoked by uid 89); 20 Nov 2026 10:00:00 -0000');
  assert.equal(raw.tls, false);
  assert.equal(parseReceived('<script>alert(1)</script>').raw, '<script>alert(1)</script>', 'kept verbatim: the BCP renders text only');
});

test('chain: oldest hop first, delays between hops, unknown times skipped', () => {
  const block = [
    `Received: ${GMAIL_OUT}`,
    'Received: from a.example by b.example with SMTP',
    `Received: ${POSTFIX_LOCAL}`,
    'Subject: x',
  ].join('\r\n');
  const hops = parseReceivedChain(headerFields(block));
  assert.deepEqual(hops.map((h) => h.by), ['mail.example.org', 'b.example', 'mx.corp.test']);
  assert.equal(hops[0]!.delayMs, undefined);
  assert.equal(hops[1]!.delayMs, undefined);
  assert.equal(hops[2]!.delayMs, 127_000, '09:02:05Z − 08:59:58Z');
});

test('header block: stops at the empty line (CRLF and LF), folded values are unfolded, the body is never read', () => {
  const raw = Buffer.from('Received: from a.example\r\n\tby b.example; Fri, 20 Nov 2026 10:00:00 +0000\r\nSubject: hi\r\n\r\nReceived: from body.example by fake.example\r\n');
  const fields = headerFields(headerBlock(raw));
  assert.deepEqual(fields.map((f) => f.name), ['Received', 'Subject']);
  assert.equal(fields[0]!.value, 'from a.example by b.example; Fri, 20 Nov 2026 10:00:00 +0000');
  assert.equal(headerFields(headerBlock(Buffer.from('A: 1\nB: 2\n\nC: 3'))).length, 2);
});

test('hostile input: huge header blocks, many Received fields, deep comments stay bounded and fast', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `Received: from h${i}.example by x.example; Fri, 20 Nov 2026 10:00:00 +0000`).join('\r\n');
  const raw = Buffer.from(`${many}\r\n\r\nbody`);
  const t0 = Date.now();
  const block = headerBlock(raw);
  assert.ok(block.length <= HEADER_READ_LIMIT);
  const hops = parseReceivedChain(headerFields(block));
  assert.ok(hops.length <= MAX_RECEIVED);
  const deep = parseReceived(`from a.example ${'('.repeat(20000)} by b.example`);
  const long = parseReceived(`from ${'a'.repeat(100000)} by ${'b('.repeat(50000)}`);
  assert.ok(Date.now() - t0 < 1000, 'linear time');
  assert.equal(deep.from, 'a.example');
  assert.ok((long.from ?? '').length <= 255);
});

test('Authentication-Results and ARC summary', () => {
  const fields = headerFields([
    'Authentication-Results: mx.corp.test; spf=pass smtp.mailfrom=a@sender.example; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example',
    'ARC-Seal: i=1; a=rsa-sha256; t=1763630000; cv=none; d=google.com; s=arc-20160816; b=AAAA',
    'ARC-Authentication-Results: i=1; mx.google.com; spf=pass smtp.mailfrom=a@sender.example',
  ].join('\r\n'));
  const s = authSummary(fields);
  assert.deepEqual(s.authResults[0], {
    source: 'Authentication-Results', authservId: 'mx.corp.test',
    results: [
      { method: 'spf', result: 'pass', domain: 'sender.example' },
      { method: 'dkim', result: 'pass', domain: 'sender.example' },
      { method: 'dmarc', result: 'pass', domain: 'sender.example' },
    ],
  });
  assert.equal(s.authResults[1]!.source, 'ARC-Authentication-Results i=1');
  assert.equal(s.authResults[1]!.authservId, 'mx.google.com');
  assert.deepEqual(s.arcSeals, [{ instance: 1, cv: 'none', domain: 'google.com' }]);
});
