/**
 * Device relay: never an open relay.
 *  - external client IPs, other listener ports, a disabled or empty policy:
 *    external recipients get the normal port-25 answer (refused);
 *  - configured devices may only use configured sender domains (envelope AND
 *    From:/Sender: header), within the per-IP rate limit (fail closed);
 *  - local recipients and authenticated sessions keep the wrapped behaviour.
 * In-memory policy/handlers, no database or Redis.
 * Run: node --import tsx --test src/inbound/device-relay.test.ts (in packages/smtp-server)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const {
  compileDeviceRelayPolicy, relayDecision, headerSenderViolation, addressDomain, withDeviceRelay,
  RELAY_SENDER_DENIED, RelayApprovals,
} = await import('./device-relay.js');
type Deps = import('./device-relay.js').DeviceRelayDeps;
type Handlers = import('../core/types.js').SmtpHandlers;

const CONFIG = {
  enabled: true,
  allowedNetworks: ['192.168.10.0/24', '10.20.0.5'],
  senderDomains: ['example.com'],
  port: 25,
  maxMessagesPerMinute: 2,
};
const DEVICE_IP = '192.168.10.40';
const EXTERNAL_IP = '203.0.113.50';
const LOCAL = 'alice@example.com';
const REMOTE = 'partner@example.net';

const mail = (from = 'scanner@example.com', extra = ''): Buffer =>
  Buffer.from(`From: Scanner <${from}>\r\n${extra}To: <${REMOTE}>\r\nSubject: Scan\r\n\r\nbody\r\n`);

function harness(over: { config?: typeof CONFIG | null; port?: number; slot?: Deps['takeSlot'] } = {}) {
  const calls = { baseRcpt: [] as string[], baseMessage: 0, delivered: [] as string[][] };
  const live = { config: over.config === undefined ? CONFIG : over.config };
  const base: Handlers = {
    onConnect: async () => true,
    onMailFrom: async () => null,
    // Port-25 behaviour: only local recipients exist.
    onRcptTo: async (to) => { calls.baseRcpt.push(to); return to.endsWith('@example.com') ? null : '5.1.1 User unknown'; },
    onMessage: async () => { calls.baseMessage++; },
  };
  let used = 0;
  const deps: Deps = {
    loadPolicy: async () => compileDeviceRelayPolicy(live.config),
    isLocal: async (a) => a.toLowerCase().endsWith('@example.com'),
    takeSlot: over.slot ?? (async (_ip, limit) => ++used <= limit),
    deliver: async (d) => { calls.delivered.push(d.to); },
  };
  return { h: withDeviceRelay(base, over.port ?? 25, deps), calls, live };
}

/** One SMTP transaction as SmtpSession drives it: RCPT for each recipient, DATA only if all were accepted. */
async function transaction(h: Handlers, from: string, to: string[], ip: string, raw = mail(from)): Promise<string | null> {
  for (const rcpt of to) {
    const reject = await h.onRcptTo(rcpt, from, null, ip);
    if (reject !== null) return reject;
  }
  await h.onMessage(raw, from, to, null, ip);
  return null;
}

describe('pure policy', () => {
  test('inactive unless enabled with at least one network and one sender domain', () => {
    assert.equal(compileDeviceRelayPolicy(null).active, false);
    assert.equal(compileDeviceRelayPolicy({ ...CONFIG, enabled: false }).active, false);
    assert.equal(compileDeviceRelayPolicy({ ...CONFIG, allowedNetworks: [] }).active, false);
    assert.equal(compileDeviceRelayPolicy({ ...CONFIG, allowedNetworks: ['not-an-ip'] }).active, false);
    assert.equal(compileDeviceRelayPolicy({ ...CONFIG, senderDomains: [' '] }).active, false);
    assert.equal(compileDeviceRelayPolicy(CONFIG).active, true);
  });

  test('relayDecision: network, port and sender domain must all match', () => {
    const p = compileDeviceRelayPolicy(CONFIG);
    assert.equal(relayDecision(p, { listenerPort: 25, ip: DEVICE_IP, mailFrom: 'scanner@example.com' }), 'allowed');
    assert.equal(relayDecision(p, { listenerPort: 25, ip: '::ffff:10.20.0.5', mailFrom: 'Printer@EXAMPLE.com' }), 'allowed');
    assert.equal(relayDecision(p, { listenerPort: 25, ip: EXTERNAL_IP, mailFrom: 'scanner@example.com' }), 'not-device');
    assert.equal(relayDecision(p, { listenerPort: 25, ip: '10.20.0.6', mailFrom: 'scanner@example.com' }), 'not-device');
    assert.equal(relayDecision(p, { listenerPort: 2525, ip: DEVICE_IP, mailFrom: 'scanner@example.com' }), 'not-device');
    assert.equal(relayDecision(p, { listenerPort: 25, ip: DEVICE_IP, mailFrom: 'ceo@bank.example.org' }), 'sender-not-allowed');
    assert.equal(relayDecision(p, { listenerPort: 25, ip: DEVICE_IP, mailFrom: '' }), 'sender-not-allowed', 'null sender');
    assert.equal(relayDecision(p, { listenerPort: 25, ip: DEVICE_IP, mailFrom: 'x@sub.example.com' }), 'sender-not-allowed', 'no implicit subdomains');
  });

  test('addressDomain', () => {
    assert.equal(addressDomain('<a@Example.COM.>'), 'example.com');
    assert.equal(addressDomain('a@'), null);
    assert.equal(addressDomain('@example.com'), null);
    assert.equal(addressDomain(''), null);
  });

  test('headerSenderViolation: From required, From/Sender domains must be configured', () => {
    const domains = new Set(['example.com']);
    assert.equal(headerSenderViolation(mail(), domains), null);
    assert.match(headerSenderViolation(mail('boss@bank.example.org'), domains) ?? '', /not permitted/);
    assert.match(headerSenderViolation(mail('scanner@example.com', 'Sender: <x@evil.example.net>\r\n'), domains) ?? '', /not permitted/);
    assert.match(headerSenderViolation(Buffer.from('Subject: x\r\n\r\nbody'), domains) ?? '', /From header missing/);
    assert.match(headerSenderViolation(Buffer.from('From: a@example.com\r\nFrom: b@example.com\r\n\r\n'), domains) ?? '', /multiple From/);
  });
});

describe('never an open relay', () => {
  test('external client IP: external recipient refused by the normal port-25 path', async () => {
    const { h, calls } = harness();
    assert.equal(await transaction(h, 'scanner@example.com', [REMOTE], EXTERNAL_IP), '5.1.1 User unknown');
    assert.deepEqual(calls.baseRcpt, [REMOTE]);
    assert.deepEqual(calls.delivered, []);
    assert.equal(calls.baseMessage, 0);
  });

  test('a message without a relay approval at RCPT never takes the relay path', async () => {
    const { h, calls } = harness();
    await h.onMessage(mail(), 'scanner@example.com', [REMOTE], null, DEVICE_IP);
    assert.deepEqual(calls.delivered, []);
    assert.equal(calls.baseMessage, 1, 'unchanged inbound handling');
  });

  test('device IP with an unlisted sender domain is refused at RCPT', async () => {
    const { h, calls } = harness();
    assert.equal(await transaction(h, 'ceo@bank.example.org', [REMOTE], DEVICE_IP), RELAY_SENDER_DENIED);
    assert.equal(await transaction(h, '', [REMOTE], DEVICE_IP), RELAY_SENDER_DENIED, 'null sender');
    assert.deepEqual(calls.delivered, []);
  });

  test('relay switched off between RCPT and DATA: 550 at DATA, nothing delivered', async () => {
    const { h, calls, live } = harness();
    assert.equal(await h.onRcptTo(REMOTE, 'scanner@example.com', null, DEVICE_IP), null);
    live.config = { ...CONFIG, enabled: false };
    await assert.rejects(h.onMessage(mail(), 'scanner@example.com', [REMOTE], null, DEVICE_IP), /^Error: 550 5\.7\.1 Relaying denied$/);
    assert.deepEqual(calls.delivered, []);
    assert.equal(calls.baseMessage, 0);
  });

  test('device IP on another listener port than configured: normal behaviour', async () => {
    const { h, calls } = harness({ config: { ...CONFIG, port: 2525 }, port: 25 });
    assert.equal(await h.onRcptTo(REMOTE, 'scanner@example.com', null, DEVICE_IP), '5.1.1 User unknown');
    assert.deepEqual(calls.baseRcpt, [REMOTE]);
  });

  test('disabled / missing policy: normal behaviour', async () => {
    for (const config of [null, { ...CONFIG, enabled: false }]) {
      const { h } = harness({ config });
      assert.equal(await h.onRcptTo(REMOTE, 'scanner@example.com', null, DEVICE_IP), '5.1.1 User unknown');
    }
  });

  test('a forged From: header from a device is refused', async () => {
    const { h, calls } = harness();
    await assert.rejects(transaction(h, 'scanner@example.com', [REMOTE], DEVICE_IP, mail('boss@bank.example.org')), /550 5\.7\.1 Relaying denied: header sender/);
    assert.deepEqual(calls.delivered, []);
  });

  test('approvals: per IP + sender + recipient, case-insensitive, counted, expiring', async () => {
    const a = new RelayApprovals();
    a.add(DEVICE_IP, 'S@example.com', 'X@example.net', 0);
    a.add(DEVICE_IP, 's@example.com', 'x@example.net', 0);
    assert.equal(a.take(EXTERNAL_IP, 's@example.com', ['x@example.net'], 1), false, 'other IP');
    assert.equal(a.take(DEVICE_IP, 's@example.com', ['x@example.net'], 1), true);
    assert.equal(a.take(DEVICE_IP, 's@example.com', ['x@example.net'], 1), true, 'second parallel session');
    assert.equal(a.take(DEVICE_IP, 's@example.com', ['x@example.net'], 1), false, 'consumed');
    a.add(DEVICE_IP, 's@example.com', 'x@example.net', 0);
    assert.equal(a.take(DEVICE_IP, 's@example.com', ['x@example.net'], 16 * 60_000), false, 'expired');
  });
});

describe('configured devices', () => {
  test('allowed: external recipient accepted at RCPT, message handed to the relay delivery', async () => {
    const { h, calls } = harness();
    assert.equal(await transaction(h, 'scanner@example.com', [LOCAL, REMOTE], DEVICE_IP), null);
    assert.deepEqual(calls.baseRcpt, [LOCAL], 'no greylisting / user lookup for the relayed recipient');
    assert.deepEqual(calls.delivered, [[LOCAL, REMOTE]]);
    assert.equal(calls.baseMessage, 0);
  });

  test('local-only messages and authenticated sessions keep the inbound path', async () => {
    const { h, calls } = harness();
    assert.equal(await h.onRcptTo(LOCAL, 'scanner@example.com', null, DEVICE_IP), null);
    await h.onMessage(mail(), 'scanner@example.com', [LOCAL], null, DEVICE_IP);
    await h.onRcptTo(REMOTE, 'scanner@example.com', { id: 'u1', email: 'u@example.com' }, EXTERNAL_IP);
    assert.deepEqual(calls.baseRcpt, [LOCAL, REMOTE]);
    assert.equal(calls.baseMessage, 1);
    assert.deepEqual(calls.delivered, []);
  });

  test('rate limit per source IP: excess messages are deferred with 451', async () => {
    const { h, calls } = harness();
    await transaction(h, 'scanner@example.com', [REMOTE], DEVICE_IP);
    await transaction(h, 'scanner@example.com', [REMOTE], DEVICE_IP);
    await assert.rejects(transaction(h, 'scanner@example.com', [REMOTE], DEVICE_IP), /^Error: 451 4\.7\.1 Device relay rate limit/);
    assert.equal(calls.delivered.length, 2);
  });

  test('rate limiter unavailable: fail closed (451), nothing delivered', async () => {
    const { h, calls } = harness({ slot: async () => { throw new Error('redis down'); } });
    await assert.rejects(transaction(h, 'scanner@example.com', [REMOTE], DEVICE_IP), /^Error: 451 4\.3\.0/);
    assert.deepEqual(calls.delivered, []);
  });
});
