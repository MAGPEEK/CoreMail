/**
 * Device relay ("Geräte-Relay") — unauthenticated SMTP relay for internal
 * devices (scanners, printers, monitoring) on an inbound listener.
 *
 * A message is relayed to an external recipient ONLY when all of these hold:
 *  - the policy is active (enabled, at least one network and one sender domain),
 *  - the session runs on the configured listener port,
 *  - the client IP lies in one of the configured networks (CIDR),
 *  - the MAIL FROM domain and every From:/Sender: header domain are configured,
 *  - the source IP stays within maxMessagesPerMinute,
 *  - the malware checks pass (security-filter /check/malware: attachment
 *    filter + ClamAV with the configured action and failure policy; a virus is
 *    quarantined or refused, never relayed).
 * Everything else keeps the normal port-25 behaviour: external recipients are
 * refused (never an open relay). Local recipients are always handled by the
 * wrapped inbound handlers, unless the message is relayed — then the whole
 * transaction is delivered like a submission of a trusted device: no SPF/DKIM/
 * DMARC and no spam scoring, but the malware checks above.
 */
import crypto from 'node:crypto';
import {
  createLogger, createCidrMatcher, getRedisClient, RELAY_NETWORK_MIN_PREFIX, type CidrMatcher,
} from '@coremail/core';
import {
  prisma, addressesOf, parseHeaderFields, findBodyStart, stripHeaders, INTERNAL_MAIL_HEADERS,
} from '@coremail/storage';
import { BARE_POSTMASTER, type SmtpHandlers, type AuthUser, type MessageMeta } from '../core/types.js';
import { expandRecipientsWithOrigins, isLocalDomainAddress } from '../handlers/expand.js';
import { enqueueOutbound } from '../outbound/queue.js';
import { dsnForRecipients } from '../core/dsn-params.js';
import {
  buildReceivedHeader, prependHeader, countReceived, stripOwnAuthResults, MAX_RECEIVED_HOPS,
} from '../handlers/trace.js';
import { deliverOnce, deliveryKey, redisDeliveryLedger } from '../handlers/delivery.js';
import { notifyLocalOutcomes } from '../handlers/local-notify.js';
import { storeInboundMessage, toLocalOutcome } from '../handlers/message.js';
import { quarantineMessage, type QuarantineInput } from '../handlers/quarantine.js';
import { completeSubmissionHeaders } from '../submission/handler.js';
import { callContentFilter, CONTENT_FILTER_MAX_BYTES, type ContentFilterVerdict } from './connection-filter.js';
import { SECURITY_FILTER_URL, asciiJson, filterContext } from './handler.js';
import { virusScanHeaderLine } from './virus-scan-header.js';

const log = createLogger('smtp:device-relay');

// ── Policy ────────────────────────────────────────────────────────────────────

/** Stored configuration (DeviceRelaySettings row). */
export interface DeviceRelayConfig {
  enabled: boolean;
  allowedNetworks: string[];
  senderDomains: string[];
  port: number;
  maxMessagesPerMinute: number;
}

export interface DeviceRelayPolicy {
  active: boolean;
  port: number;
  networks: CidrMatcher;
  senderDomains: ReadonlySet<string>;
  maxMessagesPerMinute: number;
}

/** Lower-cased domain of an address (`<>` / no domain → null). */
export function addressDomain(address: string): string | null {
  const a = address.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at <= 0 || at === a.length - 1) return null;
  return a.slice(at + 1).replace(/\.$/, '');
}

/**
 * Pure: compiles the stored configuration. Missing row / empty lists → inactive.
 * Networks broader than RELAY_NETWORK_MIN_PREFIX are ignored here as well —
 * the API refuses them, a hand-edited row must not open the relay either.
 */
export function compileDeviceRelayPolicy(cfg: DeviceRelayConfig | null): DeviceRelayPolicy {
  const networks = createCidrMatcher(cfg?.allowedNetworks ?? [], { minPrefix: RELAY_NETWORK_MIN_PREFIX });
  const senderDomains = new Set((cfg?.senderDomains ?? [])
    .map((d) => d.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean));
  return {
    active: !!cfg?.enabled && networks.entries.length > 0 && senderDomains.size > 0,
    port: cfg?.port ?? 25,
    networks,
    senderDomains,
    maxMessagesPerMinute: Math.max(1, cfg?.maxMessagesPerMinute ?? 30),
  };
}

export type RelayDecision = 'allowed' | 'not-device' | 'sender-not-allowed';

/**
 * Pure: may this session relay? `not-device` = the client is not a configured
 * device on this listener (the caller keeps the normal inbound behaviour).
 */
export function relayDecision(
  policy: DeviceRelayPolicy,
  s: { listenerPort: number; ip: string; mailFrom: string },
): RelayDecision {
  if (!policy.active || s.listenerPort !== policy.port || !policy.networks.contains(s.ip)) return 'not-device';
  const domain = addressDomain(s.mailFrom);
  return domain && policy.senderDomains.has(domain) ? 'allowed' : 'sender-not-allowed';
}

/**
 * Pure: From:/Sender: header check of a relayed message. A From: field is
 * required (exactly one), every From:/Sender: address must use a configured
 * sender domain. Returns null when allowed, else the reason.
 */
export function headerSenderViolation(raw: Buffer, senderDomains: ReadonlySet<string>): string | null {
  const s = raw.toString('latin1');
  const fields = parseHeaderFields(s, 0, findBodyStart(s, 0, s.length));
  const named = (n: string): string[] => fields.filter((f) => f.name.toLowerCase() === n).map((f) => f.value);
  const froms = named('from');
  const senders = named('sender');
  if (froms.length !== 1) return froms.length === 0 ? 'From header missing' : 'multiple From header fields';
  if (senders.length > 1) return 'multiple Sender header fields';
  const addresses = [...addressesOf(froms[0] ?? ''), ...senders.flatMap((v) => addressesOf(v))];
  if (addresses.length === 0) return 'From contains no address';
  for (const a of addresses) {
    const d = addressDomain(a);
    if (!d || !senderDomains.has(d)) return `header sender <${a}> not permitted`;
  }
  return null;
}

// ── Policy loading (cached, fail closed) ──────────────────────────────────────

const POLICY_TTL_MS = 30_000;
let cached: { policy: DeviceRelayPolicy; expiresAt: number } | null = null;

/** Drops the cached policy (CHANNEL_SETTINGS_RELOAD after a BCP change). */
export function invalidateDeviceRelayCache(): void { cached = null; }

async function loadDeviceRelayPolicy(): Promise<DeviceRelayPolicy> {
  if (cached && cached.expiresAt > Date.now()) return cached.policy;
  try {
    const row = await prisma.deviceRelaySettings.findUnique({ where: { id: 'singleton' } });
    const policy = compileDeviceRelayPolicy(row);
    const { invalid, tooBroad } = policy.networks;
    if (invalid.length > 0 || tooBroad.length > 0) {
      log.warn({ invalid, tooBroad }, 'Device relay: invalid or too broad network entries ignored');
    }
    cached = { policy, expiresAt: Date.now() + POLICY_TTL_MS };
    return policy;
  } catch (err) {
    // Fail closed: without the configuration nobody may relay.
    log.error({ err }, 'Device relay settings not readable — relay disabled');
    return compileDeviceRelayPolicy(null);
  }
}

/** Fixed-window counter per source IP (Redis). Fails closed (→ 451, the device retries). */
async function takeRelaySlot(ip: string, limit: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `smtp:device-relay:rate:${ip}:${bucket}`;
  const redis = getRedisClient();
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 120);
  return count <= limit;
}

// ── Preparation + malware scan of a relayed message ───────────────────────────

const defaultHostname = (): string => process.env['SMTP_HOSTNAME']?.trim() || 'mail.localhost';

/**
 * Pure: the relayed message as it is scanned and delivered. A device is an
 * unauthenticated client: internal CoreMail headers and Authentication-Results
 * carrying our authserv-id are removed (like on port 25), a missing Date: /
 * Message-ID: is added (like a submission) and our Received: field is
 * prepended. Throws a 554 reply for a mail loop.
 */
export function prepareRelayedMessage(
  receivedRaw: Buffer,
  s: { ip: string; to: readonly string[]; hostname: string; meta?: MessageMeta },
): Buffer {
  const stripped = stripOwnAuthResults(stripHeaders(receivedRaw, INTERNAL_MAIL_HEADERS), s.hostname);
  if (countReceived(stripped) > MAX_RECEIVED_HOPS) throw new Error('554 5.4.6 Too many hops - mail loop detected');
  return prependHeader(completeSubmissionHeaders(stripped, s.hostname), buildReceivedHeader({
    ip: s.ip,
    meta: s.meta ?? { helo: '', protocol: 'ESMTP', hostname: s.hostname, sessionId: crypto.randomUUID().slice(0, 8).toUpperCase() },
    recipients: [...s.to],
  }));
}

/** What happens to a relayed message after the malware checks. */
export type RelayScanOutcome =
  | { kind: 'refuse'; reply: string }
  | { kind: 'deliver' | 'quarantine'; headers: string; virusName?: string };

/**
 * Pure: maps the /check/malware verdict. An unavailable filter defers (451) —
 * a relayed message is never delivered unscanned; `defer` is the configured
 * ClamAV failure policy. `headers` = X-CoreMail-Virus-Scan for a message that
 * was not scanned clean.
 */
export function relayScanOutcome(verdict: ContentFilterVerdict, hostname: string): RelayScanOutcome {
  if (verdict.kind === 'unavailable') {
    return { kind: 'refuse', reply: '451 4.7.1 Content filter temporarily unavailable, try again later' };
  }
  const r = verdict.result;
  if (r.action === 'reject') return { kind: 'refuse', reply: `550 5.7.1 ${r.reason ?? 'Message rejected'}` };
  if (r.action === 'defer') return { kind: 'refuse', reply: `451 4.7.1 ${r.reason ?? 'Temporary content filter failure'}` };
  const headers = r.virusScan ? virusScanHeaderLine(r.virusScan, hostname) : '';
  return {
    kind: r.action === 'quarantine' ? 'quarantine' : 'deliver',
    headers,
    ...(r.virusName ? { virusName: r.virusName } : {}),
  };
}

export interface RelayScanRequest {
  ip: string;
  from: string;
  to: string[];
  hostname: string;
  helo?: string;
}

/** POST /check/malware (attachment filter + ClamAV) of the security-filter. */
function scanRelayed(raw: Buffer, s: RelayScanRequest): Promise<ContentFilterVerdict> {
  return callContentFilter(SECURITY_FILTER_URL, '/check/malware', raw, asciiJson(filterContext({
    senderIp: s.ip, mailFrom: s.from, rcpts: s.to, hostname: s.hostname, ...(s.helo ? { helo: s.helo } : {}),
  })));
}

// ── Delivery of a relayed message ─────────────────────────────────────────────

export interface RelayDelivery {
  /** Prepared and scanned message, ready for delivery. */
  raw: Buffer;
  /** The message as received (delivery key: a retry is not delivered twice). */
  receivedRaw: Buffer;
  from: string;
  to: string[];
  ip: string;
  meta?: MessageMeta;
}

/** Local recipients → mailbox, external → outbound queue (like a submission). */
async function deliverRelayed(d: RelayDelivery, isLocal: (a: string) => Promise<boolean>): Promise<void> {
  const hostname = d.meta?.hostname ?? defaultHostname();
  const raw = d.raw;

  const local: string[] = [];
  const external: string[] = [];
  for (const rcpt of d.to) {
    if (!rcpt.includes('@') || await isLocal(rcpt)) local.push(rcpt);
    else external.push(rcpt);
  }
  const { targets, origins } = local.length > 0
    ? await expandRecipientsWithOrigins(local)
    : { targets: [] as string[], origins: new Map<string, string[]>() };

  const txKey = deliveryKey(d.from, d.receivedRaw);
  const dsn = d.meta?.envelope?.dsn;
  const { outcomes } = await deliverOnce(txKey, targets, external, {
    ledger: redisDeliveryLedger,
    storeLocal: async (rcpt) => {
      const result = await storeInboundMessage(raw, {
        fromAddr: d.from, rcptTo: rcpt, toJunk: false, deliveryKey: txKey,
        senderAuth: { authenticatedSender: d.from },
      });
      return toLocalOutcome(result);
    },
    enqueueExternal: async (rcpts) => {
      const jobDsn = dsnForRecipients(dsn, rcpts);
      await enqueueOutbound({
        messageId: crypto.randomUUID(),
        from: d.from,
        to: rcpts,
        rawMessage: raw.toString('base64'),
        ...(jobDsn ? { dsn: jobDsn } : {}),
      });
    },
  });
  await notifyLocalOutcomes({
    from: d.from, originals: local, origins, outcomes, dsn, hostname, deliveredRaw: raw, ndrRaw: raw,
  });

  void prisma.systemLog.create({
    data: {
      level: 'INFO',
      service: 'smtp-server',
      category: 'MAIL_FLOW',
      message: `Device relay: ${d.from} → ${d.to.join(', ')}`,
      metadata: {
        sender: d.from,
        recipient: d.to.join(', '),
        status: 'ACCEPTED',
        size: String(raw.length),
        localCount: String(local.length),
        externalCount: String(external.length),
        direction: 'OUTBOUND',
        relay: 'device',
        ip: d.ip,
      },
    },
  }).catch((err: unknown) => log.error({ err }, 'MAIL_FLOW log failed'));
  log.info({ from: d.from, ip: d.ip, local: local.length, external: external.length }, 'Device relay: message accepted');
}

// ── Handler wrapper ───────────────────────────────────────────────────────────

export interface DeviceRelayDeps {
  loadPolicy(): Promise<DeviceRelayPolicy>;
  isLocal(address: string): Promise<boolean>;
  takeSlot(ip: string, limit: number): Promise<boolean>;
  /** Malware checks (attachment filter + ClamAV) of the prepared message. */
  scan(raw: Buffer, s: RelayScanRequest): Promise<ContentFilterVerdict>;
  quarantine(input: QuarantineInput): Promise<unknown>;
  deliver(d: RelayDelivery): Promise<void>;
}

const defaultDeps: DeviceRelayDeps = {
  loadPolicy: loadDeviceRelayPolicy,
  isLocal: isLocalDomainAddress,
  takeSlot: takeRelaySlot,
  scan: scanRelayed,
  quarantine: (input) => quarantineMessage(input),
  deliver: (d) => deliverRelayed(d, isLocalDomainAddress),
};

export const RELAY_DENIED = '5.7.1 Relaying denied';
export const RELAY_SENDER_DENIED = '5.7.1 Relaying denied: sender domain not permitted for device relay';

const isLocalRecipient = async (to: string, deps: DeviceRelayDeps): Promise<boolean> =>
  to === BARE_POSTMASTER || !to.includes('@') || deps.isLocal(to);

/** How long a relay approval given at RCPT TO waits for its DATA. */
const APPROVAL_TTL_MS = 15 * 60_000;
const MAX_APPROVALS = 10_000;

/**
 * External recipients accepted for relay at RCPT TO (per client IP + sender +
 * recipient, counted for parallel sessions), consumed at DATA. Only a message
 * with such a recipient takes the relay path — every other message goes to the
 * wrapped handlers exactly as before, without extra lookups.
 */
export class RelayApprovals {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();
  private static key(ip: string, from: string, to: string): string {
    return `${ip}\n${from.toLowerCase()}\n${to.toLowerCase()}`;
  }
  add(ip: string, from: string, to: string, now = Date.now()): void {
    if (this.entries.size >= MAX_APPROVALS) this.prune(now);
    const k = RelayApprovals.key(ip, from, to);
    const e = this.entries.get(k);
    this.entries.set(k, { count: (e && e.expiresAt > now ? e.count : 0) + 1, expiresAt: now + APPROVAL_TTL_MS });
  }
  /** Consumes the approvals of one transaction; true when any recipient was approved. */
  take(ip: string, from: string, to: readonly string[], now = Date.now()): boolean {
    let any = false;
    for (const rcpt of new Set(to.map((t) => t.toLowerCase()))) {
      const k = RelayApprovals.key(ip, from, rcpt);
      const e = this.entries.get(k);
      if (!e) continue;
      if (e.expiresAt > now) any = true;
      if (e.count <= 1 || e.expiresAt <= now) this.entries.delete(k);
      else e.count -= 1;
    }
    return any;
  }
  private prune(now: number): void {
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
    // still full: drop the oldest — those transactions answer 550 at DATA, never relay unchecked
    for (const k of this.entries.keys()) {
      if (this.entries.size < MAX_APPROVALS) break;
      this.entries.delete(k);
    }
  }
}

/**
 * Wraps the inbound (port 25 type) handlers of one listener. Authenticated
 * sessions, local recipients and clients that are not configured devices keep
 * the wrapped behaviour unchanged.
 */
export function withDeviceRelay(base: SmtpHandlers, listenerPort: number, deps: DeviceRelayDeps = defaultDeps): SmtpHandlers {
  const approvals = new RelayApprovals();
  /** A configured device on this listener (cached policy, no other lookup). */
  const isDevice = (policy: DeviceRelayPolicy, ip: string): boolean =>
    policy.active && policy.port === listenerPort && policy.networks.contains(ip);

  async function onRcptTo(to: string, from: string, authUser: AuthUser | null, ip?: string): Promise<string | null> {
    if (authUser || !ip) return base.onRcptTo(to, from, authUser, ip);
    const policy = await deps.loadPolicy();
    if (!isDevice(policy, ip) || await isLocalRecipient(to, deps)) return base.onRcptTo(to, from, authUser, ip);
    if (relayDecision(policy, { listenerPort, ip, mailFrom: from }) !== 'allowed') {
      log.warn({ ip, from, to }, 'Device relay refused: sender domain not configured');
      return RELAY_SENDER_DENIED;
    }
    approvals.add(ip, from, to);
    return null;
  }

  /** Policy (re-checked: it may have changed since RCPT TO) + header sender. Throws the reply. */
  async function assertRelayAllowed(raw: Buffer, from: string, to: string[], ip: string): Promise<DeviceRelayPolicy> {
    const policy = await deps.loadPolicy();
    const decision = relayDecision(policy, { listenerPort, ip, mailFrom: from });
    if (decision !== 'allowed') {
      log.warn({ ip, from, to }, 'Device relay refused at DATA');
      throw new Error(`550 ${decision === 'sender-not-allowed' ? RELAY_SENDER_DENIED : RELAY_DENIED}`);
    }
    const violation = headerSenderViolation(raw, policy.senderDomains);
    if (violation) {
      log.warn({ ip, from, reason: violation }, 'Device relay refused: header sender');
      throw new Error(`550 5.7.1 Relaying denied: ${violation}`);
    }
    return policy;
  }

  /** Per-IP rate limit; an unavailable counter defers (fail closed). Throws the reply. */
  async function assertWithinRate(policy: DeviceRelayPolicy, from: string, ip: string): Promise<void> {
    let withinRate: boolean;
    try {
      withinRate = await deps.takeSlot(ip, policy.maxMessagesPerMinute);
    } catch (err) {
      log.error({ err, ip }, 'Device relay rate limiter unavailable — message deferred');
      throw new Error('451 4.3.0 Device relay temporarily unavailable, try again later');
    }
    if (!withinRate) {
      log.warn({ ip, from, limit: policy.maxMessagesPerMinute }, 'Device relay rate limit exceeded');
      throw new Error('451 4.7.1 Device relay rate limit exceeded, try again later');
    }
  }

  /** Prepares, scans and then quarantines or delivers the relayed message. */
  async function relay(receivedRaw: Buffer, from: string, to: string[], ip: string, meta?: MessageMeta): Promise<void> {
    const hostname = meta?.hostname ?? defaultHostname();
    const prepared = prepareRelayedMessage(receivedRaw, { ip, to, hostname, ...(meta ? { meta } : {}) });
    // The malware checks cannot inspect larger bodies — never relay unscanned.
    if (prepared.length > CONTENT_FILTER_MAX_BYTES) throw new Error('552 5.3.4 Message too big for content inspection');
    const outcome = relayScanOutcome(
      await deps.scan(prepared, { ip, from, to, hostname, ...(meta?.helo ? { helo: meta.helo } : {}) }),
      hostname,
    );
    if (outcome.kind === 'refuse') {
      log.warn({ ip, from, to, reply: outcome.reply }, 'Device relay refused by the malware checks');
      throw new Error(outcome.reply);
    }
    const raw = outcome.headers ? prependHeader(prepared, outcome.headers) : prepared;
    if (outcome.kind === 'quarantine') {
      await deps.quarantine({
        raw, from, recipients: to, reason: outcome.virusName ? 'VIRUS' : 'POLICY',
        details: { source: 'device-relay', ip, ...(outcome.virusName ? { virusName: outcome.virusName } : {}) },
      });
      log.warn({ ip, from, virusName: outcome.virusName }, 'Device relay: message quarantined');
      return;
    }
    await deps.deliver({ raw, receivedRaw, from, to, ip, ...(meta ? { meta } : {}) });
  }

  async function onMessage(raw: Buffer, from: string, to: string[], authUser: AuthUser | null, ip: string, meta?: MessageMeta): Promise<void> {
    if (authUser || !approvals.take(ip, from, to)) return base.onMessage(raw, from, to, authUser, ip, meta);
    const policy = await assertRelayAllowed(raw, from, to, ip);
    await assertWithinRate(policy, from, ip);
    await relay(raw, from, to, ip, meta);
  }

  return { onConnect: base.onConnect, onMailFrom: base.onMailFrom, onRcptTo, onMessage };
}
