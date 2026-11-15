/**
 * Outbound relay: per-recipient results, MX fallback (RFC 5321 §5.1, RFC 7505),
 * smarthost certificate verification (RFC 8314), EHLO name.
 * Run: node --import tsx --test src/outbound/relay.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { relayMessage, classifySmtpError, lookupMx, smarthostTransportOptions, mxTransportOptions, isCertificateError } = await import('./relay.js');
type Deps = NonNullable<Parameters<typeof relayMessage>[4]>;

const MX_CONFIG = {
  mode: 'mx' as const, smarthostHost: '', smarthostPort: 587, smarthostTls: true, smarthostImplicitTls: false,
  smarthostUsername: '', smarthostPassword: '', heloName: 'mail.corp.test',
};

function smtpErr(message: string, response: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${message}: ${response}`), { response, responseCode: Number(response.slice(0, 3)), ...extra });
}

test('a remote 4xx/5xx for single recipients is reported per recipient, the accepted ones as delivered', async () => {
  const sent: Array<{ host: unknown; name: unknown; to: string[] }> = [];
  const deps: Deps = {
    config: async () => MX_CONFIG,
    resolveMx: async () => [{ exchange: 'mx.ext.test', priority: 10 }],
    send: async (opts, envelope) => {
      sent.push({ host: opts['host'], name: opts['name'], to: envelope.to });
      return {
        accepted: ['ok@ext.test'],
        rejected: ['grey@ext.test', 'gone@ext.test'],
        rejectedErrors: [
          Object.assign(smtpErr('Recipient command failed', '450 4.2.0 Greylisted'), { recipient: 'grey@ext.test' }),
          Object.assign(smtpErr('Recipient command failed', '550 5.1.1 No such user'), { recipient: 'gone@ext.test' }),
        ],
      };
    },
  };

  const r = await relayMessage(Buffer.from('x'), 'a@corp.test', ['ok@ext.test', 'grey@ext.test', 'gone@ext.test'], {}, deps);

  assert.deepEqual(r.delivered, ['ok@ext.test']);
  assert.deepEqual(r.failures.map((f) => [f.rcpt, f.code, f.status, f.permanent]), [
    ['grey@ext.test', 450, '4.2.0', false],
    ['gone@ext.test', 550, '5.1.1', true],
  ]);
  assert.equal(sent[0]?.name, 'mail.corp.test', 'EHLO uses the public host name (RFC 5321 §4.1.1.1)');
});

test('"all recipients rejected" keeps the individual reply of each recipient', async () => {
  const deps: Deps = {
    config: async () => MX_CONFIG,
    resolveMx: async () => [{ exchange: 'mx.ext.test', priority: 10 }],
    send: async () => {
      throw Object.assign(smtpErr("Can't send mail - all recipients were rejected", '550 5.1.1 b'), {
        rejectedErrors: [
          Object.assign(smtpErr('Recipient command failed', '452 4.2.2 Mailbox full'), { recipient: 'a@ext.test' }),
          Object.assign(smtpErr('Recipient command failed', '550 5.1.1 Unknown'), { recipient: 'b@ext.test' }),
        ],
      });
    },
  };

  const r = await relayMessage(Buffer.from('x'), 'a@corp.test', ['a@ext.test', 'b@ext.test'], {}, deps);

  assert.deepEqual(r.failures.map((f) => [f.rcpt, f.permanent, f.status]), [['a@ext.test', false, '4.2.2'], ['b@ext.test', true, '5.1.1']]);
});

test('a network error is temporary even when it contains a port number like 587', () => {
  const c = classifySmtpError(Object.assign(new Error('connect ETIMEDOUT 10.0.0.5:587'), { code: 'ETIMEDOUT' }));

  assert.equal(c.permanent, false);
  assert.equal(c.code, null);
});

test('MX lookup: no MX → implicit MX (the domain), null MX → 5.1.10, NXDOMAIN → 5.1.2, SERVFAIL → temporary', async () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  assert.deepEqual(await lookupMx('a.test', async () => []), { kind: 'hosts', hosts: ['a.test'] });
  assert.deepEqual(await lookupMx('a.test', async () => { throw err('ENODATA'); }), { kind: 'hosts', hosts: ['a.test'] });
  const nullMx = await lookupMx('a.test', async () => [{ exchange: '', priority: 0 }]);
  assert.equal(nullMx.kind === 'fail' && nullMx.failure.status, '5.1.10');
  assert.equal(nullMx.kind === 'fail' && nullMx.failure.permanent, true);
  const nx = await lookupMx('a.test', async () => { throw err('ENOTFOUND'); });
  assert.equal(nx.kind === 'fail' && nx.failure.status, '5.1.2');
  const servfail = await lookupMx('a.test', async () => { throw err('ESERVFAIL'); });
  assert.equal(servfail.kind === 'fail' && servfail.failure.permanent, false);
  assert.deepEqual(await lookupMx('a.test', async () => [{ exchange: 'b', priority: 20 }, { exchange: 'a', priority: 5 }]), { kind: 'hosts', hosts: ['a', 'b'] });
});

test('a domain without MX records is delivered to its A/AAAA host; the next MX is tried on temporary errors', async () => {
  const hosts: unknown[] = [];
  const deps: Deps = {
    config: async () => MX_CONFIG,
    resolveMx: async (d) => (d === 'nomx.test' ? [] : [{ exchange: 'mx1.ext.test', priority: 1 }, { exchange: 'mx2.ext.test', priority: 2 }]),
    send: async (opts, envelope) => {
      hosts.push(opts['host']);
      if (opts['host'] === 'mx1.ext.test') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' });
      return { accepted: envelope.to, rejected: [] };
    },
  };

  const r = await relayMessage(Buffer.from('x'), '', ['a@nomx.test', 'b@ext.test'], {}, deps);

  assert.deepEqual(r.delivered.sort(), ['a@nomx.test', 'b@ext.test']);
  assert.deepEqual(hosts, ['nomx.test', 'mx1.ext.test', 'mx2.ext.test']);
});

test('smarthost: certificate verified against the host when TLS or credentials are used; explicit opt-out only', () => {
  const cfg = { ...MX_CONFIG, mode: 'smarthost' as const, smarthostHost: 'relay.provider.test', smarthostUsername: 'u', smarthostPassword: 'p' };

  const strict = smarthostTransportOptions(cfg, undefined, {});
  const optOut = smarthostTransportOptions(cfg, undefined, { SMARTHOST_TLS_INSECURE: 'true' });
  const plainNoAuth = smarthostTransportOptions({ ...cfg, smarthostTls: false, smarthostUsername: '' }, undefined, {});

  assert.deepEqual(strict['tls'], { rejectUnauthorized: true, servername: 'relay.provider.test', minVersion: 'TLSv1.2' });
  assert.equal(strict['name'], 'mail.corp.test');
  assert.deepEqual(optOut['tls'], { rejectUnauthorized: false });
  assert.deepEqual(plainNoAuth['tls'], { rejectUnauthorized: false });
  assert.equal(mxTransportOptions('mx.ext.test', 'mail.corp.test')['name'], 'mail.corp.test');
});

// v8.0 review: credentials with the TLS box off went out after an opportunistic
// (strippable) STARTTLS; opportunisticTLS also allowed plaintext after a failed STARTTLS reply.
test('smarthost: STARTTLS is mandatory whenever credentials are sent; never an opportunistic fallback then', () => {
  const base = { ...MX_CONFIG, mode: 'smarthost' as const, smarthostHost: 'relay.provider.test', smarthostPort: 587 };
  const authNoTlsBox = smarthostTransportOptions({ ...base, smarthostTls: false, smarthostUsername: 'u', smarthostPassword: 'p' }, undefined, {});
  const authTls = smarthostTransportOptions({ ...base, smarthostTls: true, smarthostUsername: 'u', smarthostPassword: 'p' }, undefined, {});
  const implicit = smarthostTransportOptions({ ...base, smarthostImplicitTls: true, smarthostPort: 465, smarthostUsername: 'u', smarthostPassword: 'p' }, undefined, {});
  const anonPlain = smarthostTransportOptions({ ...base, smarthostTls: false, smarthostUsername: '' }, undefined, {});

  assert.equal(authNoTlsBox['requireTLS'], true);
  assert.equal(authNoTlsBox['opportunisticTLS'], false);
  assert.deepEqual(authNoTlsBox['tls'], { rejectUnauthorized: true, servername: 'relay.provider.test', minVersion: 'TLSv1.2' });
  assert.equal(authTls['requireTLS'], true);
  assert.equal(authTls['opportunisticTLS'], false);
  assert.equal(implicit['secure'], true);
  assert.equal(implicit['requireTLS'], false);
  assert.equal(anonPlain['requireTLS'], false);
});

test('smarthost: a rejected certificate fails with a message naming SMARTHOST_TLS_INSECURE', async () => {
  assert.ok(isCertificateError(Object.assign(new Error('self-signed certificate'), { code: 'ESOCKET' })));
  assert.ok(isCertificateError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'x' }));
  assert.ok(isCertificateError(Object.assign(new Error('wrapped'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } })));
  assert.ok(!isCertificateError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' })));

  const deps: Deps = {
    config: async () => ({ ...MX_CONFIG, mode: 'smarthost', smarthostHost: 'relay.provider.test' }),
    resolveMx: async () => [],
    send: async () => { throw Object.assign(new Error('self-signed certificate'), { code: 'ESOCKET' }); },
  };
  const r = await relayMessage(Buffer.from('x'), 'a@corp.test', ['b@ext.test'], {}, deps);

  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0]!.permanent, false, 'deferred, not bounced');
  assert.match(r.failures[0]!.message, /SMARTHOST_TLS_INSECURE=true/);
});
