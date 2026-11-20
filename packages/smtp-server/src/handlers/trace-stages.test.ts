/**
 * Message trace (10.2): stage builders, the content-filter checks summary, the
 * relay route (MX records, connected host, TLS, remote reply), session
 * connection facts and the queue attempt trace.
 * Run: node --import tsx --test src/handlers/trace-stages.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined, systemLog: { create: async () => ({}) } };

const { filterDecisionStage, sessionStages, contentFilterStages, aliasStage, relayStages, transportRuleDetail, authStageFromHeaders } = await import('./trace-stages.js');
const { parseContentChecks, interpretContentFilterResponse } = await import('../inbound/connection-filter.js');
const { relayMessage, nodemailerConnectionLogger } = await import('../outbound/relay.js');
const { connectionFacts } = await import('../core/session.js');
const { queuedStage, withAttemptTrace, attemptTraceOf, outboundTraceFields, deliverOutboundJob } = await import('../outbound/queue.js');
const { createTraceRecorder, traceStage } = await import('@coremail/storage');

const AT = new Date('2026-11-20T10:00:00Z');

test('connection-filter verdicts become ok / warn / fail notes', () => {
  assert.deepEqual(
    [filterDecisionStage('connection-check', { kind: 'accept', reason: 'DNSWL whitelisted' }, { at: AT, ms: 4 })].map((s) => [s.result, s.detail?.['reason'], s.ms]),
    [['ok', 'DNSWL whitelisted', 4]],
  );
  const grey = filterDecisionStage('recipient-check', { kind: 'block', action: 'defer', reason: 'Greylisted' }, { at: AT, recipient: 'bob@corp.test' });
  assert.deepEqual([grey.result, grey.detail?.['recipient'], grey.detail?.['action']], ['warn', 'bob@corp.test', 'defer']);
  assert.equal(filterDecisionStage('recipient-check', { kind: 'block', action: 'reject', reason: 'Sender blocked' }).result, 'fail');
  assert.equal(filterDecisionStage('connection-check', { kind: 'unavailable', detail: 'HTTP 500' }).result, 'warn');
});

test('session stages: port, TLS version + cipher, HELO, AUTH user, then the session notes', () => {
  const note = traceStage('connection-check', 'ok', { reason: 'Connection checks passed' }, { at: AT });
  const [conn, ...notes] = sessionStages('203.0.113.7', {
    helo: 'mail.sender.example', protocol: 'ESMTPS', hostname: 'mx.corp.test', sessionId: 'AB12CD34',
    connection: { port: 25, tlsVersion: 'TLSv1.3', tlsCipher: 'TLS_AES_256_GCM_SHA384', connectedAt: AT.toISOString(), notes: [note] },
  });
  assert.equal(conn!.stage, 'connection');
  assert.equal(conn!.result, 'ok');
  assert.equal(conn!.at, AT.toISOString());
  assert.deepEqual(conn!.detail, {
    clientIp: '203.0.113.7', helo: 'mail.sender.example', protocol: 'ESMTPS', port: 25, tls: true,
    tlsVersion: 'TLSv1.3', tlsCipher: 'TLS_AES_256_GCM_SHA384', sessionId: 'AB12CD34',
  });
  assert.deepEqual(notes, [note]);
  const plain = sessionStages('203.0.113.7', { helo: 'x', protocol: 'ESMTP', hostname: 'h', sessionId: 's', connection: { port: 25 } });
  assert.equal(plain[0]!.result, 'warn', 'a connection without TLS is flagged');
  assert.equal(plain[0]!.detail?.['tls'], false);
});

test('connectionFacts reads TLS details only from an encrypted socket', () => {
  const socket = { localPort: 587, getProtocol: () => 'TLSv1.2', getCipher: () => ({ name: 'ECDHE-RSA-AES128-GCM-SHA256' }) };
  assert.deepEqual(connectionFacts({ socket, tls: true, authUser: 'a@corp.test', connectedAt: AT, notes: [] }), {
    port: 587, tlsVersion: 'TLSv1.2', tlsCipher: 'ECDHE-RSA-AES128-GCM-SHA256', authUser: 'a@corp.test', connectedAt: AT.toISOString(),
  });
  assert.deepEqual(connectionFacts({ socket, tls: false, notes: [] }), { port: 587 });
  const broken = { localPort: 25, getProtocol: () => { throw new Error('closed'); } };
  assert.equal(connectionFacts({ socket: broken, tls: true, notes: [] }).tlsVersion, 'TLS');
});

test('the checks summary of /check/content is validated field by field', () => {
  const parsed = parseContentChecks({
    auth: { spf: 'pass', spfDomain: 'sender.example', dkim: 'pass', dkimDomains: ['sender.example', 'bad domain!'], dmarc: 'pass', arc: 'none', ms: 12 },
    senderList: 'allow',
    attachments: 'evil',
    virus: { status: 'clean', ms: 30, signature: '<script>' },
    spam: { verdict: 'junk', score: 7.123, dnsblZones: ['zen.spamhaus.org'] },
  });
  assert.deepEqual(parsed, {
    auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', arc: 'none', spfDomain: 'sender.example', dkimDomains: ['sender.example'], ms: 12 },
    senderList: 'allow',
    virus: { status: 'clean', ms: 30 },
    spam: { verdict: 'junk', score: 7.12, dnsblZones: ['zen.spamhaus.org'] },
  });
  assert.equal(parseContentChecks('x'), undefined);
  assert.equal(parseContentChecks({ auth: { spf: 'PASS; drop table' } }), undefined);
  const r = interpretContentFilterResponse(200, { action: 'accept', checks: { senderList: 'none' } });
  assert.ok(r.kind === 'ok' && r.result.checks?.senderList === 'none');
});

test('content-filter stages: per-stage results, then the decision with the round trip time', () => {
  const stages = contentFilterStages({
    action: 'accept', junkFolder: true, spamScore: 7.1, reason: 'Spam — deliver to Junk folder',
    checks: {
      auth: { spf: 'softfail', dkim: 'none', dmarc: 'fail', arc: 'none', headerFrom: 'bank.example', ms: 9 },
      senderList: 'none', attachments: 'ok', virus: { status: 'clean', ms: 25 }, spam: { verdict: 'junk', score: 7.1, ms: 40 },
    },
  }, { at: AT, ms: 120 });
  assert.deepEqual(stages.map((s) => [s.stage, s.result]), [
    ['authentication', 'fail'], ['sender-list', 'ok'], ['attachments', 'ok'], ['virus-scan', 'ok'], ['spam', 'warn'], ['content-filter', 'warn'],
  ]);
  assert.equal(stages[0]!.ms, 9);
  assert.equal(stages[0]!.detail?.['headerFrom'], 'bank.example');
  assert.equal(stages.at(-1)!.ms, 120);
  assert.equal(stages.at(-1)!.detail?.['junk'], true);
});

test('content-filter stages without a checks summary fall back to our Authentication-Results and the score', () => {
  const stages = contentFilterStages({
    action: 'quarantine', virusName: 'Eicar-Test-Signature', spamScore: 1,
    authHeaders: 'Received-SPF: pass\r\nAuthentication-Results: mx.corp.test;\r\n spf=pass smtp.mailfrom=a@sender.example;\r\n dkim=pass header.d=sender.example;\r\n dmarc=pass header.from=sender.example\r\n',
  }, { at: AT });
  assert.deepEqual(stages.map((s) => [s.stage, s.result]), [['authentication', 'ok'], ['virus-scan', 'fail'], ['spam', 'ok'], ['content-filter', 'fail']]);
  assert.equal(stages[0]!.detail?.['spfDomain'], 'sender.example');
  assert.equal(stages[1]!.detail?.['signature'], 'Eicar-Test-Signature');
  assert.equal(authStageFromHeaders('Received-SPF: pass\r\n'), null);
});

test('alias stage lists only expanded addresses; transport rule detail names the actions', () => {
  assert.equal(aliasStage(new Map([['bob@corp.test', ['bob@corp.test']]])), null);
  const s = aliasStage(new Map([['bob@corp.test', ['sales@corp.test']], ['eve@corp.test', ['sales@corp.test']]]), { at: AT });
  assert.deepEqual(s?.detail?.['expanded'], ['sales@corp.test → bob@corp.test', 'sales@corp.test → eve@corp.test']);
  assert.deepEqual(transportRuleDetail({
    rejected: false, quarantined: false, redirectedTo: [], additionalRcpts: [], removedRcpts: [],
    headerAdds: [{ name: 'X-Ext', value: '1' }], headerRemoves: [], subjectPrefix: '[EXTERN]', subjectSuffix: '', disclaimerHtml: '', appliedRuleIds: ['r1'],
  }), { ruleIds: ['r1'], actions: ['addHeader', 'subject'] });
});

const MX_CONFIG = {
  mode: 'mx' as const, smarthostHost: '', smarthostPort: 587, smarthostTls: true, smarthostImplicitTls: false,
  smarthostUsername: '', smarthostPassword: '', heloName: 'mail.corp.test',
};

test('relay route: MX records as resolved, the connected host + address, TLS and the remote reply; fallback to the next MX', async () => {
  const r = await relayMessage(Buffer.from('x'), 'a@corp.test', ['u@ext.test'], {}, {
    config: async () => MX_CONFIG,
    resolveMx: async () => [{ exchange: 'mx2.ext.test', priority: 20 }, { exchange: 'mx1.ext.test', priority: 10 }],
    resolveHost: async (h) => [h === 'mx1.ext.test' ? '93.184.216.34' : '93.184.216.35'],
    send: async (opts, _env, _raw, _dsn, observe) => {
      if (opts['host'] === '93.184.216.34') {
        observe?.({ address: '93.184.216.34', port: 25, tls: 'none' });
        throw Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' });
      }
      observe?.({ address: '93.184.216.35', port: 25, tls: 'starttls' });
      return { accepted: ['u@ext.test'], rejected: [], response: '250 2.0.0 OK queued as 4Xyz' };
    },
  });
  assert.deepEqual(r.delivered, ['u@ext.test']);
  const stages = relayStages(r.hops ?? []);
  assert.deepEqual(stages.map((s) => [s.stage, s.result]), [['mx', 'ok'], ['remote', 'warn'], ['remote', 'ok']]);
  assert.deepEqual(stages[0]!.detail?.['records'], ['10 mx1.ext.test', '20 mx2.ext.test']);
  assert.deepEqual([stages[1]!.detail?.['host'], stages[1]!.detail?.['address'], stages[1]!.detail?.['tls']], ['mx1.ext.test', '93.184.216.34', 'none']);
  assert.deepEqual([stages[2]!.detail?.['host'], stages[2]!.detail?.['tls'], stages[2]!.detail?.['code'], stages[2]!.detail?.['response']],
    ['mx2.ext.test', 'starttls', 250, '250 2.0.0 OK queued as 4Xyz']);
});

test('relay route: NXDOMAIN and null MX are recorded as failed lookups without a connection', async () => {
  const nx = await relayMessage(Buffer.from('x'), 'a@corp.test', ['u@gone.test'], {}, {
    config: async () => MX_CONFIG,
    resolveMx: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); },
    send: async () => { throw new Error('must not connect'); },
  });
  const stages = relayStages(nx.hops ?? []);
  assert.deepEqual(stages.map((s) => [s.stage, s.result]), [['mx', 'fail']]);
  assert.match(String(stages[0]!.detail?.['error']), /does not exist/);
  assert.equal(stages[0]!.detail?.['implicit'], undefined);
  const implicit = await relayMessage(Buffer.from('x'), 'a@corp.test', ['u@nomx.test'], {}, {
    config: async () => MX_CONFIG, resolveMx: async () => [], send: async () => ({ accepted: ['u@nomx.test'], rejected: [] }),
  });
  assert.equal(relayStages(implicit.hops ?? [])[0]!.detail?.['implicit'], true);
});

test('relay route via smarthost: one remote entry, rejected recipients give the reply code', async () => {
  const r = await relayMessage(Buffer.from('x'), 'a@corp.test', ['u@ext.test'], {}, {
    config: async () => ({ ...MX_CONFIG, mode: 'smarthost' as const, smarthostHost: 'relay.provider.test' }),
    resolveMx: async () => { throw new Error('no MX lookup in smarthost mode'); },
    send: async () => { throw Object.assign(new Error('Message failed'), { response: '554 5.7.1 Relay access denied', responseCode: 554 }); },
  });
  const stages = relayStages(r.hops ?? []);
  assert.deepEqual(stages.map((s) => [s.stage, s.result, s.detail?.['mode'], s.detail?.['host'], s.detail?.['port'], s.detail?.['code']]),
    [['remote', 'fail', 'smarthost', 'relay.provider.test', 587, 554]]);
});

test('the nodemailer connection logger records the peer and a STARTTLS upgrade only', () => {
  const conn: { address?: string; port?: number; tls?: 'starttls' | 'implicit' | 'none' } = { tls: 'none' };
  const logger = nodemailerConnectionLogger(conn);
  logger.info({ tnx: 'network', remoteAddress: '198.51.100.9', remotePort: 25 }, '%s established to %s:%s');
  logger.info({ tnx: 'smtp' }, 'Connection upgraded with STARTTLS');
  logger.info({ tnx: 'send' }, 'Sending message <x> to <secret@ext.test>');
  assert.deepEqual(conn, { tls: 'starttls', address: '198.51.100.9', port: 25 });
});

test('queue attempt trace: queued stage, DKIM, MX + remote, DSN; remembered on the thrown error', async () => {
  // enqueued just now: older than OUTBOUND_DELAY_DSN_HOURS would add a delay-DSN stage (wall-clock dependent)
  const now = Date.now();
  const job = {
    id: 'job-1', attemptsMade: 1, opts: { attempts: 5 }, timestamp: now,
    data: { messageId: 'trk-1', from: 'a@corp.test', to: ['u@ext.test'] },
    updateData: async () => undefined,
  };
  assert.deepEqual([queuedStage(job).stage, queuedStage(job).detail?.['attempt'], queuedStage(job).at], ['queued', 2, new Date(now).toISOString()]);
  assert.deepEqual(outboundTraceFields(job, '<m@corp.test>'), { jobId: 'job-1', attempt: '2', headerMessageId: '<m@corp.test>' });
  const trace = createTraceRecorder([queuedStage(job)]);
  const deps = {
    isLocalAddress: async () => false,
    expand: async (a: string[]) => a,
    storeLocal: async () => undefined,
    resolveDkim: async () => ({ dkimDomain: 'corp.test', dkimSelector: 'mail', dkimPrivateKey: 'k' }),
    relay: async () => ({
      delivered: [], failures: [{ rcpt: 'u@ext.test', code: 451, status: '4.7.1', message: '451 4.7.1 Try later', permanent: false }],
      hops: [
        { mode: 'mx' as const, domain: 'ext.test', mx: [{ exchange: 'mx.ext.test', priority: 10 }], delivered: 0, failed: 0, at: AT.toISOString() },
        { mode: 'mx' as const, domain: 'ext.test', host: 'mx.ext.test', code: 451, response: '451 4.7.1 Try later', delivered: 0, failed: 1, at: AT.toISOString(), ms: 80 },
      ],
    }),
    bounce: async () => undefined,
    hostname: async () => 'mx.corp.test',
  };
  let thrown: unknown;
  try { await deliverOutboundJob(job, Buffer.from('Message-ID: <m@corp.test>\r\n\r\nx'), deps, trace); } catch (err) { thrown = withAttemptTrace(err, trace, '<m@corp.test>'); }
  assert.ok(thrown instanceof Error);
  const remembered = attemptTraceOf(thrown);
  assert.equal(remembered?.headerMessageId, '<m@corp.test>');
  assert.deepEqual(remembered?.stages.map((s) => [s.stage, s.result]), [['queued', 'info'], ['dkim', 'ok'], ['mx', 'ok'], ['remote', 'warn']]);
  assert.deepEqual(remembered?.stages[1]!.detail, { domain: 'corp.test', selector: 'mail' });
  assert.equal(attemptTraceOf(new Error('other')), undefined);
});
